/**
 * Crew flights (main mode hook loop, maker 2026-11-13, mockup board "Crew flights"). Pure, fills-only.
 * A crew is a guild (lib/guilds). "Aboard together" = you and a crewmate each holding $5+ of cost (lib/streaks
 * heldIntervals) at the same time, so dust buys never count. The crew page shows who is aboard, never sizes, entry
 * prices or when anyone bought.
 */
import { heldIntervals, type StreakFill } from "./streaks";
import { ORBIT_MCAP, type LogFill } from "./logbook";

export const CREW_RULES = { missionCrew: 3, missionMs: 3600_000, missionXp: 400 } as const;

type Iv = [number, number];
const overlap = (a: Iv, b: Iv): Iv | null => { const s = Math.max(a[0], b[0]), e = Math.min(a[1], b[1]); return e > s ? [s, e] : null; };

/** each trader's $5+ hold intervals on one rocket */
export function holdsByTrader(fills: readonly LogFill[], only?: ReadonlySet<string>): Map<string, Iv[]> {
  const by = new Map<string, StreakFill[]>();
  for (const f of fills) {
    const t = f.trader.toLowerCase();
    if (only && !only.has(t)) continue;
    let a = by.get(t); if (!a) by.set(t, (a = []));
    a.push({ ts: f.ts, block: f.block, logIndex: f.logIndex, side: f.side, tokens: f.tokens, usd: f.usd });
  }
  const out = new Map<string, Iv[]>();
  for (const [t, fs] of by) { const iv = heldIntervals(fs); if (iv.length) out.set(t, iv); }
  return out;
}

export interface CrewCoin {
  together: boolean;
  /** reached orbit while you and a crewmate were both aboard */
  orbit: boolean;
  /** longest stretch you and one crewmate were aboard together */
  longestMs: number;
  /** crewmates (you excluded) holding now */
  aboardNow: string[];
  /** most crew (you included) aboard together for a full hour inside [from, now) */
  missionBest: number;
}

/** One rocket, from your point of view: its fills (all traders), your crew (you excluded), and the week start. */
export function crewOnCoin(fills: readonly LogFill[], wallet: string, crew: ReadonlySet<string>, now: number, weekStart: number, graduated: boolean): CrewCoin {
  const w = wallet.toLowerCase();
  const holds = holdsByTrader(fills, new Set([w, ...crew]));
  const mine = (holds.get(w) ?? []).map(([a, b]): Iv => [a, Math.min(b, now)]);
  const orbitAt = graduated ? fills.filter((f) => (f.mcapUsd ?? 0) >= ORBIT_MCAP).reduce((m, f) => Math.min(m, f.ts), Infinity) : Infinity;
  let together = false, orbit = false, longestMs = 0;
  const aboardNow: string[] = [];
  for (const [t, ivs] of holds) {
    if (t === w) continue;
    if (ivs.some(([, b]) => b > now)) aboardNow.push(t);
    for (const a of mine) for (const b0 of ivs) {
      const o = overlap(a, [b0[0], Math.min(b0[1], now)]);
      if (!o) continue;
      together = true; longestMs = Math.max(longestMs, o[1] - o[0]);
      if (orbitAt >= o[0] && orbitAt < o[1]) orbit = true;
    }
  }
  return { together, orbit, longestMs, aboardNow, missionBest: missionBest(mine, holds, w, now, weekStart) };
}

/** Sweep: the largest crew (you included) that sat aboard together for a full CREW_RULES.missionMs this week. */
function missionBest(mine: Iv[], holds: Map<string, Iv[]>, w: string, now: number, weekStart: number): number {
  let best = 0;
  for (const m of mine) {
    const win = overlap(m, [weekStart, now]);
    if (!win) continue;
    best = Math.max(best, 1);
    // candidate starts: every interval start inside the window; check who covers [s, s + missionMs)
    const starts = new Set<number>([win[0]]);
    for (const [t, ivs] of holds) if (t !== w) for (const [a] of ivs) if (a > win[0] && a < win[1]) starts.add(a);
    for (const s of starts) {
      const e = s + CREW_RULES.missionMs;
      if (e > win[1]) continue;
      let n = 1;
      for (const [t, ivs] of holds) if (t !== w && ivs.some(([a, b]) => a <= s && Math.min(b, now) >= e)) n++;
      best = Math.max(best, n);
    }
  }
  return best;
}

export interface CrewRecord { together: number; orbits: number; longestMs: number }
export function crewRecord(rows: readonly CrewCoin[]): CrewRecord {
  return rows.reduce((r, c) => ({ together: r.together + (c.together ? 1 : 0), orbits: r.orbits + (c.orbit ? 1 : 0), longestMs: Math.max(r.longestMs, c.longestMs) }), { together: 0, orbits: 0, longestMs: 0 });
}

/** crewmates holding each rocket now (you excluded), from its recent fills: for the crew page and lobby cards */
export function crewAboardNow(fills: readonly LogFill[], crew: ReadonlySet<string>, now: number): string[] {
  const out: string[] = [];
  for (const [t, ivs] of holdsByTrader(fills, crew)) if (ivs.some(([, b]) => b > now)) out.push(t);
  return out;
}

/** "Fly with me" share path: /fly/<username>/<ticker> (app/fly/[user]/[coin] resolves it, newest rocket on a repeat) */
export const flyPath = (user: string, ticker: string) => `/fly/${encodeURIComponent(user.toLowerCase())}/${encodeURIComponent(ticker.toLowerCase())}`;

/** GET /api/crew body (lib/server/crew) */
export type CrewMate = { wallet: string; name: string | null };
export type CrewFlying = { coin: string; ticker: string; name: string; zone: string; mode?: number; graduated: boolean; aboard: CrewMate[]; count: number; you: boolean };
export type CrewPage = {
  crew: { id: string; tag: string; name: string; mark: string; members: number; since: number | null } | null;
  record: CrewRecord & { rank: number | null };
  flying: CrewFlying[];
  mission: { best: number; target: number; xp: number; done: boolean; resetsAt: number };
  username: string | null;
};
/** GET /api/fly body (lib/server/fly): never when anyone boarded or what they paid */
export type FlyView = { inviter: string; coin: string; ticker: string; name: string; zone: string; mode?: number; graduated: boolean; crew: { tag: string; aboard: number } | null };
