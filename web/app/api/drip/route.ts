/**
 * POST /api/drip {address} — test-ETH top-up for an embedded smart account (self-paid gas on testnet).
 * Only chain 46630. Two cases:
 *  - new (undeployed) account: one-time drip up to DRIP_AMOUNT (skips if balance >= DRIP_AMOUNT), once per 30 days;
 *  - deployed account (refill, AA21 fix): every op must PREFUND gas × maxFee (~0.00011 ETH for a trade at the static
 *    limits and the client's 2x fee headroom) from balance + EntryPoint deposit, while it only SPENDS ~0.0000085 ETH.
 *    The one-time 0.001 ETH ran dry after ~100 trades and every op then failed "AA21 didn't pay prefund" with no
 *    way to top up. Refill to DRIP_AMOUNT when balance + deposit < DRIP_LOW_WATER_ETH, at most once per
 *    DRIP_REFILL_COOLDOWN_SEC per address.
 * Rate-limited per address (above), per IP (5/day) and
 * globally (DRIP_GLOBAL_PER_HOUR, default 200/h) in
 * the shared Upstash store (lib/server/kv + limits; in-memory only without KV env), plus the on-chain balance check.
 * Signer: server-only env DRIP_FAUCET_KEY (dedicated faucet EOA; the self-bundler relays from RELAYER_PRIVATE_KEY).
 */
import { NextResponse } from "next/server";
import { createPublicClient, createWalletClient, http, isAddress, parseAbi, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodTestnet } from "@/lib/chains";
import { ENTRYPOINT_V07 } from "@/lib/aa/constants";
import { relayerIsFaucet, withRelayer } from "@/lib/server/relayer";
import { classifySendError } from "@/lib/server/relayerNonce";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AMOUNT = parseEther(process.env.DRIP_AMOUNT_ETH || "0.001");
const PER_IP_DAY = 5;
/** Global cap across all addresses/IPs (fresh addresses are free to make): bounds faucet spend to GLOBAL_PER_HOUR × AMOUNT/h. */
const GLOBAL_PER_HOUR = Number(process.env.DRIP_GLOBAL_PER_HOUR || 200);
const DAY_SEC = 86_400;
const ADDR_TTL_SEC = 30 * DAY_SEC;
const addrKey = (a: string) => `drip:addr:${a}`;
/** Refill a deployed account below this (balance + EntryPoint deposit): ~3 trade prefunds at the static limits. */
const LOW_WATER = parseEther(process.env.DRIP_LOW_WATER_ETH || "0.0003");
const REFILL_COOLDOWN_SEC = Number(process.env.DRIP_REFILL_COOLDOWN_SEC || 6 * 3600);
const refillKey = (a: string) => `drip:refill:${a}`;
const depositAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export async function POST(req: Request) {
  const key = process.env.DRIP_FAUCET_KEY as Hex | undefined;
  if (!key) return NextResponse.json({ ok: false, reason: "drip not configured" }, { status: 503 });
  if (Number(process.env.NEXT_PUBLIC_CHAIN_ID || 46630) !== 46630) return NextResponse.json({ ok: false, reason: "testnet only" }, { status: 400 });
  let address: string;
  try { address = String((await req.json()).address || ""); } catch { address = ""; }
  if (!isAddress(address)) return NextResponse.json({ ok: false, reason: "bad address" }, { status: 400 });
  const a = address.toLowerCase();
  const ip = clientIp(req.headers);

  const pc = createPublicClient({ chain: robinhoodTestnet, transport: http() });
  const [bal, code, dep] = await Promise.all([
    pc.getBalance({ address: address as Hex }),
    pc.getCode({ address: address as Hex }),
    pc.readContract({ address: ENTRYPOINT_V07, abi: depositAbi, functionName: "balanceOf", args: [address as Hex] }).catch(() => BigInt(0)),
  ]);
  const deployed = !!code && code !== "0x";
  const funds = bal + (deployed ? dep : BigInt(0));
  if (deployed ? funds >= LOW_WATER : bal >= AMOUNT) return NextResponse.json({ ok: true, skipped: true, reason: "balance ok" });
  // new accounts: once per 30 days; deployed accounts below the low-water mark: once per REFILL_COOLDOWN_SEC
  const k = deployed ? refillKey(a) : addrKey(a), ttl = deployed ? REFILL_COOLDOWN_SEC : ADDR_TTL_SEC;
  // claim the address first (atomic SET NX: concurrent requests for one address can't both drip), then count the IP
  if (!(await kv().setNX(k, String(Date.now()), ttl))) return NextResponse.json({ ok: false, reason: "already dripped" }, { status: 429 });
  const rl = await hitLimit(kv(), `drip:ip:${ip}`, PER_IP_DAY, DAY_SEC);
  const gl = rl.ok ? await hitLimit(kv(), "drip:global", GLOBAL_PER_HOUR, 3600) : rl;
  if (!rl.ok || !gl.ok) { await kv().del(k); return NextResponse.json({ ok: false, reason: "rate limited" }, { status: 429, headers: { "retry-after": String((rl.ok ? gl : rl).retryAfterSec) } }); }
  try {
    const wc = createWalletClient({ chain: robinhoodTestnet, transport: http(undefined, { retryCount: 0 }), account: privateKeyToAccount(key) });   // no transport-level resend (AUDIT Info)
    const send = (nonce?: number) => wc.sendTransaction({ to: address as Hex, value: AMOUNT > funds ? AMOUNT - funds : AMOUNT, ...(nonce === undefined ? {} : { nonce }) });
    // same EOA as the self-bundler relayer (RELAYER_PRIVATE_KEY unset, non-production only) ⇒ share its nonce cursor; else plain serialized send
    const hash = relayerIsFaucet()
      ? await withRelayer(async () => (await import("@/lib/server/fastRelay")).sendWithRelayerNonce(send), 0)   // the cursor already retries nonce errors
      : await withRelayer(() => send());
    return NextResponse.json({ ok: true, txHash: hash, refill: deployed });
  } catch (e) {
    // AUDIT Info: a timeout / unclear error may have landed ⇒ KEEP the claim (a re-request re-claims after the TTL
    // instead of re-sending now); only a definite rejection (nothing was sent) frees it for an immediate retry.
    const unclear = classifySendError(e) === "unclear";
    if (!unclear) await kv().del(k).catch(() => undefined);
    return NextResponse.json({ ok: false, pending: unclear || undefined, reason: (e as Error).message.split("\n")[0].slice(0, 120) }, { status: unclear ? 202 : 500 });
  }
}
