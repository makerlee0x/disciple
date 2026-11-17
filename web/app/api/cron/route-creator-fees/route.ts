/**
 * GET /api/cron/route-creator-fees — Vercel cron (vercel.json, hourly). Calls CreatorFeeHarvest.route(token) from the
 * relayer EOA for every coin launched with creator fees sent to the locked pool or to buy-and-burn (lib/feeRouteKeeper).
 * Without this, those fees sit in FeeRouter / CurveFeeVault: the creator can't claim them, and nothing moves them.
 * Auth: Bearer CRON_SECRET, constant-time; in production an unset CRON_SECRET ⇒ 503 (never an open endpoint).
 * Coin scan: CreatorFeeDestinationSet logs from the KV cursor `feeroute:cur:<harvest>` (starts at the stack's
 * fromBlock), coins kept in `feeroute:tokens:<harvest>`. Each route is simulated and gas-estimated first, so a coin with
 * nothing to send costs nothing. Spend is bounded per tx, per run and by time (lib/feeRouteKeeper KEEPER_LIMITS), and only
 * coins paired with a launch-list coin are routed. Run lock `feeroute:lock` (55 s). FEE_ROUTE_KEEPER_DISABLED=1 turns it off.
 */
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { createPublicClient, createWalletClient, formatEther, http, toFunctionSelector, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ACTIVE_CHAIN, deployment, ZERO } from "@/lib/chains";
import { creatorFeeHarvestAbi } from "@/lib/creatorFeeHarvest";
import { kv } from "@/lib/server/kv";
import { relayerKey, isRelayerNotConfigured, withRelayer } from "@/lib/server/relayer";
import { feeRouterAbi, launchpadAbi, lockedLPAbi } from "@/lib/abi";
import { addressOn, launchPairsForChain } from "@/lib/launchWhitelist";
import { disciplePoolId } from "@/lib/v4Swap";
import { refSqrt } from "@/lib/server/poolRefRead";
import { KEEPER_LIMITS, codeHasSelector, gasLimitFor, isQuietRouteError, pastCreatorKeys, planJobs, routedTokensFromLogs, splitPastKey } from "@/lib/feeRouteKeeper";

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
    // Slim hook: a graduated coin is routed with routeAtRef at its pool's 30-minute average price (keeper = relayer), so a
    // burn coin's rocket-token fees can be sold. Older harvests (no routeAtRef) keep route / routeWith.
    const withRef = codeHasSelector(code, toFunctionSelector("routeAtRef(address,address,uint160)"))
      && String(await pc.readContract({ address: harvest, abi: creatorFeeHarvestAbi, functionName: "keeper" }).catch(() => ZERO)).toLowerCase() === relayer.address.toLowerCase();
    const graduated = new Map<string, boolean>();
    const turn = Number((await store.get(turnKey)) ?? "0") || 0;
    const plan = planJobs(Array.from(known), past, { withPast, start: turn });
    await store.set(turnKey, String(plan.next));
    // Only coins paired with a launch-list coin: the relayer never moves a launcher's own ERC-20.
    const allowedQuotes = new Set([
      ...launchPairsForChain(ACTIVE_CHAIN.id).map((c) => addressOn(c, ACTIVE_CHAIN.id, d.defaultQuote).toLowerCase()),
      d.defaultQuote.toLowerCase(), d.usdg.toLowerCase(),
    ].filter((a) => a !== ZERO));
    const quoteOf = new Map<string, string>();
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
        let fn: "route" | "routeWith" | "routeAtRef" = j.fn;
        let args = (j.fn === "route" ? [j.token] : [j.token, j.pastCreator]) as never;
        if (withRef) {
          if (!graduated.has(j.token)) graduated.set(j.token, Boolean(await pc.readContract({ address: d.lockedLP, abi: lockedLPAbi, functionName: "isGraduated", args: [j.token as Address] }).catch(() => false)));
          if (graduated.get(j.token)) {
            const { ref } = await refSqrt(pc as never, d.poolManager, disciplePoolId(j.token, quoteOf.get(j.token)!, d.hook));
            if (ref > BigInt(0)) { fn = "routeAtRef"; args = [j.token, j.pastCreator ?? ZERO, ref] as never; }
          }
        }
        const { request } = await pc.simulateContract({ account: relayer, address: harvest, abi: creatorFeeHarvestAbi, functionName: fn, args });
        const est = await pc.estimateContractGas({ account: relayer, address: harvest, abi: creatorFeeHarvestAbi, functionName: fn, args });
        const gas = gasLimitFor(est);
        if (gas == null) { results[j.label] = `skipped: needs ${est} gas, over the ${KEEPER_LIMITS.GAS_PER_TX} cap`; continue; }
        if (gasUsed + gas > KEEPER_LIMITS.GAS_PER_RUN) { results[j.label] = "skipped: gas budget used this run"; continue; }
        // the relayer EOA's shared nonce allocator (same as /api/cron/poke-pricer); gas is capped, never estimated again
        const hash = await withRelayer(async () => (await import("@/lib/server/fastRelay")).sendWithRelayerNonce((nonce) => wc.writeContract({ ...request, gas, nonce } as never)), 0);
        const rc = await pc.waitForTransactionReceipt({ hash, timeout: 15_000 });
        gasUsed += rc.gasUsed;
        results[j.label] = rc.status === "success" ? hash : `reverted ${hash}`;
      } catch (e) {
        const m = errText(e);
        results[j.label] = isQuietRouteError(m) ? "nothing yet" : `error: ${m.slice(0, 160)}`;
      }
    }
    const bal = await pc.getBalance({ address: relayer.address }).catch(() => BigInt(0));
    return NextResponse.json({
      ok: true, coins: known.size, jobs: plan.total, withPast, withRef, newCoins: fresh, results, gasUsed: gasUsed.toString(),
      relayer: relayer.address, relayerBalanceEth: formatEther(bal),
    });
  } finally {
    await store.del("feeroute:lock").catch(() => {});
  }
}
