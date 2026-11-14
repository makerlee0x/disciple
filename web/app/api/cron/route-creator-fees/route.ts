/**
 * GET /api/cron/route-creator-fees — Vercel cron (vercel.json, hourly). Calls CreatorFeeHarvest.route(token) from the
 * relayer EOA for every coin launched with creator fees sent to the locked pool or to buy-and-burn (lib/feeRouteKeeper).
 * Without this, those fees sit in FeeRouter / CurveFeeVault: the creator can't claim them, and nothing moves them.
 * Auth: Bearer CRON_SECRET, constant-time; in production an unset CRON_SECRET ⇒ 503 (never an open endpoint).
 * Coin scan: CreatorFeeDestinationSet logs from the KV cursor `feeroute:cur:<harvest>` (starts at the stack's
 * fromBlock), coins kept in `feeroute:tokens:<harvest>`. Each route is simulated first, so a coin with nothing to send
 * costs nothing. Run lock `feeroute:lock` (55 s). FEE_ROUTE_KEEPER_DISABLED=1 turns it off.
 */
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { createPublicClient, createWalletClient, formatEther, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ACTIVE_CHAIN, deployment, ZERO } from "@/lib/chains";
import { creatorFeeHarvestAbi } from "@/lib/creatorFeeHarvest";
import { kv } from "@/lib/server/kv";
import { relayerKey, isRelayerNotConfigured, withRelayer } from "@/lib/server/relayer";
import { MAX_ROUTES_PER_RUN, isQuietRouteError, rotate, routedTokensFromLogs } from "@/lib/feeRouteKeeper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const isProd = () => process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
const same = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const SCAN_CHUNK = BigInt(50_000);
const errText = (e: unknown) => String((e as { shortMessage?: string }).shortMessage || (e as Error).message || e);

export async function GET(req: Request) {
  const s = process.env.CRON_SECRET;
  if (!s && isProd()) return NextResponse.json({ error: "cron_not_configured" }, { status: 503 });
  if (s && !same(req.headers.get("authorization") || "", `Bearer ${s}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (process.env.FEE_ROUTE_KEEPER_DISABLED === "1") return NextResponse.json({ ok: true, skipped: "disabled" });
  const d = deployment();
  const harvest = d.creatorFeeHarvest;
  if (!harvest || harvest === ZERO) return NextResponse.json({ ok: true, skipped: "no harvest" });
  let key: `0x${string}`;
  try { key = relayerKey(); } catch (e) { return NextResponse.json({ error: isRelayerNotConfigured(e) ? "relayer_not_configured" : "relayer_error" }, { status: 503 }); }

  const store = kv(), h = harvest.toLowerCase();
  if (!(await store.setNX("feeroute:lock", "1", 55))) return NextResponse.json({ ok: true, skipped: "locked" });
  try {
    const pc = createPublicClient({ chain: ACTIVE_CHAIN, transport: http() });
    const relayer = privateKeyToAccount(key);
    const wc = createWalletClient({ chain: ACTIVE_CHAIN, transport: http(undefined, { retryCount: 0 }), account: relayer });

    // 1) coins launched with pool / burn since the cursor
    const latest = await pc.getBlockNumber();
    const curKey = `feeroute:cur:${h}`, tokensKey = `feeroute:tokens:${h}`, turnKey = `feeroute:turn:${h}`;
    let cur = BigInt((await store.get(curKey)) ?? (d.fromBlock - BigInt(1)).toString());
    const known = new Set((await store.smembers(tokensKey)).map((x) => x.toLowerCase()));
    const fresh: string[] = [];
    while (cur < latest) {
      const to = cur + SCAN_CHUNK > latest ? latest : cur + SCAN_CHUNK;
      const logs = await pc.getContractEvents({ address: harvest, abi: creatorFeeHarvestAbi, eventName: "CreatorFeeDestinationSet", fromBlock: cur + BigInt(1), toBlock: to });
      for (const t of routedTokensFromLogs(logs as never)) if (!known.has(t)) { known.add(t); fresh.push(t); }
      cur = to;
    }
    if (fresh.length) await store.sadd(tokensKey, ...fresh);
    await store.set(curKey, cur.toString());

    // 2) route each coin (simulate → send), a rotating window of MAX_ROUTES_PER_RUN
    const turn = Number((await store.get(turnKey)) ?? "0") || 0;
    const all = rotate(Array.from(known).sort(), turn);
    const batch = all.slice(0, MAX_ROUTES_PER_RUN);
    await store.set(turnKey, String(turn + batch.length));
    const results: Record<string, string> = {};
    let gasUsed = BigInt(0);
    for (const token of batch) {
      try {
        const { request } = await pc.simulateContract({ account: relayer, address: harvest, abi: creatorFeeHarvestAbi, functionName: "route", args: [token as Address] });
        // the relayer EOA's shared nonce allocator (same as /api/cron/poke-pricer)
        const hash = await withRelayer(async () => (await import("@/lib/server/fastRelay")).sendWithRelayerNonce((nonce) => wc.writeContract({ ...request, nonce })), 0);
        const rc = await pc.waitForTransactionReceipt({ hash, timeout: 15_000 });
        gasUsed += rc.gasUsed;
        results[token] = rc.status === "success" ? hash : `reverted ${hash}`;
      } catch (e) {
        const m = errText(e);
        results[token] = isQuietRouteError(m) ? "nothing yet" : `error: ${m.slice(0, 160)}`;
      }
    }
    const bal = await pc.getBalance({ address: relayer.address }).catch(() => BigInt(0));
    return NextResponse.json({
      ok: true, coins: all.length, newCoins: fresh, results, gasUsed: gasUsed.toString(),
      relayer: relayer.address, relayerBalanceEth: formatEther(bal),
    });
  } finally {
    await store.del("feeroute:lock").catch(() => {});
  }
}
