/**
 * POST /api/test-cash {address} — testnet-only "Get test cash": mints test USDG ($500) and some test STRATEGY (≈ $250 at
 * the live QuotePricer price, skipped if it can't be priced) to a player's smart account.
 * The v5 test tokens (DevToken) have a public mint(address,uint256), so any funded EOA can mint; we use the existing
 * testnet faucet EOA (DRIP_FAUCET_KEY, same key /api/drip uses). No new env var. Unset key ⇒ 503 (button shows a plain note).
 * Only chain 46630: NEXT_PUBLIC_CHAIN_ID other than 46630 ⇒ 400, and the client never renders the button off testnet.
 * Rate limits (shared Upstash store, lib/server/kv; in-memory without KV env): once per hour per address (atomic SET NX),
 * 10/day per IP, 120/h globally.
 */
import { NextResponse } from "next/server";
import { createPublicClient, createWalletClient, http, isAddress, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEPLOYMENTS, robinhoodTestnet } from "@/lib/chains";
import { relayerIsFaucet, withRelayer } from "@/lib/server/relayer";
import { classifySendError } from "@/lib/server/relayerNonce";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { TEST_CASH_COOLDOWN_SEC, TEST_CASH_STRATEGY_USD, TEST_CASH_USD } from "@/lib/testCash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PER_IP_DAY = 10;
const GLOBAL_PER_HOUR = 120;
const DAY_SEC = 86_400;
const tokenAbi = parseAbi(["function mint(address to, uint256 amount)", "function decimals() view returns (uint8)"]);
const pricerAbi = parseAbi(["function quotePriceUsd(address) view returns (uint256)"]);
const WAD = BigInt(10) ** BigInt(18);
const Z = /^0x0{40}$/i;

export async function POST(req: Request) {
  if (Number(process.env.NEXT_PUBLIC_CHAIN_ID || 46630) !== 46630) return NextResponse.json({ ok: false, reason: "testnet only" }, { status: 400 });
  const key = process.env.DRIP_FAUCET_KEY as Hex | undefined;
  if (!key) { console.warn("[disciple] /api/test-cash: DRIP_FAUCET_KEY unset, test cash off"); return NextResponse.json({ ok: false, reason: "not configured" }, { status: 503 }); }
  let address: string;
  try { address = String((await req.json()).address || ""); } catch { address = ""; }
  if (!isAddress(address)) return NextResponse.json({ ok: false, reason: "bad address" }, { status: 400 });
  const a = address.toLowerCase();
  const d = DEPLOYMENTS[robinhoodTestnet.id];
  if (!d || Z.test(d.usdg)) return NextResponse.json({ ok: false, reason: "not configured" }, { status: 503 });

  // claim the address first (atomic: two taps can't both mint), then count the IP and the global window
  const k = `testcash:addr:${a}`;
  if (!(await kv().setNX(k, String(Date.now()), TEST_CASH_COOLDOWN_SEC))) {
    return NextResponse.json({ ok: false, reason: "rate limited", retryAfterSec: TEST_CASH_COOLDOWN_SEC }, { status: 429 });
  }
  const ip = clientIp(req.headers);
  const rl = await hitLimit(kv(), `testcash:ip:${ip}`, PER_IP_DAY, DAY_SEC);
  const gl = rl.ok ? await hitLimit(kv(), "testcash:global", GLOBAL_PER_HOUR, 3600) : rl;
  if (!rl.ok || !gl.ok) { await kv().del(k); return NextResponse.json({ ok: false, reason: "rate limited", retryAfterSec: (rl.ok ? gl : rl).retryAfterSec }, { status: 429 }); }

  const pc = createPublicClient({ chain: robinhoodTestnet, transport: http() });
  const mints: { token: Address; amount: bigint; usd: number }[] = [];
  try {
    const usdgDec = await pc.readContract({ address: d.usdg, abi: tokenAbi, functionName: "decimals" }).catch(() => d.usdgDecimals);
    mints.push({ token: d.usdg, amount: parseUnits(String(TEST_CASH_USD), Number(usdgDec)), usd: TEST_CASH_USD });
    // STRATEGY (the pair token creator buys are paid in): only if it prices; raw = usd × 1e18 / (USD WAD per 1e18 raw)
    if (!Z.test(d.defaultQuote) && !Z.test(d.quotePricer)) {
      const px = await pc.readContract({ address: d.quotePricer, abi: pricerAbi, functionName: "quotePriceUsd", args: [d.defaultQuote] }).catch(() => BigInt(0));
      if (px > BigInt(0)) mints.push({ token: d.defaultQuote, amount: (BigInt(TEST_CASH_STRATEGY_USD) * WAD * WAD) / px, usd: TEST_CASH_STRATEGY_USD });
    }
  } catch (e) {
    await kv().del(k).catch(() => undefined);
    return NextResponse.json({ ok: false, reason: (e as Error).message.split("\n")[0].slice(0, 120) }, { status: 500 });
  }

  const wc = createWalletClient({ chain: robinhoodTestnet, transport: http(undefined, { retryCount: 0 }), account: privateKeyToAccount(key) });
  const hashes: Hex[] = [];
  let usd = 0;
  for (const m of mints) {
    const send = (nonce?: number) => wc.writeContract({ address: m.token, abi: tokenAbi, functionName: "mint", args: [address as Address, m.amount], ...(nonce === undefined ? {} : { nonce }) });
    try {
      // same EOA as the self-bundler relayer (non-production fallback) ⇒ share its nonce cursor; else serialized send
      const h = relayerIsFaucet()
        ? await withRelayer(async () => (await import("@/lib/server/fastRelay")).sendWithRelayerNonce(send), 0)
        : await withRelayer(() => send());
      hashes.push(h); usd += m.usd;
    } catch (e) {
      if (hashes.length) break;   // USDG landed, STRATEGY failed: still a success (cash is what matters)
      // a definite rejection (nothing sent) frees the claim for an immediate retry; an unclear one keeps it
      if (classifySendError(e) !== "unclear") await kv().del(k).catch(() => undefined);
      return NextResponse.json({ ok: false, reason: (e as Error).message.split("\n")[0].slice(0, 120) }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true, txHashes: hashes, usd });
}
