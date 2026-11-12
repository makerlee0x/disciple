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
 * lp-accrue curves (BondingCurve.feeVault() ≠ 0): the same three rows come from CurveFeeVault instead: CurveFeeSettled
 * (same fields as TradeFeeRouted, quote side) for history, creatorClaimable / referrerAccrued for claimable now, and
 * vault.claimCreatorFees / claimReferrerFees / claimCreatorFeesAsStealth(BySig) to claim (lib/claims/vault.ts).
 *
 * Total earned = claimed so far (claim events) + claimable now + referral shares recorded in the off-chain manual
 * payout ledger (lib/server/referralLedger, the payout CSV lee sends by hand) that were not also credited on-chain.
 * "This week" = history entries (on-chain and ledger) in the last 7 days. See offchainReferral for the double-count rule.
 * Dollar values use the live price of each asset (QuotePricer, launch tokens via the market read).
 */
import type { Address, Hex } from "viem";
import type { Call } from "../aa/core";
import type { Caps } from "./capabilities";
import { crewClaimCall } from "./crew";
import { creatorClaimCalls, referralClaimCalls, type CreatorRocket, type ReferralBalance } from "./creatorFees";
import { fmtUsd, lc } from "./common";

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
/**
 * `offchain`: earned amounts paid by hand (manual payout ledger). They count toward Total earned and the per-type
 * earned figure, never toward claimable (the Claim button only sends on-chain claims).
 */
export function summarize(claimable: Amount[], claimed: Amount[], history: RewardEntry[], nowSec: number, offchain: Amount[] = []): RewardsSummary {
  const byKind = Object.fromEntries(REWARD_KINDS.map((k) => [k, { earnedUsd: 0, claimableUsd: 0 }])) as RewardsSummary["byKind"];
  let claimableUsd = 0, claimedUsd = 0, offchainUsd = 0;
  for (const a of claimable) if (a.usd != null && a.usd > 0) { byKind[a.kind].claimableUsd += a.usd; byKind[a.kind].earnedUsd += a.usd; claimableUsd += a.usd; }
  for (const a of claimed) if (a.usd != null && a.usd > 0) { byKind[a.kind].earnedUsd += a.usd; claimedUsd += a.usd; }
  for (const a of offchain) if (a.usd != null && Number.isFinite(a.usd) && a.usd > 0) { byKind[a.kind].earnedUsd += a.usd; offchainUsd += a.usd; }
  const from = nowSec - WEEK_SEC;
  const weekUsd = history.filter((e) => e.ts > from && e.ts <= nowSec + 60).reduce((s, e) => s + e.usd, 0);
  return { totalUsd: claimableUsd + claimedUsd + offchainUsd, weekUsd, claimableUsd, byKind };
}

/* ---------------- Off-chain referral ledger (manual payouts) ---------------- */
/** One manual-payout ledger row for this referrer (GET /api/profile/referral-ledger): fill id, tx, unix seconds, dollars. */
export type LedgerRow = { id: string; tx: string; ts: number; usd: number };
export type OffchainReferral = {
  /** dollars from the ledger that count toward the totals (after removing anything also credited on-chain) */
  usd: number;
  /** history rows for those dollars (kind referral); empty in the "max" fallback */
  entries: RewardEntry[];
  /** ledger dollars left out because the same trade's referral share was credited on-chain */
  overlapUsd: number;
  /** "tx": matched per transaction; "max": on-chain history unreadable, counted the larger of the two; "none": no ledger rows */
  mode: "tx" | "max" | "none";
};
/**
 * Same idea as an affiliate dashboard (Rewardful / Impact style) that shows one total over a commission ledger where
 * each commission is counted once, whichever way it is paid: here a referral share is either credited on-chain
 * (FeeRouter / CurveFeeVault referrerAccrued, then claimed) or recorded in the manual payout ledger for lee to send.
 *
 * No double count: the ledger writes one row per fill (`tx:logIndex`) whenever the trader has an on-chain referrer,
 * even when the FeeRouter also credits that referral share on-chain (referralSink unset). So for each tx, the number
 * of on-chain referral credits to this account (TradeFeeRouted / CurveFeeSettled with referralPayee or kolPayee = me)
 * removes that many ledger rows of the same tx. `onchainTxs` = tx → on-chain referral credit count.
 * If the on-chain history could not be read (null), fall back to max(on-chain, ledger): never more than either source.
 */
export function offchainReferral(rows: LedgerRow[] | null | undefined, onchainTxs: ReadonlyMap<string, number> | null, onchainReferralUsd: number): OffchainReferral {
  const good = (rows ?? []).filter((r) => r && Number.isFinite(r.usd) && r.usd > 0 && typeof r.tx === "string");
  if (!good.length) return { usd: 0, entries: [], overlapUsd: 0, mode: "none" };
  const total = good.reduce((s, r) => s + r.usd, 0);
  if (!onchainTxs) {
    const on = Number.isFinite(onchainReferralUsd) && onchainReferralUsd > 0 ? onchainReferralUsd : 0;
    const usd = Math.max(0, total - on);
    return { usd, entries: on > 0 ? [] : good.map((r) => ({ kind: "referral" as const, ts: r.ts, usd: r.usd })), overlapUsd: total - usd, mode: "max" };
  }
  const left = new Map<string, number>();
  for (const [tx, n] of onchainTxs) left.set(tx.toLowerCase(), n);
  const entries: RewardEntry[] = [];
  let usd = 0, overlapUsd = 0;
  // oldest first per tx so the same rows drop on every load
  for (const r of [...good].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id))) {
    const k = r.tx.toLowerCase(), n = left.get(k) ?? 0;
    if (n > 0) { left.set(k, n - 1); overlapUsd += r.usd; continue; }
    usd += r.usd;
    entries.push({ kind: "referral", ts: r.ts, usd: r.usd });
  }
  return { usd, entries, overlapUsd, mode: "tx" };
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

/* ---------------- Rocket rewards (profile r3 Rewards popup, "Rocket rewards" tab) ---------------- */
/** One rocket's rewards for this account: Creator (a rocket you launched) or Crew (a rocket you hold), in dollars. */
export type RocketReward = { token: string; name: string; ticker: string; kind: "creator" | "crew"; usd: number };
/**
 * Rows for the Rocket rewards list: same rocket + type merged, unpriced or zero rows dropped, biggest first.
 * Each row is that rocket's earned total (claimed so far + claimable now), the same parts the summary counts.
 */
export function rocketRewardRows(rows: { token: string; name?: string; ticker?: string; kind: "creator" | "crew"; usd: number | null }[]): RocketReward[] {
  const m = new Map<string, RocketReward>();
  for (const r of rows) {
    if (r.usd == null || !Number.isFinite(r.usd) || r.usd <= 0) continue;
    const k = `${r.kind}|${lc(r.token)}`;
    const have = m.get(k);
    if (have) { have.usd += r.usd; if (!have.name && r.name) have.name = r.name; if (!have.ticker && r.ticker) have.ticker = r.ticker; }
    else m.set(k, { token: lc(r.token), name: r.name ?? "", ticker: r.ticker ?? "", kind: r.kind, usd: r.usd });
  }
  return Array.from(m.values()).sort((a, b) => b.usd - a.usd || a.kind.localeCompare(b.kind));
}
/** Friends invited: distinct wallets whose referrer was set to this account (ReferralRegistry.ReferrerAttributed). */
export function countFriends(wallets: string[]): number {
  return new Set(wallets.filter((w) => /^0x[0-9a-fA-F]{40}$/.test(w)).map(lc)).size;
}

/* ---------------- Claim everything ---------------- */
/** Calls per smart-account op: claims cost roughly 50–110k gas each; 20 stays well inside the 3M per-op call cap. */
export const MAX_CLAIM_CALLS = 20;
export type CrewClaimable = { token: Address; pending: bigint };
export type ClaimAllInput = {
  referral: ReferralBalance[];
  creator: Pick<CreatorRocket, "token" | "claimable" | "tokenSide" | "anon" | "launcher" | "stealth" | "vault" | "vaultClaimable" | "baseClaimable">[];
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

/** Dollars-only amount label (referral deposit card): "$x.xx", or a neutral dash when the coin has no live price. Never a token amount. */
export const NO_PRICE = "—";
export function usdLabel(raw: bigint, a: { decimals: number; usd: number | null }): string {
  if (a.usd == null || !Number.isFinite(a.usd)) return NO_PRICE;
  const d = BigInt(10) ** BigInt(a.decimals);
  return fmtUsd((Number(raw / d) + Number(raw % d) / Number(d)) * a.usd) || NO_PRICE;
}
