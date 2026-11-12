/**
 * POST /api/pve/attest Authorization: Bearer <Privy access token> {wallet}
 * Returns a global LoginAttestation{wallet,expiry,epoch} signature for a login-verified, owned wallet.
 * No coin scope, sponsorship or relay: the user submits the attestation and pays gas.
 * Fails closed on missing Privy/attester configuration or on-chain attester mismatch.
 * Shared rate limits: 30/10 min per IP, 20/h per Privy user.
 */
import { NextResponse } from "next/server";
import { createPublicClient, http, isAddress, parseAbi, type Address } from "viem";
import { deployment, ACTIVE_CHAIN } from "@/lib/chains";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { LIGHT_ACCOUNT_V2_FACTORY, MAV2_FACTORY } from "@/lib/aa/constants";
import { inviteRequiredResponse, requireInviteUser } from "@/lib/server/inviteGate";
import {
  AuthError, ZERO_ADDR, attestTtl, attesterAccount, fetchPrivyUser, isLoginVerified, loginGateMiniAbi, privyJwksFetcher,
  signLoginAttestation, verifyPrivyAccessToken, walletBelongsTo,
} from "@/lib/pveAttest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const LIMITS = { ip: { limit: 30, windowSec: 600 }, user: { limit: 20, windowSec: 3600 } } as const;
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

  let body: unknown;
  try { body = await req.json(); } catch { return err(400, "bad_wallet"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return err(400, "bad_wallet");
  if ("coin" in body) return err(400, "coin_scope_removed");
  if ("relay" in body) return err(400, "relay_removed");
  const wallet = "wallet" in body ? String(body.wallet || "") : "";
  if (!isAddress(wallet)) return err(400, "bad_wallet");

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
    const epoch = Number(await client.readContract({ address: gate, abi: loginGateMiniAbi, functionName: "epoch", args: [w] }));
    const signature = await signLoginAttestation(account, { wallet: w, expiry, epoch, chainId: ACTIVE_CHAIN.id, loginGate: gate });
    const out = { wallet: w, expiry, epoch, signature, loginGate: gate, chainId: ACTIVE_CHAIN.id, attester: account.address };
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
