import "server-only";
/**
 * XP ledger + missions engine (spec "Missions and XP"). Rules live in lib/xp.ts; the pure mission evaluator is
 * lib/missionsEval.ts. Scored inside the achievements cron (lib/server/achievements.ts scoreWallet), so a wallet is
 * replayed from its full history every time it trades; nothing is self-reported.
 *
 * KV keys (chain-namespaced, like achievements):
 *   xp:<chain>:l:<wallet>          zset  score=ts, member=LedgerRow JSON      append-only ledger
 *   xp:<chain>:once:<src>:<wallet> SET NX                                     write-once guard: a source pays once ever
 *   xp:<chain>:m:<wallet>          JSON  { at, periods: { <period id>: { <mission id>: { progress, target, doneAt? } } } }
 *   xp:<chain>:owned:<wallet>      set   shop part ids
 *   xp:<chain>:lock:<wallet>       short lock around spend / prestige
 *   xp:<chain>:timers              zset  member `${wallet}|${dueMs}`: re-score then (a 24h hold finishes with no trade)
 * Total XP = sum of positive rows. XP to spend = sum of all rows (purchases are negative). Prestige = prestige rows.
 */
import { randomUUID } from "node:crypto";
import { ACTIVE_CHAIN } from "@/lib/chains";
import { evaluateDrafts, evaluateMissions, type CoinFill, type MissionCoin, type MissionFill } from "@/lib/missionsEval";
import { partById } from "@/lib/parts";
import { playerUsd, type Fill } from "@/lib/trades";
import { V1_RULES, type AchievementUnlockRecord } from "@/lib/achievements";
import {
  DRAFT, FREE_PLAY_XP, dayPeriod, levelInfo, milestoneXp, MILESTONE_COPY, missionsFor, weekPeriod, MAX_PRESTIGE,
  type DraftClaim, type MissionStatus, type Period, type XpSummary,
} from "@/lib/xp";
import { kv, type Kv } from "./kv";
import { ACH } from "./achKeys";

const ns = () => `xp:${ACTIVE_CHAIN.id}`;
export const XPK = {
  ledger: (w: string) => `${ns()}:l:${w.toLowerCase()}`,
  once: (src: string, w: string) => `${ns()}:once:${src}:${w.toLowerCase()}`,
  missions: (w: string) => `${ns()}:m:${w.toLowerCase()}`,
  owned: (w: string) => `${ns()}:owned:${w.toLowerCase()}`,
  /** JSON { cursor, outs: TransferOut[] }: plain token transfers away from the wallet, scanned so far */
  // tx2: rescan from the first fill (the v1 scan skipped every transfer in a tx that held a trade, batched transfers included)
  transfers: (w: string, coin: string) => `${ns()}:tx2:${w.toLowerCase()}:${coin.toLowerCase()}`,
  lock: (w: string) => `${ns()}:lock:${w.toLowerCase()}`,
  timers: () => `${ns()}:timers`,
  /** zset score=at ms, member=DraftClaim JSON: drafting slingshots reported by the game, paid by the cron once checked */
  drafts: (w: string) => `${ns()}:draft:${w.toLowerCase()}`,
};
/** Nonce prefix for the signed shop / prestige requests (lib/server/nonces). */
export const XP_NONCE_PREFIX = "xp:nonce";

/** Ledger rows read per wallet (a daily player writes ~10 a day; this is years of play). */
const LEDGER_MAX = 20_000;

export type LedgerKind = "mission" | "milestone" | "buy" | "prestige" | "draft" | "freeplay";
export interface LedgerRow { src: string; kind: LedgerKind; xp: number; label: string; ts: number }

const parse = <T>(s: string | null): T | null => { if (!s) return null; try { return JSON.parse(s) as T; } catch { return null; } };

/* ------------------------------------------------------- ledger ------------------------------------------------------- */

/** Write one row, once ever per (src, wallet). true if it was written now. */
export async function award(w: string, row: LedgerRow, s: Kv = kv()): Promise<boolean> {
  if (!(await s.setNX(XPK.once(row.src, w), String(row.ts)))) return false;
  await s.zadd(XPK.ledger(w), [{ score: row.ts, member: JSON.stringify(row) }]);
  return true;
}

export async function ledgerOf(w: string, s: Kv = kv()): Promise<LedgerRow[]> {
  const seen = new Set<string>();
  return (await s.zrange(XPK.ledger(w), LEDGER_MAX)).map((m) => parse<LedgerRow>(m)).filter((r): r is LedgerRow => !!r && typeof r.xp === "number" && !seen.has(r.src) && (seen.add(r.src), true));
}

/** Pure (tests): the two numbers + prestige from ledger rows. */
export function totals(rows: readonly LedgerRow[]) {
  let total = 0, spendable = 0, prestige = 0;
  for (const r of rows) { if (r.xp > 0) total += r.xp; spendable += r.xp; if (r.kind === "prestige") prestige++; }
  return { total, spendable: Math.max(0, spendable), prestige: Math.min(prestige, MAX_PRESTIGE) };
}

/* ------------------------------------------------------ scoring ------------------------------------------------------- */

/** Tokens a wallet sent away by plain transfer (not a trade). */
export interface TransferOut { coin: string; tx: string; block: number; logIndex: number; ts: number; tokens: number;
  /** true: matched against the wallet's fills in its tx when scanned (kept as is); unset: re-matched once the tx's fills are indexed */
  checked?: boolean }

export interface XpCoinMeta { creator: string; anon: boolean; mode?: number; launch: { ts: number }; grad?: { ts: number; block: number; logIndex: number } }

const toMissionFill = (f: Fill): MissionFill => ({
  coin: f.coin.toLowerCase(), ts: f.ts, block: f.block, logIndex: f.logIndex, side: f.side, tokens: f.tokens, usd: playerUsd(f),
  impactBps: typeof f.impactBps === "number" ? Math.abs(f.impactBps) : undefined, mcapUsd: f.mcapUsd,
});

/** Missions that depend on still holding the tokens: not paid while transfers out couldn't be checked. */
const HOLDING_KINDS = new Set(["hold_24h", "hold_1h", "ride_tier", "orbit_aboard", "drop_bomb", "hold_bomb", "cash_out_higher"]);

/** How many recent trades per coin the cron loads for `coinFills`; fewer than this = the coin's whole history (first_crew). */
export const COIN_FILLS_LIMIT = 1000;

/** The periods a cron pass settles: this day and week, plus the previous ones (a pass that runs just after a reset). */
export const periodsAt = (now: number): Period[] => [dayPeriod(now), dayPeriod(now - 86_400_000), weekPeriod(now), weekPeriod(now - 7 * 86_400_000)];

/**
 * Score one wallet's XP from its full history (called from scoreWallet with what it already loaded).
 * Milestones: every achievement unlock pays once. Missions: settle the current + previous periods, pay finished ones
 * once, store progress for the API. `coinFills` = every trader's recent fills per coin (ride_tier).
 */
export async function scoreXp(
  walletIn: string,
  ctx: { fills: readonly Fill[]; outs?: readonly TransferOut[]; holdsUnverified?: boolean; metas: ReadonlyMap<string, XpCoinMeta>; unlocks: readonly AchievementUnlockRecord[]; coinFills?: ReadonlyMap<string, readonly Fill[]> },
  o: { now?: number; s?: Kv; dryRun?: boolean } = {},
): Promise<{ awarded: { src: string; xp: number }[] }> {
  const s = o.s ?? kv(), w = walletIn.toLowerCase(), now = o.now ?? Date.now();
  const awarded: { src: string; xp: number }[] = [];
  const pay = async (row: LedgerRow) => { if (o.dryRun || (await award(w, row, s))) awarded.push({ src: row.src, xp: row.xp }); };

  for (const u of ctx.unlocks) {
    const rule = V1_RULES.find((r) => r.id === u.id);
    if (rule) await pay({ src: `a:${u.id}`, kind: "milestone", xp: milestoneXp(u.id, rule.rarity), label: MILESTONE_COPY[u.id]?.name ?? rule.name, ts: u.ts });
  }

  const coins = new Map<string, MissionCoin>();
  for (const [c, m] of Array.from(ctx.metas.entries())) coins.set(c.toLowerCase(), { creator: m.creator, anon: m.anon, mode: m.mode, launchTs: m.launch.ts, grad: m.grad });
  const coinFills = new Map<string, CoinFill[]>(), coinFillsComplete = new Set<string>();
  for (const [c, fs] of Array.from(ctx.coinFills?.entries() ?? [])) {
    coinFills.set(c.toLowerCase(), fs.map((f) => ({ ts: f.ts, mcapUsd: f.mcapUsd, trader: f.trader, side: f.side, usd: playerUsd(f), impactBps: typeof f.impactBps === "number" ? Math.abs(f.impactBps) : undefined, block: f.block, logIndex: f.logIndex })));
    if (fs.length < COIN_FILLS_LIMIT) coinFillsComplete.add(c.toLowerCase());
  }
  const fills: MissionFill[] = [
    ...ctx.fills.map(toMissionFill),
    ...(ctx.outs ?? []).map((t): MissionFill => ({ coin: t.coin.toLowerCase(), ts: t.ts, block: t.block, logIndex: t.logIndex, side: "out", tokens: t.tokens, usd: 0 })),
  ];
  const input = { wallet: w, fills, coins, coinFills, coinFillsComplete, now, asOf: now };

  const stored: Record<string, Record<string, { progress: number; target: number; doneAt?: number }>> = {};
  let recheck: number | undefined;
  for (const p of periodsAt(now)) {
    const ms = missionsFor(p);
    const r = evaluateMissions({ ...input, now: Math.min(now, p.end - 1), asOf: now }, p, ms);
    stored[p.id] = r.results;
    if (r.recheckAt !== undefined && (recheck === undefined || r.recheckAt < recheck)) recheck = r.recheckAt;
    for (const m of ms) {
      const res = r.results[m.id];
      if (res?.doneAt !== undefined && !(ctx.holdsUnverified && HOLDING_KINDS.has(m.kind))) await pay({ src: `m:${p.id}:${m.id}`, kind: "mission", xp: m.xp, label: m.title, ts: res.doneAt });
    }
  }
  // drafting slingshots (lib/xp DRAFT): checked against the fills, at most DRAFT.perDay paid per day (src index 0..perDay-1)
  const claims = (await s.zrange(XPK.drafts(w), 500, true)).map((m) => parse<DraftClaim>(m)).filter((c): c is DraftClaim => !!c && typeof c.at === "number" && typeof c.coin === "string" && Array.isArray(c.wingmen));
  if (claims.length) {
    const cf = new Map<string, { ts: number; trader: string; side: string }[]>();
    for (const [c, fs] of Array.from(ctx.coinFills?.entries() ?? [])) cf.set(c.toLowerCase(), fs.map((f) => ({ ts: f.ts, trader: f.trader, side: f.side })));
    for (const p of [dayPeriod(now), dayPeriod(now - 86_400_000)]) {
      const ok = evaluateDrafts({ wallet: w, fills, coinFills: cf, claims, asOf: now }, p);
      for (let i = 0; i < ok.length; i++) await pay({ src: `draft:${p.id}:${i}`, kind: "draft", xp: DRAFT.xp, label: "Drafting slingshot", ts: ok[i].at });
    }
  }
  if (!o.dryRun) {
    await s.set(XPK.missions(w), JSON.stringify({ at: now, periods: stored }));
    if (recheck !== undefined) await s.zadd(XPK.timers(), [{ score: recheck, member: `${w}|${recheck}` }]);
  }
  return { awarded };
}

/** Wallets whose timer is due (a 24h hold finished): returned for the cron to mark dirty, and removed. */
export async function dueTimers(now = Date.now(), s: Kv = kv()): Promise<string[]> {
  const members = await s.zrange(XPK.timers(), 500);
  const due = members.filter((m) => Number(m.split("|")[1]) <= now);
  if (due.length) await s.zrem(XPK.timers(), ...due);
  return Array.from(new Set(due.map((m) => m.split("|")[0]).filter((x) => /^0x[0-9a-f]{40}$/.test(x))));
}

/* ------------------------------------------------------- reads -------------------------------------------------------- */

export async function ownedOf(w: string, s: Kv = kv()): Promise<string[]> { return s.smembers(XPK.owned(w)); }

/** GET /api/xp body. KV only. */
export async function xpSummary(walletIn: string, now = Date.now(), s: Kv = kv()): Promise<XpSummary> {
  const w = walletIn.toLowerCase();
  const [rows, owned, m] = await Promise.all([ledgerOf(w, s), ownedOf(w, s), s.get(XPK.missions(w)).then((x) => parse<{ at: number; periods: Record<string, Record<string, { progress: number; target: number; doneAt?: number }>> }>(x))]);
  const t = totals(rows);
  const paid = new Set(rows.map((r) => r.src));
  const view = (p: Period) => ({
    period: p.id, resetsAt: p.end,
    missions: missionsFor(p).map((d): MissionStatus => {
      const r = m?.periods?.[p.id]?.[d.id];
      const done = paid.has(`m:${p.id}:${d.id}`);
      return { id: d.id, title: d.title, xp: d.xp, target: d.target, progress: done ? d.target : Math.min(d.target, r?.progress ?? 0), done };
    }),
  });
  return {
    wallet: w, totalXp: t.total, spendableXp: t.spendable, level: levelInfo(t.total, t.prestige),
    daily: view(dayPeriod(now)), weekly: view(weekPeriod(now)), owned,
    weekXp: rows.reduce((a, r) => (r.xp > 0 && r.ts >= weekPeriod(now).start ? a + r.xp : a), 0),
    recent: rows.filter((r) => r.xp !== 0).sort((a, b) => b.ts - a.ts).slice(0, 20).map((r) => ({ label: r.label, xp: r.xp, ts: r.ts })),
    evaluatedAt: m?.at ?? null,
  };
}

/* ------------------------------------------------------ writes -------------------------------------------------------- */

async function withLock<T>(w: string, s: Kv, f: () => Promise<T>): Promise<T | { ok: false; reason: string }> {
  const token = randomUUID();
  if (!(await s.setNX(XPK.lock(w), token, 10))) return { ok: false, reason: "Busy, try again." };
  try { return await f(); } finally { await s.delIfEq(XPK.lock(w), token).catch(() => {}); }
}

export type BuyResult = { ok: true; part: string; spendableXp: number } | { ok: false; reason: string };

/** Spend XP on a part. Checks the catalogue price, prestige lock, ownership and balance under a per-wallet lock. */
export async function buyPart(walletIn: string, partId: string, now = Date.now(), s: Kv = kv()): Promise<BuyResult> {
  const w = walletIn.toLowerCase();
  const part = partById(partId);
  if (!part) return { ok: false, reason: "That part doesn't exist." };
  if (part.cost <= 0) return { ok: false, reason: "That part is free." };
  return withLock(w, s, async (): Promise<BuyResult> => {
    if (await s.get(XPK.once(`buy:${part.id}`, w))) return { ok: false, reason: "You already own that part." };
    const t = totals(await ledgerOf(w, s));
    if ((part.minPrestige ?? 0) > t.prestige) return { ok: false, reason: `Unlocks at prestige ${part.minPrestige}.` };
    if (t.spendable < part.cost) return { ok: false, reason: `You need ${(part.cost - t.spendable).toLocaleString("en-US")} more XP.` };
    if (!(await award(w, { src: `buy:${part.id}`, kind: "buy", xp: -part.cost, label: part.name, ts: now }, s))) return { ok: false, reason: "You already own that part." };
    await s.sadd(XPK.owned(w), part.id);
    return { ok: true, part: part.id, spendableXp: t.spendable - part.cost };
  }) as Promise<BuyResult>;
}

export type PrestigeResult = { ok: true; prestige: number } | { ok: false; reason: string };

export async function prestigeUp(walletIn: string, now = Date.now(), s: Kv = kv()): Promise<PrestigeResult> {
  const w = walletIn.toLowerCase();
  return withLock(w, s, async (): Promise<PrestigeResult> => {
    const t = totals(await ledgerOf(w, s));
    if (!levelInfo(t.total, t.prestige).canPrestige) return { ok: false, reason: "Reach level 50 to prestige." };
    const next = t.prestige + 1;
    if (!(await award(w, { src: `prestige:${next}`, kind: "prestige", xp: 0, label: `Prestige ${next}`, ts: now }, s))) return { ok: false, reason: "Already done." };
    return { ok: true, prestige: next };
  }) as Promise<PrestigeResult>;
}

/* ------------------------------------------------------ drafting ------------------------------------------------------ */

export type DraftQueueResult = { ok: true; paidToday: number; queuedToday: number; capped: boolean } | { ok: false; reason: string };

/** Queue one reported slingshot for the cron (POST /api/xp/draft). Stored as is; scoreXp checks it against the fills. */
export async function queueDraft(walletIn: string, claim: DraftClaim, now = Date.now(), s: Kv = kv()): Promise<DraftQueueResult> {
  const w = walletIn.toLowerCase(), day = dayPeriod(now);
  const paidToday = (await ledgerOf(w, s)).filter((r) => r.kind === "draft" && r.src.startsWith(`draft:${day.id}:`)).length;
  const recent = (await s.zrange(XPK.drafts(w), 200, true)).map((m) => parse<DraftClaim>(m)).filter((c): c is DraftClaim => !!c && c.at >= day.start);
  // keep the queue bounded: a day never needs more than a few times the paid cap
  if (paidToday >= DRAFT.perDay || recent.length >= DRAFT.perDay * 4) return { ok: true, paidToday, queuedToday: recent.length, capped: true };
  if (recent.some((c) => Math.abs(c.at - claim.at) < DRAFT.minGapMs)) return { ok: false, reason: "Too soon after the last slingshot." };
  await s.zadd(XPK.drafts(w), [{ score: claim.at, member: JSON.stringify(claim) }]);
  await s.zadd(ACH.dirty(), [{ score: now, member: `${w}|draft:${claim.at}` }]);   // the cron re-scores this wallet on its next pass
  return { ok: true, paidToday, queuedToday: recent.length + 1, capped: false };
}

/* ------------------------------------------------------ free play ----------------------------------------------------- */

export type FreePlayAward = { ok: true; xp: number; already: boolean; paidToday: number; capped: boolean; totalXp: number; level: ReturnType<typeof levelInfo> } | { ok: false; reason: string };

/**
 * Pay one server-verified Free play run (lib/xp FREE_PLAY_XP): once ever per `src`, and never past the daily cap across
 * all Free play rows (a run that lands on a nearly full day pays what is left). A run that would pay 0 writes nothing.
 */
export async function awardFreePlay(walletIn: string, src: string, xp: number, label: string, now = Date.now(), s: Kv = kv()): Promise<FreePlayAward> {
  const w = walletIn.toLowerCase(), day = dayPeriod(now);
  const r = await withLock(w, s, async (): Promise<FreePlayAward> => {
    const rows = await ledgerOf(w, s);
    const today = rows.filter((x) => x.kind === "freeplay" && x.ts >= day.start && x.ts < day.end), paidToday = today.reduce((a, x) => a + x.xp, 0);
    const done = (already: boolean, paid: number, all: LedgerRow[]) => { const t = totals(all);
      return { ok: true as const, xp: paid, already, paidToday: paidToday + paid, capped: paidToday + paid >= FREE_PLAY_XP.perDay, totalXp: t.total, level: levelInfo(t.total, t.prestige) }; };
    if (rows.some((x) => x.src === src)) return done(true, 0, rows);
    const pay = Math.max(0, Math.min(Math.floor(xp), FREE_PLAY_XP.perDay - paidToday));
    // nothing to pay (never boarded, or the day is full): write nothing. Rows only ever carry XP, so a wallet adds at most
    // a handful a day (the cap over the smallest payment, and rowsPerDay at worst) and can't grow its ledger past the read limit
    if (pay <= 0 || today.length >= FREE_PLAY_XP.rowsPerDay) return done(false, 0, rows);
    const row: LedgerRow = { src, kind: "freeplay", xp: pay, label, ts: now };
    if (!(await award(w, row, s))) return done(true, 0, rows);
    return done(false, pay, [...rows, row]);
  });
  return r;
}
/** a pilot's level (for the challenge page and the board) */
export async function levelOfWallet(walletIn: string, s: Kv = kv()) { const t = totals(await ledgerOf(walletIn.toLowerCase(), s)); return levelInfo(t.total, t.prestige); }
