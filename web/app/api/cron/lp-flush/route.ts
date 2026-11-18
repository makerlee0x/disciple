/**
 * GET /api/cron/lp-flush — Vercel cron (vercel.json, every minute: keeps LockedLP flush-reference anchors fresh, audit round 5). Slim hook (2026-11-17): swaps only bucket the 33% LP
 * share in LockedLP; this keeper adds the buckets to each coin's locked position with LockedLP.flush(token). flush is
 * open to anyone (maker 2026-11-17); this cron just makes sure it runs. LockedLP caps each add (one per block, a slice
 * of L per window), so a call that has nothing to add returns 0.
 * Coins: LockedLP V4PositionSeeded logs from the KV cursor `lpflush:cur:<lockedLP>`, kept in `lpflush:pools:<lockedLP>`
 * ("poolId|token"). Each flush is simulated first (0 liquidity ⇒ nothing sent). Bounded per run (jobs, gas, time) and
 * rotated. Auth: Bearer CRON_SECRET (constant-time; unset in production ⇒ 503). LP_FLUSH_KEEPER_DISABLED=1 turns it off.
 */
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { createPublicClient, createWalletClient, http, parseAbi, toFunctionSelector, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ACTIVE_CHAIN, deployment, ZERO } from "@/lib/chains";
import { kv } from "@/lib/server/kv";
import { relayerKey, isRelayerNotConfigured, withRelayer } from "@/lib/server/relayer";
import { lockedLPAbi } from "@/lib/abi";
import { codeHasSelector, gasLimitFor } from "@/lib/feeRouteKeeper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FLUSH_ABI = parseAbi([
  "function flush(address token) returns (uint128 liquidity)",
  "function compoundBucket(address token) view returns (uint256 tokenAmount, uint256 quoteAmount)",
]);
const LIMITS = { MAX_JOBS: 20, GAS_PER_TX: BigInt(600_000), GAS_PER_RUN: BigInt(8_000_000), DEADLINE_MS: 40_000 };
const SCAN_CHUNK = BigInt(50_000);
const isProd = () => process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
const same = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const errText = (e: unknown) => String((e as { shortMessage?: string }).shortMessage || (e as Error).message || e);

export async function GET(req: Request) {
  const s = process.env.CRON_SECRET;
  if (!s && isProd()) return NextResponse.json({ error: "cron_not_configured" }, { status: 503 });
  if (s && !same(req.headers.get("authorization") || "", `Bearer ${s}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (process.env.LP_FLUSH_KEEPER_DISABLED === "1") return NextResponse.json({ ok: true, skipped: "disabled" });
  const d = deployment();
  if (d.lockedLP === ZERO) return NextResponse.json({ ok: true, skipped: "not deployed" });
  let key: Hex;
  try { key = relayerKey(); } catch (e) { return NextResponse.json({ error: isRelayerNotConfigured(e) ? "relayer_not_configured" : "relayer_error" }, { status: 503 }); }

  const store = kv(), lp = d.lockedLP.toLowerCase();
  if (!(await store.setNX("lpflush:lock", "1", 55))) return NextResponse.json({ ok: true, skipped: "locked" });
  try {
    const pc = createPublicClient({ chain: ACTIVE_CHAIN, transport: http() }) as PublicClient;
    const code = await pc.getCode({ address: d.lockedLP }).catch(() => undefined);
    if (!codeHasSelector(code, toFunctionSelector("flush(address)"))) return NextResponse.json({ ok: true, skipped: "LockedLP has no flush" });
    const relayer = privateKeyToAccount(key);
    const wc = createWalletClient({ chain: ACTIVE_CHAIN, transport: http(undefined, { retryCount: 0 }), account: relayer });

    // 1) graduated pools since the cursor
    const latest = await pc.getBlockNumber();
    const curKey = `lpflush:cur:${lp}`, poolsKey = `lpflush:pools:${lp}`, turnKey = `lpflush:turn:${lp}`;
    let cur = BigInt((await store.get(curKey)) ?? (d.fromBlock - BigInt(1)).toString());
    const fresh: string[] = [];
    while (cur < latest) {
      const to = cur + SCAN_CHUNK > latest ? latest : cur + SCAN_CHUNK;
      const logs = await pc.getContractEvents({ address: d.lockedLP, abi: lockedLPAbi, eventName: "V4PositionSeeded", fromBlock: cur + BigInt(1), toBlock: to });
      for (const l of logs as unknown as { args: { token: string; poolId: string } }[]) fresh.push(`${l.args.poolId.toLowerCase()}|${l.args.token.toLowerCase()}`);
      cur = to;
    }
    if (fresh.length) await store.sadd(poolsKey, ...fresh);
    await store.set(curKey, cur.toString());
    const pools = (await store.smembers(poolsKey)).sort();

    // 2) rotating, bounded flushes
    const turn = Number((await store.get(turnKey)) ?? "0") || 0;
    const jobs = pools.length ? [...pools.slice(turn % pools.length), ...pools.slice(0, turn % pools.length)].slice(0, LIMITS.MAX_JOBS) : [];
    await store.set(turnKey, String(pools.length ? (turn + jobs.length) % pools.length : 0));
    const t0 = Date.now();
    let gasUsed = BigInt(0);
    const results: Record<string, string> = {};
    for (const j of jobs) {
      const token = j.split("|")[1] as Address;
      if (Date.now() - t0 > LIMITS.DEADLINE_MS) { results[token] = "skipped: out of time"; continue; }
      if (gasUsed >= LIMITS.GAS_PER_RUN) { results[token] = "skipped: gas budget used"; continue; }
      try {
        const [bt, bq] = await pc.readContract({ address: d.lockedLP, abi: FLUSH_ABI, functionName: "compoundBucket", args: [token] });
        if (bt < BigInt(2) || bq < BigInt(2)) { results[token] = "nothing to pair"; continue; }
        const { request, result } = await pc.simulateContract({ account: relayer, address: d.lockedLP, abi: FLUSH_ABI, functionName: "flush", args: [token] });
        if (result === BigInt(0)) { results[token] = "below minimum / budget"; continue; }
        const est = await pc.estimateContractGas({ account: relayer, address: d.lockedLP, abi: FLUSH_ABI, functionName: "flush", args: [token] });
        const gas = gasLimitFor(est, LIMITS.GAS_PER_TX);
        if (gas == null) { results[token] = `skipped: needs ${est} gas`; continue; }
        const hash = await withRelayer(async () => (await import("@/lib/server/fastRelay")).sendWithRelayerNonce((nonce) => wc.writeContract({ ...request, gas, nonce } as never)), 0);
        const rc = await pc.waitForTransactionReceipt({ hash, timeout: 15_000 });
        gasUsed += rc.gasUsed;
        results[token] = rc.status === "success" ? hash : `reverted ${hash}`;
      } catch (e) {
        results[token] = `error: ${errText(e).slice(0, 160)}`;
      }
    }
    return NextResponse.json({ ok: true, pools: pools.length, results, gasUsed: gasUsed.toString(), relayer: relayer.address });
  } finally {
    await store.del("lpflush:lock").catch(() => {});
  }
}
