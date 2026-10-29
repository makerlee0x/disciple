/**
 * Reads behind the combined Rewards section (profile). Every number is live: contract views for what is claimable
 * now, FeeRouter / BondingCurve / AnonLauncher logs for what was earned and claimed. No sample data here (the demo
 * lives in lib/claims/demo.ts behind ?demo=1 on dev builds only). Mapping + sums: lib/claims/rewards.ts.
 */
import { parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { bondingCurveAbi, feeRouterAbi } from "../abi";
import { deployment } from "../chains";
import { curveOf, readMarket } from "../protocol-viem";
import type { Caps } from "./capabilities";
import { assetMeta, lc, type Asset } from "./common";
import { anonSigClaimCalls, creatorDashboard, referralBalances, type CreatorRocket, type ReferralBalance } from "./creatorFees";
import { myStealthKeys, stealthKeyFor } from "../privateLaunch";
import { execCalls } from "../wallet";
import { crewPositions } from "./crew";
import {
  claimAllCalls, feeRouteEarnings, groupHistory, selectClaimCalls, sendClaimAll, priceEarnings, summarize, usdOf,
  type Amount, type CrewClaimable, type FeeRouteLog, type HistoryRow, type Prices, type RawEarning, type RewardKind, type RewardsSummary,
} from "./rewards";

const ZERO = BigInt(0);
type Log<A> = { args: A; blockNumber: bigint; transactionHash: Hex };
type Stealth = Parameters<typeof creatorDashboard>[4];

export type RewardsData = {
  summary: RewardsSummary;
  history: HistoryRow[];
  /** claimable now, per type, in dollars (confirm sheet lines) */
  claimableByKind: Record<RewardKind, number>;
  claim: { referral: ReferralBalance[]; creator: CreatorRocket[]; crew: CrewClaimable[] };
  /** rockets this account launched (wallet + private): shows the creator dashboard link */
  launched: number;
  /** FeeRouter.referralSink() is set: new referral shares stop accruing (balances stay claimable) */
  referralPaused: boolean;
};

const sinkAbi = parseAbi(["function referralSink() view returns (address)"]);
/** true when the deployed FeeRouter routes new referral shares to a sink (#129). Older FeeRouters have no sink ⇒ false. */
export async function referralPaused(pc: PublicClient): Promise<boolean> {
  const a = await pc.readContract({ address: deployment().feeRouter, abi: sinkAbi, functionName: "referralSink" }).catch(() => null);
  return !!a && !/^0x0{40}$/i.test(a);
}

/** Dollar price + decimals per asset: QuotePricer for quote coins, the market read for launch tokens. */
async function priceBook(pc: PublicClient, assets: Iterable<string>, known: Asset[]): Promise<Map<string, { usd: number | null; decimals: number }>> {
  const out = new Map<string, { usd: number | null; decimals: number }>();
  for (const a of known) out.set(lc(a.address), { usd: a.usd, decimals: a.decimals });
  await Promise.all(Array.from(new Set(Array.from(assets, lc))).map(async (addr) => {
    const have = out.get(addr);
    if (have && have.usd != null) return;
    const meta = await assetMeta(pc, addr as Address).catch(() => null);
    let usd = meta?.usd ?? null;
    if (usd == null) usd = (await readMarket(pc, addr as Address))?.priceUsd ?? null;
    if (usd != null && !(usd > 0)) usd = null;
    out.set(addr, { usd, decimals: meta?.decimals ?? have?.decimals ?? 18 });
  }));
  return out;
}

/** Block → unix seconds, newest blocks first, capped (older rows still count in the total, not in the feed). */
async function blockTimes(pc: PublicClient, blocks: bigint[], cap = 120): Promise<Map<bigint, number>> {
  const uniq = Array.from(new Set(blocks)).sort((a, b) => (a > b ? -1 : 1)).slice(0, cap);
  const out = new Map<bigint, number>();
  for (let i = 0; i < uniq.length; i += 12) {
    await Promise.all(uniq.slice(i, i + 12).map(async (b) => {
      const blk = await pc.getBlock({ blockNumber: b }).catch(() => null);
      if (blk) out.set(b, Number(blk.timestamp));
    }));
  }
  return out;
}

export async function loadRewards(pc: PublicClient, me: Address, caps: Caps, stealth: Stealth = [], nowSec = Math.floor(Date.now() / 1000)): Promise<RewardsData> {
  const d = deployment();
  const warn = (what: string) => (e: unknown) => { console.warn(`[disciple] rewards: ${what}`, (e as Error)?.message ?? e); return null; };
  const anyCreator = caps.creatorFees || caps.creatorTokenFees || caps.anonClaims;

  const [refs, creator, crew, routes, refClaims, paused] = await Promise.all([
    caps.referrerFees ? referralBalances(pc, me).catch(warn("referral balances")) : null,
    anyCreator ? creatorDashboard(pc, me, caps, 1, stealth).catch(warn("creator rockets")) : null,
    caps.crew ? crewPositions(pc, me).catch(warn("crew positions")) : null,
    pc.getContractEvents({ address: d.feeRouter, abi: feeRouterAbi, eventName: "TradeFeeRouted", fromBlock: d.fromBlock, toBlock: "latest" }).catch(warn("fee history")),
    caps.referrerFees ? pc.getContractEvents({ address: d.feeRouter, abi: feeRouterAbi, eventName: "ReferrerFeesClaimed", args: { referrer: me }, fromBlock: d.fromBlock, toBlock: "latest" }).catch(warn("referral claims")) : null,
    caps.referrerFees ? referralPaused(pc) : false,
  ]);
  const rockets = creator ?? [];
  const crewRows = crew ?? [];

  // crew claims: HolderRewardsClaimed(holder = me) on the curves of the PVE rockets we know about
  const crewCurves = (await Promise.all(crewRows.map((r) => curveOf(pc, r.token).then((c) => ({ token: r.token, curve: c, quote: r.quote })).catch(() => null))))
    .filter((x): x is NonNullable<typeof x> => !!x);
  const crewClaims = crewCurves.length
    ? ((await pc.getContractEvents({ address: crewCurves.map((c) => c.curve), abi: bondingCurveAbi, eventName: "HolderRewardsClaimed", args: { holder: me }, fromBlock: d.fromBlock, toBlock: "latest" }).catch(warn("crew claims"))) ?? [])
    : [];

  // earnings from fee routes
  const myPrivate = new Map<string, string>(rockets.filter((r) => r.anon && r.launcher).map((r) => [lc(r.token), lc(r.launcher!)]));
  const raw: RawEarning[] = [];
  for (const l of (routes ?? []) as unknown as Log<FeeRouteLog>[]) {
    for (const e of feeRouteEarnings(l.args, me, myPrivate)) raw.push({ ...e, asset: l.args.feeToken, block: l.blockNumber, tx: l.transactionHash });
  }
  const quoteOfCrew = new Map(crewCurves.map((c) => [lc(c.curve), c.quote.address]));
  for (const l of crewClaims as unknown as (Log<{ token: Address; amount: bigint }> & { address: Address })[]) {
    const q = quoteOfCrew.get(lc(l.address)) ?? crewRows.find((r) => lc(r.token) === lc(l.args.token))?.quote.address;
    if (q) raw.push({ kind: "crew", asset: q, raw: l.args.amount, block: l.blockNumber, tx: l.transactionHash });
  }

  // prices for every asset in play
  const known: Asset[] = [...(refs ?? []).map((r) => r.asset), ...rockets.flatMap((r) => [r.quote, ...(r.tokenSide ? [r.tokenSide.asset] : [])]), ...crewRows.map((r) => r.quote)];
  const refClaimLogs = (refClaims ?? []) as unknown as Log<{ quote: Address; amount: bigint }>[];
  const prices: Prices = await priceBook(pc, [...raw.map((r) => r.asset), ...refClaimLogs.map((l) => l.args.quote), ...known.map((a) => a.address)], known);

  const times = await blockTimes(pc, raw.map((r) => r.block));
  for (const r of raw) r.ts = times.get(r.block);
  const { entries, dropped } = priceEarnings(raw, prices);
  if (dropped) console.warn("[disciple] rewards: history rows without a price or time left out", { dropped });

  const tokenSideOn = (r: CreatorRocket) => !!r.tokenSide && (r.anon || caps.creatorTokenFees);
  const claimable: Amount[] = [
    ...(refs ?? []).map((r) => ({ kind: "referral" as const, usd: usdOf(r.claimable, r.asset.address, prices) })),
    ...rockets.flatMap((r) => [
      { kind: "creator" as const, usd: usdOf(r.claimable, r.quote.address, prices) },
      ...(tokenSideOn(r) ? [{ kind: "creator" as const, usd: usdOf(r.tokenSide!.claimable, r.tokenSide!.asset.address, prices) }] : []),
    ]),
    ...crewRows.map((r) => ({ kind: "crew" as const, usd: usdOf(r.pending, r.quote.address, prices) })),
  ];
  const claimed: Amount[] = [
    ...refClaimLogs.map((l) => ({ kind: "referral" as const, usd: usdOf(l.args.amount, l.args.quote, prices) })),
    ...rockets.flatMap((r) => [
      { kind: "creator" as const, usd: usdOf(r.claimed, r.quote.address, prices) },
      ...(r.tokenSide ? [{ kind: "creator" as const, usd: usdOf(r.tokenSide.claimed, r.tokenSide.asset.address, prices) }] : []),
    ]),
    ...raw.filter((r) => r.kind === "crew").map((r) => ({ kind: "crew" as const, usd: usdOf(r.raw, r.asset, prices) })),
  ];
  const summary = summarize(claimable, claimed, entries, nowSec);
  return {
    summary,
    history: groupHistory(entries),
    claimableByKind: { referral: summary.byKind.referral.claimableUsd, creator: summary.byKind.creator.claimableUsd, crew: summary.byKind.crew.claimableUsd },
    claim: {
      referral: (refs ?? []).filter((r) => r.claimable > ZERO),
      creator: rockets.filter((r) => r.claimable > ZERO || (tokenSideOn(r) && r.tokenSide!.claimable > ZERO)),
      crew: crewRows.filter((r) => r.pending > ZERO).map((r) => ({ token: r.token, pending: r.pending })),
    },
    launched: rockets.length,
    referralPaused: paused,
  };
}

/** Is there anything at all to claim? (wallet rockets, private rockets, referral, crew) */
export const hasClaimable = (c: RewardsData["claim"]) => c.referral.length + c.creator.length + c.crew.length > 0;

export type ClaimAllResult = { txHash: Hex; deferred: number; skipped: number };
/**
 * Claim everything claimable in ONE smart-account op (lib/wallet.execCalls → executeBatch): referral, creator (wallet
 * and private rockets), crew. Stealth-owned private rockets get their stealth-key signature first (silent, no prompt).
 * Each call is dry-run on its own; any that would fail is left out (console) so one bad claim can't block the rest.
 */
export async function claimEverything(pc: PublicClient, me: Address, caps: Caps, claim: RewardsData["claim"]): Promise<ClaimAllResult> {
  const calls = claimAllCalls(claim, caps, me);
  if (caps.anonClaims && claim.creator.some((r) => r.anon && r.stealth)) {
    try {
      const k = await myStealthKeys();
      calls.push(...(await anonSigClaimCalls(pc, claim.creator, me, (eph) => stealthKeyFor(k, eph))).map((c) => ({ ...c, kind: "creator" as const })));
    } catch (e) { console.warn("[disciple] rewards: private rocket claim skipped", (e as Error)?.message ?? e); }
  }
  let firstErr: unknown = null;
  const ok = await Promise.all(calls.map((c) => pc.call({ account: me, to: c.to, data: c.data, value: c.value }).then(() => true, (e) => {
    firstErr ??= e;
    console.warn("[disciple] rewards: claim dry run failed, left out", { kind: c.kind, to: c.to, message: (e as Error)?.message?.slice(0, 200) });
    return false;
  })));
  const pick = selectClaimCalls(calls, ok);
  if (!pick.send.length) throw firstErr ?? new Error("Nothing to claim yet.");
  if (pick.deferred) console.warn("[disciple] rewards: claim list capped", { sent: pick.send.length, deferred: pick.deferred });
  const r = await sendClaimAll(pick.send, execCalls);
  return { txHash: r.txHash, deferred: pick.deferred, skipped: pick.skipped };
}
