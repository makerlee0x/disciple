/**
 * POST /api/drip {address} — one-time test-ETH top-up for a new embedded smart account (self-paid gas on testnet).
 * Only chain 46630. Skips if balance >= DRIP_AMOUNT. Rate-limited per address (once per 30 days), per IP (5/day) and
 * globally (DRIP_GLOBAL_PER_HOUR, default 200/h) in
 * the shared Upstash store (lib/server/kv + limits; in-memory only without KV env), plus the on-chain balance check.
 * Signer: server-only env DRIP_FAUCET_KEY (dedicated faucet EOA; the self-bundler relays from RELAYER_PRIVATE_KEY).
 */
import { NextResponse } from "next/server";
import { createPublicClient, createWalletClient, http, isAddress, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodTestnet } from "@/lib/chains";
import { relayerIsFaucet, withRelayer } from "@/lib/server/relayer";
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

export async function POST(req: Request) {
  const key = process.env.DRIP_FAUCET_KEY as Hex | undefined;
  if (!key) return NextResponse.json({ ok: false, reason: "drip not configured" }, { status: 503 });
  if (Number(process.env.NEXT_PUBLIC_CHAIN_ID || 46630) !== 46630) return NextResponse.json({ ok: false, reason: "testnet only" }, { status: 400 });
  let address: string;
  try { address = String((await req.json()).address || ""); } catch { address = ""; }
  if (!isAddress(address)) return NextResponse.json({ ok: false, reason: "bad address" }, { status: 400 });
  const a = address.toLowerCase();
  const ip = clientIp(req.headers);
  if (await kv().get(addrKey(a))) return NextResponse.json({ ok: false, reason: "already dripped" }, { status: 429 });

  const pc = createPublicClient({ chain: robinhoodTestnet, transport: http() });
  const [bal, code] = await Promise.all([pc.getBalance({ address: address as Hex }), pc.getCode({ address: address as Hex })]);
  if (bal >= AMOUNT) return NextResponse.json({ ok: true, skipped: true, reason: "balance ok" });
  // once per account: a deployed smart account has already been funded and used
  if (code && code !== "0x") return NextResponse.json({ ok: true, skipped: true, reason: "account already active" });
  // claim the address first (atomic SET NX: concurrent requests for one address can't both drip), then count the IP
  if (!(await kv().setNX(addrKey(a), String(Date.now()), ADDR_TTL_SEC))) return NextResponse.json({ ok: false, reason: "already dripped" }, { status: 429 });
  const rl = await hitLimit(kv(), `drip:ip:${ip}`, PER_IP_DAY, DAY_SEC);
  const gl = rl.ok ? await hitLimit(kv(), "drip:global", GLOBAL_PER_HOUR, 3600) : rl;
  if (!rl.ok || !gl.ok) { await kv().del(addrKey(a)); return NextResponse.json({ ok: false, reason: "rate limited" }, { status: 429, headers: { "retry-after": String((rl.ok ? gl : rl).retryAfterSec) } }); }
  try {
    const wc = createWalletClient({ chain: robinhoodTestnet, transport: http(), account: privateKeyToAccount(key) });
    const send = (nonce?: number) => wc.sendTransaction({ to: address as Hex, value: AMOUNT - bal, ...(nonce === undefined ? {} : { nonce }) });
    // same EOA as the self-bundler relayer (RELAYER_PRIVATE_KEY unset) ⇒ share its nonce cursor; else plain serialized send
    const hash = relayerIsFaucet()
      ? await withRelayer(async () => (await import("@/lib/server/fastRelay")).sendWithRelayerNonce(send))
      : await withRelayer(() => send());
    return NextResponse.json({ ok: true, txHash: hash });
  } catch (e) {
    await kv().del(addrKey(a)).catch(() => undefined);
    return NextResponse.json({ ok: false, reason: (e as Error).message.split("\n")[0].slice(0, 120) }, { status: 500 });
  }
}
