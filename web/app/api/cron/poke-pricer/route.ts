/**
 * GET /api/cron/poke-pricer — Vercel cron (vercel.json, every minute; Pro plan). QuotePricer.poke(base) for every active
 * base (lib/pricerKeeper) from the relayer EOA (RELAYER_PRIVATE_KEY, lib/server/relayer: prod fails closed).
 * Auth: Bearer CRON_SECRET, constant-time; in production an unset CRON_SECRET ⇒ 503 (never an open endpoint).
 * Launch scan: Launched logs from the KV cursor `pricer:cur:<launchpad>` (starts at the stack's fromBlock), bases kept in
 * `pricer:bases:<launchpad>`. Each base is simulated first (estimateGas) so a reverting poke costs nothing; a poke that
 * records nothing new (same block) is still cheap. Run lock `pricer:lock` (50 s) so overlapping crons don't race nonces.
 * Response includes the relayer address + balance (public) so low funds are visible in the cron logs.
 */
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { createPublicClient, createWalletClient, formatEther, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ACTIVE_CHAIN, deployment, ZERO } from "@/lib/chains";
import { launchpadAbi, quotePricerAbi } from "@/lib/abi";
import { kv } from "@/lib/server/kv";
import { relayerKey, isRelayerNotConfigured, withRelayer } from "@/lib/server/relayer";
import { activeBases } from "@/lib/pricerKeeper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const isProd = () => process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
const same = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const SCAN_CHUNK = BigInt(50_000);
/** Warn in the response below this relayer balance (≈ several days of pokes at testnet gas prices). */
const LOW_BALANCE = BigInt(2e15);

export async function GET(req: Request) {
  const s = process.env.CRON_SECRET;
  if (!s && isProd()) return NextResponse.json({ error: "cron_not_configured" }, { status: 503 });
  if (s && !same(req.headers.get("authorization") || "", `Bearer ${s}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (process.env.PRICER_KEEPER_DISABLED === "1") return NextResponse.json({ ok: true, skipped: "disabled" });
  const d = deployment();
  if (d.quotePricer === ZERO || d.launchpad === ZERO) return NextResponse.json({ ok: true, skipped: "not deployed" });
  let key: `0x${string}`;
  try { key = relayerKey(); } catch (e) { return NextResponse.json({ error: isRelayerNotConfigured(e) ? "relayer_not_configured" : "relayer_error" }, { status: 503 }); }

  const store = kv(), lp = d.launchpad.toLowerCase();
  if (!(await store.setNX("pricer:lock", "1", 50))) return NextResponse.json({ ok: true, skipped: "locked" });
  try {
    const pc = createPublicClient({ chain: ACTIVE_CHAIN, transport: http() });
    const relayer = privateKeyToAccount(key);
    const wc = createWalletClient({ chain: ACTIVE_CHAIN, transport: http(), account: relayer });

    // 1) new bases from launches since the cursor
    const latest = await pc.getBlockNumber();
    const curKey = `pricer:cur:${lp}`, basesKey = `pricer:bases:${lp}`;
    let cur = BigInt((await store.get(curKey)) ?? (d.fromBlock - BigInt(1)).toString());
    const seen = new Set((await store.smembers(basesKey)).map((x) => x.toLowerCase()));
    const fresh: string[] = [];
    while (cur < latest) {
      const to = cur + SCAN_CHUNK > latest ? latest : cur + SCAN_CHUNK;
      const logs = await pc.getContractEvents({ address: d.launchpad, abi: launchpadAbi, eventName: "Launched", fromBlock: cur + BigInt(1), toBlock: to });
      for (const l of logs) { const q = String((l.args as { quote?: string }).quote ?? "").toLowerCase(); if (q && !seen.has(q)) { seen.add(q); fresh.push(q); } }
      cur = to;
    }
    if (fresh.length) await store.sadd(basesKey, ...fresh);
    await store.set(curKey, cur.toString());
    const defaultQuote = await pc.readContract({ address: d.launchpad, abi: launchpadAbi, functionName: "defaultQuote" }).catch(() => d.defaultQuote);
    const extra = (process.env.PRICER_EXTRA_BASES || "").split(",").map((x) => x.trim()).filter(Boolean);
    const bases = activeBases({ defaultQuote, usdg: d.usdg, launchedQuotes: Array.from(seen), extra });

    // 2) poke each base (simulate → send); new bases first so their 1h warm-up starts on the first run
    const order = [...bases.filter((b) => fresh.includes(b)), ...bases.filter((b) => !fresh.includes(b))];
    const results: Record<string, string> = {};
    let gasUsed = BigInt(0);
    for (const base of order) {
      try {
        const { request } = await pc.simulateContract({ account: relayer, address: d.quotePricer, abi: quotePricerAbi, functionName: "poke", args: [base as Address] });
        const hash = await withRelayer(() => wc.writeContract(request));
        const rc = await pc.waitForTransactionReceipt({ hash, timeout: 15_000 });
        gasUsed += rc.gasUsed;
        results[base] = rc.status === "success" ? hash : `reverted ${hash}`;
      } catch (e) {
        results[base] = `error: ${String((e as { shortMessage?: string }).shortMessage || (e as Error).message).slice(0, 160)}`;
      }
    }
    const bal = await pc.getBalance({ address: relayer.address }).catch(() => BigInt(0));
    return NextResponse.json({
      ok: true, bases: order, newBases: fresh, results, gasUsed: gasUsed.toString(),
      relayer: relayer.address, relayerBalanceEth: formatEther(bal), lowBalance: bal < LOW_BALANCE,
    });
  } finally {
    await store.del("pricer:lock").catch(() => {});
  }
}
