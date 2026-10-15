/**
 * POST /api/drip {address} — one-time test-ETH top-up for a new embedded smart account (self-paid gas on testnet).
 * Only chain 46630. Skips if balance >= DRIP_AMOUNT. Rate-limited per address (once) and per IP (5/day), in-memory
 * per serverless instance plus the on-chain balance check. Signer: server-only env DRIP_FAUCET_KEY (dedicated faucet EOA).
 */
import { NextResponse } from "next/server";
import { createPublicClient, createWalletClient, http, isAddress, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodTestnet } from "@/lib/chains";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AMOUNT = parseEther(process.env.DRIP_AMOUNT_ETH || "0.001");
const PER_IP_DAY = 5;
const seenAddr = new Map<string, number>();
const seenIp = new Map<string, number[]>();
const DAY = 86_400_000;

export async function POST(req: Request) {
  const key = process.env.DRIP_FAUCET_KEY as Hex | undefined;
  if (!key) return NextResponse.json({ ok: false, reason: "drip not configured" }, { status: 503 });
  if (Number(process.env.NEXT_PUBLIC_CHAIN_ID || 46630) !== 46630) return NextResponse.json({ ok: false, reason: "testnet only" }, { status: 400 });
  let address: string;
  try { address = String((await req.json()).address || ""); } catch { address = ""; }
  if (!isAddress(address)) return NextResponse.json({ ok: false, reason: "bad address" }, { status: 400 });
  const a = address.toLowerCase();
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const now = Date.now();
  if (seenAddr.has(a)) return NextResponse.json({ ok: false, reason: "already dripped" }, { status: 429 });
  const hits = (seenIp.get(ip) || []).filter((t) => now - t < DAY);
  if (hits.length >= PER_IP_DAY) return NextResponse.json({ ok: false, reason: "rate limited" }, { status: 429 });

  const pc = createPublicClient({ chain: robinhoodTestnet, transport: http() });
  const [bal, code] = await Promise.all([pc.getBalance({ address: address as Hex }), pc.getCode({ address: address as Hex })]);
  if (bal >= AMOUNT) return NextResponse.json({ ok: true, skipped: true, reason: "balance ok" });
  // once per account: a deployed smart account has already been funded and used
  if (code && code !== "0x") return NextResponse.json({ ok: true, skipped: true, reason: "account already active" });
  seenAddr.set(a, now); hits.push(now); seenIp.set(ip, hits);
  try {
    const wc = createWalletClient({ chain: robinhoodTestnet, transport: http(), account: privateKeyToAccount(key) });
    const hash = await wc.sendTransaction({ to: address as Hex, value: AMOUNT - bal });
    return NextResponse.json({ ok: true, txHash: hash });
  } catch (e) {
    seenAddr.delete(a);
    return NextResponse.json({ ok: false, reason: (e as Error).message.split("\n")[0].slice(0, 120) }, { status: 500 });
  }
}
