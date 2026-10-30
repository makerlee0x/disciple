/**
 * POST /api/pve/attest   Authorization: Bearer <Privy access token>   {wallet, coin?, relay?}
 *   → { wallet, expiry, coin, signature, loginGate, chainId, attester, txHash?, verifiedUntil? }
 *
 * Signs a LoginGate 'DisciplePVE' v1 LoginAttestation{wallet, expiry, coin} (lib/pveAttest) for a LOGIN-VERIFIED Privy
 * user (email / Google / X linked) whose `wallet` is theirs (linked wallet, or the MAv2/LightAccount smart account it
 * owns). coin defaults to address(0) = every PVE coin. The contract has no nonce; expiry ≤ 24h (MAX_TTL).
 * relay=true: the relayer EOA submits LoginGate.attest itself (permissionless) so session-key batches, which the
 * session policy won't let call LoginGate, still work; skipped when the wallet is already verified for > 1h.
 * Fails CLOSED: 503 when PVE_ATTESTER_PRIVATE_KEY / Privy config is missing, or the on-chain attester isn't this key.
 * Rate limits (shared KV): 30/10 min per IP, 20/h per Privy user, relay 6/day per wallet.
 */
import { NextResponse } from "next/server";
import { createPublicClient, createWalletClient, http, isAddress, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deployment, robinhoodTestnet, ACTIVE_CHAIN } from "@/lib/chains";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { relayerKey, isRelayerNotConfigured, withRelayer } from "@/lib/server/relayer";
import { LIGHT_ACCOUNT_V2_FACTORY, MAV2_FACTORY } from "@/lib/aa/constants";
import { inviteRequiredResponse, requireInviteUser } from "@/lib/server/inviteGate";
import {
  AuthError, ZERO_ADDR, attestTtl, attesterAccount, fetchPrivyUser, isLoginVerified, loginGateMiniAbi, privyJwksFetcher,
  signLoginAttestation, verifyPrivyAccessToken, walletBelongsTo,
} from "@/lib/pveAttest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const LIMITS = { ip: { limit: 30, windowSec: 600 }, user: { limit: 20, windowSec: 3600 }, relayWallet: { limit: 6, windowSec: 86_400 } } as const;
const appId = () => (process.env.VERCEL_ENV === "preview" && process.env.NEXT_PUBLIC_PRIVY_APP_ID_PREVIEW) || process.env.NEXT_PUBLIC_PRIVY_APP_ID || "";
const appSecret = () => (process.env.VERCEL_ENV === "preview" && process.env.NEXT_PUBLIC_PRIVY_APP_ID_PREVIEW && process.env.PRIVY_APP_SECRET_PREVIEW) || process.env.PRIVY_APP_SECRET || "";
const factoryAbi = parseAbi(["function getAddressSemiModular(address owner, uint256 salt) view returns (address)", "function getAddress(address owner, uint256 salt) view returns (address)"]);

let jwks: { id: string; get: ReturnType<typeof privyJwksFetcher> } | null = null;
let onchainAttester: { v: string; at: number } | null = null;
const pc = () => createPublicClient({ chain: ACTIVE_CHAIN, transport: http() });
const err = (status: number, error: string, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status });

export async function POST(req: Request) {
  const account = attesterAccount();
  const gate = deployment().loginGate;
  if (!account) return err(503, "pve_attester_not_configured");
  if (!gate || gate === ZERO_ADDR) return err(503, "login_gate_not_deployed");
  const id = appId(), secret = appSecret();
  if (!id || !secret) return err(503, "privy_not_configured");

  const ip = clientIp(req.headers);
  const rl = await hitLimit(kv(), `pve:ip:${ip}`, LIMITS.ip.limit, LIMITS.ip.windowSec);
  if (!rl.ok) return err(429, "rate_limited", { retryAfterSec: rl.retryAfterSec });

  let body: { wallet?: string; coin?: string; relay?: boolean };
  try { body = await req.json(); } catch { body = {}; }
  const wallet = String(body.wallet || ""), coinIn = body.coin ? String(body.coin) : ZERO_ADDR;
  if (!isAddress(wallet)) return err(400, "bad_wallet");
  if (!isAddress(coinIn)) return err(400, "bad_coin");
  const coin = coinIn as Address;

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return err(401, "missing_token");
  try {
    if (!jwks || jwks.id !== id) jwks = { id, get: privyJwksFetcher(id) };
    const claims = await verifyPrivyAccessToken(token, id, jwks.get);
    const ul = await hitLimit(kv(), `pve:user:${claims.userId}`, LIMITS.user.limit, LIMITS.user.windowSec);
    if (!ul.ok) return err(429, "rate_limited", { retryAfterSec: ul.retryAfterSec });
    const user = await fetchPrivyUser(claims.userId, id, secret);
    if (!isLoginVerified(user)) return err(403, "login_not_verified");
    // invite-only beta (lib/server/invites); off by default ⇒ no-op
    if (!(await requireInviteUser(claims.userId, "pve/attest")).ok) return inviteRequiredResponse();
    const client = pc();
    const owns = await walletBelongsTo(user, wallet, (owner) => Promise.all([
      client.readContract({ address: MAV2_FACTORY, abi: factoryAbi, functionName: "getAddressSemiModular", args: [owner, BigInt(0)] }).catch(() => null),
      client.readContract({ address: LIGHT_ACCOUNT_V2_FACTORY, abi: factoryAbi, functionName: "getAddress", args: [owner, BigInt(0)] }).catch(() => null),
    ]));
    if (!owns) return err(403, "wallet_not_owned");

    // The signature is useless unless LoginGate.attester() is this key (owner must call setAttester): fail closed + say so.
    if (!onchainAttester || Date.now() - onchainAttester.at > 60_000) {
      onchainAttester = { v: String(await client.readContract({ address: gate, abi: loginGateMiniAbi, functionName: "attester" })).toLowerCase(), at: Date.now() };
    }
    if (onchainAttester.v !== account.address.toLowerCase()) return err(503, "attester_not_registered", { expectedAttester: account.address });

    const w = wallet as Address;
    const now = Math.floor(Date.now() / 1000);
    const expiry = now + attestTtl();
    const signature = await signLoginAttestation(account, { wallet: w, expiry, coin, chainId: ACTIVE_CHAIN.id, loginGate: gate });
    const out: Record<string, unknown> = { wallet: w, expiry, coin, signature, loginGate: gate, chainId: ACTIVE_CHAIN.id, attester: account.address };

    if (body.relay) {
      const until = Number(await client.readContract({ address: gate, abi: loginGateMiniAbi, functionName: "verifiedUntil", args: [w, coin] }));
      if (until > now + 3600) return NextResponse.json({ ...out, verifiedUntil: until, relayed: false, already: true });
      const wl = await hitLimit(kv(), `pve:relay:${w.toLowerCase()}`, LIMITS.relayWallet.limit, LIMITS.relayWallet.windowSec);
      if (!wl.ok) return NextResponse.json({ ...out, relayed: false, relayError: "rate_limited" });
      try {
        const relayer = privateKeyToAccount(relayerKey());
        const wc = createWalletClient({ chain: ACTIVE_CHAIN.id === 46630 ? robinhoodTestnet : ACTIVE_CHAIN, transport: http(undefined, { retryCount: 0 }), account: relayer });   // no transport-level resend (AUDIT Info)
        // shared relayer nonce allocator (same EOA as the relay paths; see lib/server/fastRelay.sendWithRelayerNonce)
        const hash = await withRelayer(async () => (await import("@/lib/server/fastRelay")).sendWithRelayerNonce((nonce) => wc.writeContract({ address: gate, abi: loginGateMiniAbi, functionName: "attest", args: [w, BigInt(expiry), coin, signature as Hex], nonce })), 0);
        const rc = await client.waitForTransactionReceipt({ hash, timeout: 20_000 });
        if (rc.status !== "success") return NextResponse.json({ ...out, relayed: false, relayError: "reverted", txHash: hash });
        return NextResponse.json({ ...out, relayed: true, txHash: hash, verifiedUntil: expiry });
      } catch (e) {
        // Relay is best-effort: the client can still submit `signature` itself (owner-signed batch).
        return NextResponse.json({ ...out, relayed: false, relayError: isRelayerNotConfigured(e) ? "relayer_not_configured" : "relay_failed" });
      }
    }
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof AuthError) {
      const status = e.code === "privy_unavailable" || e.code === "jwks_unavailable" || e.code === "privy_not_configured" ? 503 : 401;
      return err(status, e.code);
    }
    console.error("[pve/attest]", (e as Error).message);
    return err(500, "attest_failed");
  }
}
