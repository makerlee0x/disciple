/**
 * GET /api/cron/route-creator-fees — Vercel cron (vercel.json, hourly). Calls CreatorFeeHarvest.route(token) from the
 * relayer EOA for every coin launched with creator fees sent to the locked pool or to buy-and-burn (lib/feeRouteKeeper).
 * Without this, those fees sit in FeeRouter / CurveFeeVault: the creator can't claim them, and nothing moves them.
 * Auth: Bearer CRON_SECRET, constant-time; in production an unset CRON_SECRET ⇒ 503 (never an open endpoint).
 * Coin scan: CreatorFeeDestinationSet logs from the KV cursor `feeroute:cur:<harvest>` (starts at the stack's
 * fromBlock), coins kept in `feeroute:tokens:<harvest>`. Each route is simulated and gas-estimated first, so a coin with
 * nothing to send costs nothing. Spend is bounded per tx, per run and by time (lib/feeRouteKeeper KEEPER_LIMITS), and only
 * coins paired with a launch-list coin are routed. Run lock `feeroute:lock` (55 s). FEE_ROUTE_KEEPER_DISABLED=1 turns it off.
 * Dust rule (maker 2026-11-20, lib/feeRouteKeeper routeIsWorthIt): the relayer pays the gas, so a route is only sent when
 * $2+ of quote is waiting (FEE_ROUTE_MIN_USD) or a job has waited 24 h (FEE_ROUTE_MAX_WAIT_HOURS). Wait clocks live in KV
 * `feeroute:wait:<harvest>:<job>` and are cleared after a send.
 */
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { createPublicClient, createWalletClient, formatEther, http, toFunctionSelector, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ACTIVE_CHAIN, deployment, ZERO } from "@/lib/chains";
import { creatorFeeHarvestAbi } from "@/lib/creatorFeeHarvest";
import { kv } from "@/lib/server/kv";
import { relayerKey, isRelayerNotConfigured, withRelayer } from "@/lib/server/relayer";
import { bondingCurveAbi, feeRouterAbi, launchpadAbi } from "@/lib/abi";
import { addressOn, launchPairsForChain } from "@/lib/launchWhitelist";
import { KEEPER_LIMITS, codeHasSelector, gasLimitFor, isQuietRouteError, pastCreatorKeys, planJobs, routeIsWorthIt, routeMinConfig, routedTokensFromLogs, splitPastKey } from "@/lib/feeRouteKeeper";
import { quoteUsd } from "@/lib/trades";

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

    // 1b) past creators of those coins (Launchpad CreatorTransferred), routed with routeWith (audit CH-04)
    const pastCurKey = `feeroute:pastcur:${h}`, pastKey = `feeroute:past:${h}`;
    let pc0 = BigInt((await store.get(pastCurKey)) ?? (d.fromBlock - BigInt(1)).toString());
    const pastNew: string[] = [];
    while (pc0 < latest) {
      const to = pc0 + SCAN_CHUNK > latest ? latest : pc0 + SCAN_CHUNK;
      const logs = await pc.getContractEvents({ address: d.launchpad, abi: launchpadAbi, eventName: "CreatorTransferred", fromBlock: pc0 + BigInt(1), toBlock: to });
      pastNew.push(...pastCreatorKeys(logs as never, known));
      pc0 = to;
    }
    if (pastNew.length) await store.sadd(pastKey, ...pastNew);
    await store.set(pastCurKey, pc0.toString());
    const past = new Map<string, string[]>();
    for (const k of await store.smembers(pastKey)) { const { token, creator } = splitPastKey(k); past.set(token, [...(past.get(token) ?? []), creator]); }

    // 2) one bounded, rotating job list (lib/feeRouteKeeper KEEPER_LIMITS): route(token), plus routeWith(token, past)
    // for up to MAX_PAST_PER_COIN past creators, only when this harvest has routeWith (PR #371; not on v6 testnet).
    const t0 = Date.now();
    const code = await pc.getCode({ address: harvest }).catch(() => undefined);
    const withPast = codeHasSelector(code, toFunctionSelector("routeWith(address,address)"));
    const turn = Number((await store.get(turnKey)) ?? "0") || 0;
    const plan = planJobs(Array.from(known), past, { withPast, start: turn });
    await store.set(turnKey, String(plan.next));
    // Only coins paired with a launch-list coin: the relayer never moves a launcher's own ERC-20.
    const allowedQuotes = new Set([
      ...launchPairsForChain(ACTIVE_CHAIN.id).map((c) => addressOn(c, ACTIVE_CHAIN.id, d.defaultQuote).toLowerCase()),
      d.defaultQuote.toLowerCase(), d.usdg.toLowerCase(),
    ].filter((a) => a !== ZERO));
    const quoteOf = new Map<string, string>();
    const qpOf = new Map<string, bigint>();
    const minCfg = routeMinConfig();
    const results: Record<string, string> = {};
    let gasUsed = BigInt(0);
    for (const j of plan.jobs) {
      if (Date.now() - t0 > KEEPER_LIMITS.DEADLINE_MS) { results[j.label] = "skipped: out of time this run"; continue; }
      if (gasUsed >= KEEPER_LIMITS.GAS_PER_RUN) { results[j.label] = "skipped: gas budget used this run"; continue; }
      try {
        if (!quoteOf.has(j.token)) {
          const q = await pc.readContract({ address: d.feeRouter, abi: feeRouterAbi, functionName: "tokenQuote", args: [j.token as Address] }).catch(() => ZERO);
          quoteOf.set(j.token, String(q).toLowerCase());
        }
        if (!allowedQuotes.has(quoteOf.get(j.token)!)) { results[j.label] = "skipped: pair coin is not on the launch list"; continue; }
        const args = (j.fn === "route" ? [j.token] : [j.token, j.pastCreator]) as never;
        const { request, result } = await pc.simulateContract({ account: relayer, address: harvest, abi: creatorFeeHarvestAbi, functionName: j.fn, args });
        // dust rule: the relayer pays this gas, so only send when it's worth it (or it has waited a day)
        const [qAmt, rAmt] = result as unknown as readonly [bigint, bigint, bigint];
        if (!qpOf.has(j.token)) {
          const curve = await pc.readContract({ address: d.launchpad, abi: launchpadAbi, functionName: "curveOf", args: [j.token as Address] }).catch(() => ZERO);
          const qp = curve === ZERO ? BigInt(0) : await pc.readContract({ address: curve as Address, abi: bondingCurveAbi, functionName: "quotePriceUsd" }).catch(() => BigInt(0));
          qpOf.set(j.token, qp as bigint);
        }
        const qp = qpOf.get(j.token)!;
        const waitKey = `feeroute:wait:${h}:${j.label}`;
        const now = Date.now();
        const since = Number(await store.get(waitKey)) || null;
        const worth = routeIsWorthIt({ quote: qAmt, rockets: rAmt, quoteUsd: qp > BigInt(0) ? quoteUsd(qAmt, qp) : null, waitingSince: since, now, ...minCfg });
        if (!worth.send) {
          if (since === null) await store.set(waitKey, String(now));
          results[j.label] = worth.reason;
          continue;
        }
        const est = await pc.estimateContractGas({ account: relayer, address: harvest, abi: creatorFeeHarvestAbi, functionName: j.fn, args });
        const gas = gasLimitFor(est);
        if (gas == null) { results[j.label] = `skipped: needs ${est} gas, over the ${KEEPER_LIMITS.GAS_PER_TX} cap`; continue; }
        if (gasUsed + gas > KEEPER_LIMITS.GAS_PER_RUN) { results[j.label] = "skipped: gas budget used this run"; continue; }
        // the relayer EOA's shared nonce allocator (same as /api/cron/poke-pricer); gas is capped, never estimated again
        const hash = await withRelayer(async () => (await import("@/lib/server/fastRelay")).sendWithRelayerNonce((nonce) => wc.writeContract({ ...request, gas, nonce } as never)), 0);
        const rc = await pc.waitForTransactionReceipt({ hash, timeout: 15_000 });
        gasUsed += rc.gasUsed;
        results[j.label] = rc.status === "success" ? hash : `reverted ${hash}`;
        if (rc.status === "success") await store.del(waitKey).catch(() => {});
      } catch (e) {
        const m = errText(e);
        results[j.label] = isQuietRouteError(m) ? "nothing yet" : `error: ${m.slice(0, 160)}`;
      }
    }
    const bal = await pc.getBalance({ address: relayer.address }).catch(() => BigInt(0));
    return NextResponse.json({
      ok: true, coins: known.size, jobs: plan.total, withPast, newCoins: fresh, results, gasUsed: gasUsed.toString(),
      relayer: relayer.address, relayerBalanceEth: formatEther(bal),
    });
  } finally {
    await store.del("feeroute:lock").catch(() => {});
  }
}
