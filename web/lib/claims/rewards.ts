/**
 * Combined "Rewards" (profile): one total, one Claim, one history feed across every reward the account earns.
 * Pure (no RPC, no wallet) so it is unit-tested by scripts/test-rewards.mts; the reads live in lib/claims/rewardsData.ts.
 *
 *   type      earned (history)                                          claimable now                          claim call
 *   referral  FeeRouter.TradeFeeRouted referralPayee = me (referralShare) referrerAccrued(me, quote)            FeeRouter.claimReferrerFees(quote)
 *             FeeRouter.TradeFeeRouted kolPayee = me (kolShare)          (KOL credits land in the same balance)
 *   creator   FeeRouter.TradeFeeRouted creator = me (creatorShare +     creatorAccrued / creatorTokenAccrued    FeeRouter.claimCreatorFees / claimCreatorTokenFees
 *             creatorTaxAmount); private rockets: creator = the coin's   AnonLauncher.pending(token)             AnonLauncher.claimMany / claimManyBySig
 *             launcher and the token is one of ours
 *   crew      BondingCurve.HolderRewardsClaimed holder = me (no per-     BondingCurve.pendingRewards(me)          Launchpad.claim(token)
 *             holder accrual event exists, so crew shows up when claimed)
 *
 * Total earned = claimed so far (claim events) + claimable now. "This week" = history entries in the last 7 days.
 * Dollar values use the live price of each asset (QuotePricer, launch tokens via the market read).
 */
import type { Address, Hex } from "viem";
import type { Call } from "../aa/core";
import type { Caps } from "./capabilities";
import { crewClaimCall } from "./crew";
import { creatorClaimCalls, referralClaimCalls, type CreatorRocket, type ReferralBalance } from "./creatorFees";
import { lc } from "./common";

export type RewardKind = "referral" | "creator" | "crew";
export const REWARD_KINDS: RewardKind[] = ["referral", "creator", "crew"];
/** Player-facing type names (copy pending lee). */
export const REWARD_LABEL: Record<RewardKind, string> = { referral: "Referral", creator: "Creator", crew: "Crew" };

const ZERO = BigInt(0);
export const WEEK_SEC = 7 * 86400;

/** One TradeFeeRouted (FeeRouter) as decoded by viem; amounts are in feeToken units. */
export type FeeRouteLog = {
  token: Address; feeToken: Address; creator: Address;
  creatorShare: bigint; creatorTaxAmount: bigint;
  referralPayee: Address; referralShare: bigint; kolPayee: Address; kolShare: bigint;
};
/** A raw earning before pricing: `asset` is the token the amount is counted in. */
export type RawEarning = { kind: RewardKind; asset: Address; raw: bigint; block: bigint; tx?: Hex; ts?: number };

/**
 * What `me` earned from one fee route. Referral = referral share + KOL share paid to me; creator = creator share +
 * creator tax when I'm the creator, or when the creator is the launcher of one of my private rockets.
 */
export function feeRouteEarnings(l: FeeRouteLog, me: Address, myPrivate: ReadonlyMap<string, string> = new Map()): { kind: RewardKind; raw: bigint }[] {
  const m = lc(me), out: { kind: RewardKind; raw: bigint }[] = [];
  let ref = ZERO;
  if (lc(l.referralPayee) === m) ref += l.referralShare;
  if (lc(l.kolPayee) === m) ref += l.kolShare;
  if (ref > ZERO) out.push({ kind: "referral", raw: ref });
  const c = l.creatorShare + l.creatorTaxAmount;
  const launcher = myPrivate.get(lc(l.token));
  if (c > ZERO && (lc(l.creator) === m || (!!launcher && lc(l.creator) === lc(launcher)))) out.push({ kind: "creator", raw: c });
  return out;
}

/** Price book: dollars per whole unit + decimals, by lower-case asset address. */
export type Prices = ReadonlyMap<string, { usd: number | null; decimals: number }>;
/** Raw amount → dollars, or null when the asset has no live price (left out of every dollar figure). */
export function usdOf(raw: bigint, asset: string, prices: Prices): number | null {
  const p = prices.get(lc(asset));
  if (!p || p.usd == null || !Number.isFinite(p.usd)) return null;
  // split to keep precision for 18-dec amounts beyond 2^53
  const d = BigInt(10) ** BigInt(p.decimals);
  return (Number(raw / d) + Number(raw % d) / Number(d)) * p.usd;
}

export type RewardEntry = { kind: RewardKind; ts: number; usd: number };
/** Price + timestamp raw earnings; drops unpriced or undated rows (count returned for the console). */
export function priceEarnings(rows: RawEarning[], prices: Prices): { entries: RewardEntry[]; dropped: number } {
  const entries: RewardEntry[] = [];
  let dropped = 0;
  for (const r of rows) {
    const usd = usdOf(r.raw, r.asset, prices);
    if (usd == null || r.ts == null || r.raw <= ZERO) { dropped++; continue; }
    entries.push({ kind: r.kind, ts: r.ts, usd });
  }
  return { entries, dropped };
}

export type Amount = { kind: RewardKind; usd: number | null };
export type RewardsSummary = {
  totalUsd: number; weekUsd: number; claimableUsd: number;
  byKind: Record<RewardKind, { earnedUsd: number; claimableUsd: number }>;
};
/** Total earned (claimed + claimable), this week (history in the last 7 days), and the per-type split. */
export function summarize(claimable: Amount[], claimed: Amount[], history: RewardEntry[], nowSec: number): RewardsSummary {
  const byKind = Object.fromEntries(REWARD_KINDS.map((k) => [k, { earnedUsd: 0, claimableUsd: 0 }])) as RewardsSummary["byKind"];
  let claimableUsd = 0, claimedUsd = 0;
  for (const a of claimable) if (a.usd != null && a.usd > 0) { byKind[a.kind].claimableUsd += a.usd; byKind[a.kind].earnedUsd += a.usd; claimableUsd += a.usd; }
  for (const a of claimed) if (a.usd != null && a.usd > 0) { byKind[a.kind].earnedUsd += a.usd; claimedUsd += a.usd; }
  const from = nowSec - WEEK_SEC;
  const weekUsd = history.filter((e) => e.ts > from && e.ts <= nowSec + 60).reduce((s, e) => s + e.usd, 0);
  return { totalUsd: claimableUsd + claimedUsd, weekUsd, claimableUsd, byKind };
}

export type HistoryRow = { kind: RewardKind; day: string; from: number; to: number; usd: number; count: number };
/** Local calendar day key (YYYY-MM-DD); tests pass a fixed-zone one. */
export const localDay = (ts: number) => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
/** Feed rows: one per (type, day), newest first. */
export function groupHistory(entries: RewardEntry[], dayOf: (ts: number) => string = localDay, limit = 40): HistoryRow[] {
  const m = new Map<string, HistoryRow>();
  for (const e of entries) {
    if (!(e.usd > 0)) continue;
    const day = dayOf(e.ts), k = `${e.kind}|${day}`;
    const r = m.get(k);
    if (r) { r.usd += e.usd; r.count++; r.from = Math.min(r.from, e.ts); r.to = Math.max(r.to, e.ts); }
    else m.set(k, { kind: e.kind, day, from: e.ts, to: e.ts, usd: e.usd, count: 1 });
  }
  return Array.from(m.values()).sort((a, b) => b.to - a.to || a.kind.localeCompare(b.kind)).slice(0, limit);
}

/* ---------------- Claim everything ---------------- */
/** Calls per smart-account op: claims cost roughly 50–110k gas each; 20 stays well inside the 3M per-op call cap. */
export const MAX_CLAIM_CALLS = 20;
export type CrewClaimable = { token: Address; pending: bigint };
export type ClaimAllInput = {
  referral: ReferralBalance[];
  creator: Pick<CreatorRocket, "token" | "claimable" | "tokenSide" | "anon" | "launcher" | "stealth">[];
  crew: CrewClaimable[];
};
export type TaggedCall = Call & { kind: RewardKind };
/**
 * Every claim the account can make without an extra signature, in one list (one smart-account op):
 * referral per quote with a balance, creator per rocket side with a balance, private rockets this account owns
 * (claimMany per launcher), crew per PVE rocket with pending rewards. Zeros are skipped. Stealth-owned private
 * rockets need a stealth-key signature first (creatorFees.anonSigClaimCalls), appended by the caller.
 */
export function claimAllCalls(input: ClaimAllInput, caps: Caps, me: Address): TaggedCall[] {
  const tag = (kind: RewardKind) => (c: Call): TaggedCall => ({ ...c, kind });
  return [
    ...(caps.referrerFees ? referralClaimCalls(input.referral).map(tag("referral")) : []),
    ...creatorClaimCalls(input.creator, caps, me).map(tag("creator")),
    ...(caps.crew ? input.crew.filter((c) => c.pending > ZERO).map((c) => tag("crew")(crewClaimCall(c.token))) : []),
  ];
}

/**
 * Pick what goes out: drop calls whose dry run failed (one bad claim must not sink the rest), then cap the list.
 * `ok[i]` is the dry-run result of calls[i]. Returns the calls to send and how many were left for next time.
 */
export function selectClaimCalls<T extends Call>(calls: T[], ok: boolean[], max = MAX_CLAIM_CALLS): { send: T[]; skipped: number; deferred: number } {
  const good = calls.filter((_, i) => ok[i]);
  return { send: good.slice(0, max), skipped: calls.length - good.length, deferred: Math.max(0, good.length - max) };
}

/** Sends the claim list as ONE call to the wallet (smart account ⇒ one op, one confirmation). */
export async function sendClaimAll<R>(calls: Call[], exec: (calls: Call[]) => Promise<R>): Promise<R> {
  if (!calls.length) throw new Error("Nothing to claim yet.");
  return exec(calls.map(({ to, data, value }) => ({ to, data, ...(value != null ? { value } : {}) })));
}
