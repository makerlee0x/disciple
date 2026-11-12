import "server-only";
/**
 * Off-chain referral ledger (flow/referral-ledger).
 *
 * Existing pattern reused (see lib/server/trades.ts): the trade indexer already writes each
 * BondingCurve / DiscipleHook Trade to Upstash as a Fill (`trades:<coin>` zsets, `trades:seen:<tx>:<li>`
 * SET NX so a re-run never double-counts), and attaches DiscipleRouter UsdgTrade / UsdgRefund from
 * usdgRouters() (regular + gasless). This ledger is the same after-the-fact path: storeFills marks
 * fills dirty (same idea as ACH.dirty), indexTrades then records a fee-slice row, and a later CSV
 * drain catches anything the first pass missed. Nothing here runs on the relay / admission path.
 *
 * Amount = the leftover 1% of the 1% trade fee (FeeMath.splitTradeFee / Constants 33/33/33/1).
 * Preferred source is FeeRouter.TradeFeeRouted in the same tx (feeAmount reconstructed as
 * creatorShare+lpShare+treasuryShare+referralShare, then split again so a sink / KOL redirect that
 * zeroed referralShare still yields the slice). Fallback: compute from the stored Fill.
 *
 * Referrer = the account referral bind (lib/server/referralBind accountReferrerOf: the first-touch referrer
 * saved to the trader's account at sign-in, Upstash `referral:<chain>:bind:<wallet>`) — never
 * TradeFeeRouted.referralPayee (that can be a launch KOL or referralSink). No saved referrer ⇒ no
 * row (that 1% stays on the treasury / community path, unchanged). Not tracked per coin.
 * (Before flow/account-referral-bind this read ReferralRegistry.referrerOf, which is locked on-chain only
 * through tryAttribute; nothing is locked on the live test network, so the sheet stayed empty. That
 * reader is kept below as registryReferrerOf, unused for this payout.)
 *
 * Keys (namespaced by chain id, same idea as lib/server/achKeys.ts):
 *   referral:<chain>:seen:<fillId>   SET NX dedupe (a fill is counted once even if the indexer re-runs)
 *   referral:<chain>:rows            zset score=ts member=ReferralRow JSON
 *   referral:<chain>:dirty           zset score=ts member=Fill JSON (pending, like ACH.dirty)
 *   referral:<chain>:of:<wallet>     cached non-zero referrerOf (registryReferrerOf only; unused for the payout)
 *   referral:<chain>:bind:<wallet>   account referral bind (written by lib/server/referralBind, read here)
 */
import { parseAbi, type Address } from "viem";
import { deployment, ZERO, ACTIVE_CHAIN } from "@/lib/chains";
import { serverPc } from "./chat/identity";
import { kv, type Kv } from "./kv";
import { accountReferrerOf } from "./referralBind";
import { usernameOf as usernameOfWallet } from "./usernames";
import { playerUsd, type Fill } from "@/lib/trades";
import { usdgDecimals, usdgRawToUsd, isUsdg, COIN_DECIMALS } from "@/lib/usdg";

export const TRADE_FEE_BPS = 100;
export const BPS_DENOM = 10_000;
export const FEE_SHARE_CREATOR = 33;
export const FEE_SHARE_LP_LOCK = 33;
export const FEE_SHARE_TREASURY = 33;
export const FEE_SHARE_DENOM = 100;
export const CHICAGO_TZ = "America/Chicago";
export const REFERRAL_CSV_TZ = CHICAGO_TZ;

const ns = () => `referral:${ACTIVE_CHAIN.id}`;
export const REF = {
  seen: (fillId: string) => `${ns()}:seen:${fillId}`,
  rows: () => `${ns()}:rows`,
  dirty: () => `${ns()}:dirty`,
  of: (wallet: string) => `${ns()}:of:${wallet.toLowerCase()}`,
};

const ZERO_ADDR = ZERO.toLowerCase();
const isZero = (a: string | null | undefined) => !a || a.toLowerCase() === ZERO_ADDR;
const lc = (a: string) => a.toLowerCase();

/** America/Chicago calendar date of a unix-ms timestamp, YYYY-MM-DD (CST/CDT). */
export function chicagoDate(tsMs: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CHICAGO_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(tsMs));
}

/** Previous complete America/Chicago day (the usual payout window). */
export function previousChicagoDate(nowMs: number = Date.now()): string {
  const today = chicagoDate(nowMs);
  const [y, m, d] = today.split("-").map(Number);
  // 18:00 UTC is always noon-ish in Chicago (12:00 CST / 13:00 CDT) on that calendar date.
  return chicagoDate(Date.UTC(y, m - 1, d, 18, 0, 0) - 86_400_000);
}

/** FeeMath.splitTradeFee: 33/33/33, residual (= 1) to referral. */
export function splitTradeFee(feeAmount: number): { creator: number; lpLock: number; treasury: number; referral: number } {
  if (!(feeAmount > 0) || !Number.isFinite(feeAmount)) return { creator: 0, lpLock: 0, treasury: 0, referral: 0 };
  const creator = feeAmount * FEE_SHARE_CREATOR / FEE_SHARE_DENOM;
  const lpLock = feeAmount * FEE_SHARE_LP_LOCK / FEE_SHARE_DENOM;
  const treasury = feeAmount * FEE_SHARE_TREASURY / FEE_SHARE_DENOM;
  return { creator, lpLock, treasury, referral: feeAmount - creator - lpLock - treasury };
}

export function protocolFee(notional: number): number {
  if (!(notional > 0) || !Number.isFinite(notional)) return 0;
  return notional * TRADE_FEE_BPS / BPS_DENOM;
}

/** 1% residual of the 1% trade fee (~$0.01 on a $100 trade). */
export function referralSliceFromNotional(notionalUsd: number): number {
  return splitTradeFee(protocolFee(notionalUsd)).referral;
}

export type TradeFeeRoutedArgs = {
  token: string;
  feeToken: string;
  trader: string;
  feeIsQuote: boolean;
  creatorShare: bigint;
  lpShare: bigint;
  treasuryShare: bigint;
  referralShare: bigint;
  referralPayee?: string;
};

export type FeeLog = { tx: string; args: TradeFeeRoutedArgs };

/** Same queueing idea as lib/trades usdgIndex: n-th Trade of (tx, token, trader) takes the n-th TradeFeeRouted. */
export const feeKey = (tx: string, token: string, trader: string) => `${tx.toLowerCase()}:${token.toLowerCase()}:${trader.toLowerCase()}`;
export function feeIndex(logs: FeeLog[]): Map<string, TradeFeeRoutedArgs[]> {
  const m = new Map<string, TradeFeeRoutedArgs[]>();
  for (const l of logs) {
    const k = feeKey(l.tx, l.args.token, l.args.trader);
    (m.get(k) ?? m.set(k, []).get(k)!).push(l.args);
  }
  return m;
}

export type SliceNote = "post-grad buy fee in coin, valued at fill price" | undefined;
export type Slice = { amountUsdg: number; note?: SliceNote; source: "event" | "fill" };

function notionalUsd(f: Fill): number {
  const v = playerUsd(f);
  if (v > 0) return v;
  return Number.isFinite(f.usd) && f.usd > 0 ? f.usd : 0;
}

function asNum(x: bigint | number | string | undefined): number {
  if (x === undefined) return 0;
  const n = typeof x === "bigint" ? Number(x) : Number(x);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Pure: one fill (+ optional TradeFeeRouted) → referral-slice USDG. Returns null only when there is no
 * positive notional / fee to split (the caller still decides "no referrer ⇒ no row").
 */
export function referralSliceFromFill(
  f: Fill,
  ev?: TradeFeeRoutedArgs,
  o: { usdg?: string; usdgDecimals?: number } = {},
): Slice | null {
  if (ev) {
    const feeRaw = asNum(ev.creatorShare) + asNum(ev.lpShare) + asNum(ev.treasuryShare) + asNum(ev.referralShare);
    if (feeRaw > 0) {
      const sliceRaw = splitTradeFee(feeRaw).referral;
      if (!ev.feeIsQuote) {
        const tokens = sliceRaw / 10 ** COIN_DECIMALS;
        const px = f.priceUsd;
        if (px > 0 && Number.isFinite(px)) {
          return { amountUsdg: tokens * px, note: "post-grad buy fee in coin, valued at fill price", source: "event" };
        }
      } else if (o.usdg && isUsdg(ev.feeToken, { usdg: o.usdg as Address })) {
        const dec = o.usdgDecimals ?? usdgDecimals();
        return { amountUsdg: usdgRawToUsd(BigInt(Math.round(sliceRaw)), dec), source: "event" };
      } else {
        // Quote-side fee in a non-USDG token (or USDG address not passed): scale the residual by the fill's $.
        const n = notionalUsd(f);
        if (n > 0) return { amountUsdg: referralSliceFromNotional(n), source: "event" };
      }
    }
  }
  // Fallback / no event: hook buys take the 1% fee in the coin (DiscipleHook afterSwap, output side).
  if (f.venue === "hook" && f.side === "buy" && f.priceUsd > 0 && f.tokens > 0) {
    const feeTokens = f.tokens * TRADE_FEE_BPS / (BPS_DENOM - TRADE_FEE_BPS); // net = 99% of gross
    const sliceTokens = splitTradeFee(feeTokens).referral;
    return { amountUsdg: sliceTokens * f.priceUsd, note: "post-grad buy fee in coin, valued at fill price", source: "fill" };
  }
  const n = notionalUsd(f);
  if (!(n > 0)) return null;
  return { amountUsdg: referralSliceFromNotional(n), source: "fill" };
}

export type ReferralRow = {
  /** Fill id (`tx:logIndex`) — idempotency key */
  id: string;
  ts: number;
  /** America/Chicago YYYY-MM-DD */
  date: string;
  referrer: string;
  friend: string;
  amountUsdg: number;
  note?: SliceNote;
};

export type LedgerStore = Pick<Kv, "setNX" | "zadd" | "zrange" | "zrem" | "get" | "set">;
export type LedgerDeps = {
  store?: LedgerStore;
  referrerOf?: (friend: string) => Promise<string | null>;
  usernameOf?: (wallet: string) => Promise<string | null>;
  usdg?: string;
  usdgDecimals?: number;
};

function storeOf(d?: LedgerDeps): LedgerStore {
  return d?.store ?? kv();
}

const registryAbi = parseAbi(["function referrerOf(address) view returns (address)"]);

/**
 * On-chain ReferralRegistry.referrerOf reader. NOT used for the payout sheet any more (that uses the account bind,
 * see defaultReferrerOf). Kept so the on-chain registry path stays in the repo; pass it as LedgerDeps.referrerOf
 * to get the old behavior.
 */
export async function registryReferrerOf(friend: string, s: LedgerStore): Promise<string | null> {
  const addr = lc(friend);
  if (isZero(addr)) return null;
  const cached = await s.get(REF.of(addr));
  if (cached && !isZero(cached)) return lc(cached);
  const d = deployment();
  if (isZero(d.referralRegistry)) return null;
  try {
    const ref = await serverPc().readContract({
      address: d.referralRegistry,
      abi: registryAbi,
      functionName: "referrerOf",
      args: [addr as Address],
    });
    const v = String(ref).toLowerCase();
    if (isZero(v)) return null;
    await s.set(REF.of(addr), v);
    return v;
  } catch {
    // Leave unseen / dirty so a later pass retries. Never cache a failed read as "no referrer".
    throw new Error("referrerOf failed");
  }
}

/** Payout sheet referrer: the referrer saved to the trader's account at sign-in (account referral bind). */
async function defaultReferrerOf(friend: string, s: LedgerStore): Promise<string | null> {
  const addr = lc(friend);
  if (isZero(addr)) return null;
  return accountReferrerOf(addr, s);
}

/** Queue fills for a later drain (called from storeFills). Cheap; no RPC. */
export async function markReferralDirty(fills: Fill[], d: LedgerDeps = {}): Promise<void> {
  if (!fills.length) return;
  const s = storeOf(d);
  await s.zadd(REF.dirty(), fills.map((f) => ({ score: f.ts, member: JSON.stringify(f) })));
}

export type RecordResult = { recorded: number; skipped: number; noReferrer: number; failed: number };
export type DirtyFill = { fill: Fill; dirtyMember: string };

/**
 * Write one ledger row per fill whose trader has a saved account referrer. Idempotent via referral:seen:<fillId>.
 * A fill with no referrer is marked seen (and dropped from dirty) so a later attribution is not
 * back-applied to a trade that happened before the account bind (same idea as on-chain trade-time referrerOf).
 * A referrerOf failure leaves the fill unseen / dirty for retry (setNX happens only after a
 * successful resolve, so a failed read is never stuck as "already counted").
 */
export async function recordReferralSlices(
  fills: Fill[] | DirtyFill[],
  fees?: Map<string, TradeFeeRoutedArgs[]>,
  d: LedgerDeps = {},
): Promise<RecordResult> {
  const out: RecordResult = { recorded: 0, skipped: 0, noReferrer: 0, failed: 0 };
  if (!fills.length) return out;
  const items: DirtyFill[] = (fills as (Fill | DirtyFill)[]).map((x) =>
    (x as DirtyFill).fill ? (x as DirtyFill) : { fill: x as Fill, dirtyMember: JSON.stringify(x) },
  );
  const s = storeOf(d);
  const resolve = d.referrerOf ?? ((friend: string) => defaultReferrerOf(friend, s));
  const usdgOpts = { usdg: d.usdg ?? (deployment().usdg as string), usdgDecimals: d.usdgDecimals ?? usdgDecimals() };
  const rows: { score: number; member: string }[] = [];
  const doneMembers: string[] = [];
  for (const { fill: f, dirtyMember } of items) {
    const id = f.id;
    try {
      let ref: string | null;
      try { ref = await resolve(f.trader); } catch { out.failed++; continue; }
      if (!(await s.setNX(REF.seen(id), "1"))) { out.skipped++; doneMembers.push(dirtyMember); continue; }
      let ev: TradeFeeRoutedArgs | undefined;
      if (fees) ev = fees.get(feeKey(f.tx, f.coin, f.trader))?.shift();
      const slice = referralSliceFromFill(f, ev, usdgOpts);
      if (!ref || isZero(ref)) { out.noReferrer++; doneMembers.push(dirtyMember); continue; }
      if (!slice || !(slice.amountUsdg > 0)) { out.skipped++; doneMembers.push(dirtyMember); continue; }
      const row: ReferralRow = {
        id,
        ts: f.ts,
        date: chicagoDate(f.ts),
        referrer: lc(ref),
        friend: lc(f.trader),
        amountUsdg: slice.amountUsdg,
        ...(slice.note ? { note: slice.note } : {}),
      };
      rows.push({ score: f.ts, member: JSON.stringify(row) });
      doneMembers.push(dirtyMember);
      out.recorded++;
    } catch {
      out.failed++;
    }
  }
  if (rows.length) await s.zadd(REF.rows(), rows);
  if (doneMembers.length) await s.zrem(REF.dirty(), ...doneMembers);
  return out;
}

/** Drain the dirty queue (CSV / cron path). fee events are not re-fetched; amounts use the fill fallback. */
export async function processReferralDirty(d: LedgerDeps = {}, limit = 50_000): Promise<RecordResult> {
  const s = storeOf(d);
  const raw = await s.zrange(REF.dirty(), limit);
  const items: DirtyFill[] = [];
  for (const m of raw) {
    try { items.push({ fill: JSON.parse(m) as Fill, dirtyMember: m }); }
    catch { await s.zrem(REF.dirty(), m); }
  }
  return recordReferralSlices(items, undefined, d);
}

export async function loadReferralRows(d: LedgerDeps = {}, limit = 1_000_000): Promise<ReferralRow[]> {
  const raw = await storeOf(d).zrange(REF.rows(), limit);
  const rows: ReferralRow[] = [];
  for (const m of raw) {
    try { rows.push(JSON.parse(m) as ReferralRow); } catch { /* skip bad */ }
  }
  return rows;
}

export function formatUsdg(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0.00000000";
  return (Math.round(n * 1e8) / 1e8).toFixed(8);
}

export function csvField(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const SUMMARY_HEADER = "date,referrer address,referrer username,friends count,total referral-slice USDG";
export const DETAIL_HEADER = "date,referrer address,referrer username,friend address,friend username,trades count,total referral-slice USDG,notes";

export type PayoutCsv = { date: string; summary: string; detail: string; referrers: number; rows: number };

export function buildPayoutCsv(
  date: string,
  rows: ReferralRow[],
  usernames: Record<string, string | null | undefined> = {},
): PayoutCsv {
  const day = rows.filter((r) => r.date === date);
  type Agg = { amount: number; friends: Set<string>; notes: Set<string> };
  const byRef = new Map<string, Agg>();
  type Pair = { amount: number; trades: number; notes: Set<string> };
  const byPair = new Map<string, Pair>();
  for (const r of day) {
    const a = byRef.get(r.referrer) ?? { amount: 0, friends: new Set(), notes: new Set() };
    a.amount += r.amountUsdg;
    a.friends.add(r.friend);
    if (r.note) a.notes.add(r.note);
    byRef.set(r.referrer, a);
    const pk = `${r.referrer}|${r.friend}`;
    const p = byPair.get(pk) ?? { amount: 0, trades: 0, notes: new Set() };
    p.amount += r.amountUsdg;
    p.trades++;
    if (r.note) p.notes.add(r.note);
    byPair.set(pk, p);
  }
  const name = (w: string) => usernames[w] ?? "";
  const refs = Array.from(byRef.keys()).sort();
  const summaryLines = [SUMMARY_HEADER];
  for (const r of refs) {
    const a = byRef.get(r)!;
    summaryLines.push([date, r, csvField(name(r)), a.friends.size, formatUsdg(a.amount)].join(","));
  }
  const detailLines = [DETAIL_HEADER];
  const pairs = Array.from(byPair.keys()).sort();
  for (const pk of pairs) {
    const [ref, friend] = pk.split("|");
    const p = byPair.get(pk)!;
    const notes = Array.from(p.notes).sort().join("; ");
    detailLines.push([date, ref, csvField(name(ref)), friend, csvField(name(friend)), p.trades, formatUsdg(p.amount), csvField(notes)].join(","));
  }
  return { date, summary: summaryLines.join("\n") + "\n", detail: detailLines.join("\n") + "\n", referrers: refs.length, rows: day.length };
}

export async function payoutCsvForDate(date: string, d: LedgerDeps = {}): Promise<PayoutCsv> {
  const rows = await loadReferralRows(d);
  const names: Record<string, string | null | undefined> = {};
  const resolve = d.usernameOf ?? ((w: string) => usernameOfWallet(w));
  const addrs = new Set<string>();
  for (const r of rows) {
    if (r.date !== date) continue;
    addrs.add(r.referrer);
    addrs.add(r.friend);
  }
  for (const a of addrs) {
    try { names[a] = await resolve(a); } catch { names[a] = ""; }
  }
  return buildPayoutCsv(date, rows, names);
}
