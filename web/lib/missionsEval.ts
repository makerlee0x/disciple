/**
 * Pure mission evaluator (no I/O; tested in scripts/test-xp.mts). Same replay model as lib/achievementsEval.ts: one
 * wallet's full fill history plus the coins' launch / graduation facts in, progress per mission out. Re-running over the
 * same history gives the same answer, so the cron can replay a wallet from scratch every time it changes.
 */
import { TIERS } from "./config";
import { DRAFT, FAIR, type DraftClaim, type MissionDef, type Period } from "./xp";

const DUST = 1e-9;

export interface MissionFill {
  coin: string; ts: number; block: number; logIndex: number;
  /** "out" = tokens sent away by a plain transfer (not a trade): counts as leaving the position, never as a dump or bomb */
  side: "buy" | "sell" | "out"; tokens: number;
  /** player $ */
  usd: number;
  impactBps?: number;
  /** $ mcap after the fill */
  mcapUsd?: number;
}
export interface MissionCoin {
  creator: string; anon: boolean;
  /** on-chain mode: 0 Trench (Expert), 1 Easy, 2 Hard; undefined = not read yet */
  mode?: number;
  launchTs: number;
  grad?: { ts: number; block: number; logIndex: number };
}
export interface MissionInput {
  wallet: string;
  /** this wallet's fills, any order */
  fills: readonly MissionFill[];
  coins: ReadonlyMap<string, MissionCoin>;
  /** every trader's fills per coin (ride_tier reads the coin's mcap path); coins without an entry use the wallet's fills */
  coinFills?: ReadonlyMap<string, readonly { ts: number; mcapUsd?: number }[]>;
  /** evaluation cutoff for this period (events after it don't count) */
  now: number;
  /** wall-clock time of this run (default `now`): a boost only counts once its wash window has fully passed by then */
  asOf?: number;
}
export interface MissionResult { progress: number; target: number; doneAt?: number }
export interface MissionsEval {
  results: Record<string, MissionResult>;
  /** earliest future time a mission could change with no new trade (a 24h hold, a boost leaving its wash window); the cron re-scores then */
  recheckAt?: number;
}

export const tierIndex = (mcap: number) => { let i = 0; for (let k = 0; k < TIERS.length; k++) if (mcap >= TIERS[k].lo) i = k; return i; };

const order = (a: MissionFill, b: MissionFill) => a.block - b.block || a.logIndex - b.logIndex || a.ts - b.ts;

interface Interval { start: number; end: number; startMcap?: number }

export function evaluateMissions(inp: MissionInput, period: Period, missions: readonly MissionDef[]): MissionsEval {
  const wallet = inp.wallet.toLowerCase();
  // a zero-value transfer can be emitted "from" anyone without approval: never let one touch a position
  const fills = [...inp.fills].filter((f) => f.side !== "out" || f.tokens > 0).sort(order);
  const inP = (ts: number) => ts >= period.start && ts < period.end && ts <= inp.now;
  const coin = (c: string) => inp.coins.get(c.toLowerCase());
  const mineLaunch = (c: string) => { const m = coin(c); return !!m && !m.anon && m.creator.toLowerCase() === wallet; };

  const asOf = inp.asOf ?? inp.now;
  let recheckAt: number | undefined;
  const recheck = (t: number) => { if (t > asOf && (recheckAt === undefined || t < recheckAt)) recheckAt = t; };

  // Qualifying boosts in the period: ≥ $5, not on a rocket you launched, and not sold or sent away within the wash
  // window. A boost whose window is still open doesn't count yet (XP is written once, so it must be final when paid).
  const boosts: MissionFill[] = [];
  for (let i = 0; i < fills.length; i++) {
    const f = fills[i];
    if (f.side !== "buy" || !inP(f.ts) || !(f.usd >= FAIR.minBoostUsd) || !coin(f.coin) || mineLaunch(f.coin)) continue;
    let washed = false;
    for (let j = i + 1; j < fills.length && fills[j].ts - f.ts <= FAIR.washMs; j++) if (fills[j].coin === f.coin && fills[j].side !== "buy") { washed = true; break; }
    if (washed) continue;
    if (f.ts + FAIR.washMs > asOf) { recheck(f.ts + FAIR.washMs + 1); continue; }
    boosts.push(f);
  }

  // Positions: holding intervals, the bomb hold clock and the 24h stay-aboard streak, per coin.
  type Pos = { tokens: number; basis: number; holdStart: number | null; streak: number | null; intervals: Interval[] };
  const pos = new Map<string, Pos>();
  const bombs: number[] = [];
  const holds: number[] = [];     // times a 24h streak completed
  for (const f of fills) {
    const p = pos.get(f.coin) ?? pos.set(f.coin, { tokens: 0, basis: 0, holdStart: null, streak: null, intervals: [] }).get(f.coin)!;
    const usd = Number.isFinite(f.usd) && f.usd > 0 ? f.usd : 0;
    // a streak that reached 24h before this fill is complete
    if (p.streak !== null && f.ts >= p.streak + FAIR.holdMs) { holds.push(p.streak + FAIR.holdMs); p.streak = null; }
    if (f.side === "buy") {
      if (p.tokens <= DUST) { p.holdStart = f.ts; p.intervals.push({ start: f.ts, end: Infinity, startMcap: f.mcapUsd }); }
      p.tokens += f.tokens; p.basis += usd;
      if (p.streak === null && p.basis >= FAIR.holdMinUsd) p.streak = f.ts;
    } else {
      if (f.side === "sell" && inP(f.ts) && (f.impactBps ?? 0) >= FAIR.bombMinImpactBps && usd >= FAIR.bombMinUsd && p.holdStart !== null && f.ts - p.holdStart >= FAIR.bombMinHoldMs) bombs.push(f.ts);
      const q = Math.min(f.tokens, Math.max(0, p.tokens));
      if (p.tokens > DUST) { p.basis -= p.basis * (q / p.tokens); p.tokens -= q; }
      if (p.tokens <= DUST) { p.tokens = 0; p.basis = 0; p.holdStart = null; const last = p.intervals[p.intervals.length - 1]; if (last && last.end === Infinity) last.end = f.ts; }
      // any dump or transfer away resets the clock
      p.streak = p.basis >= FAIR.holdMinUsd ? f.ts : null;
    }
  }
  for (const p of Array.from(pos.values())) {
    if (p.streak === null) continue;
    const due = p.streak + FAIR.holdMs;
    if (due <= inp.now) holds.push(due);
    else if (due < period.end) recheck(due);
  }

  const results: Record<string, MissionResult> = {};
  const done = (m: MissionDef, progress: number, doneAt?: number) => {
    const p = Math.max(0, Math.min(m.target, progress));
    results[m.id] = p >= m.target && doneAt !== undefined ? { progress: p, target: m.target, doneAt } : { progress: p, target: m.target };
  };

  for (const m of missions) {
    switch (m.kind) {
      case "boost_rockets": {
        const seen = new Set<string>(); let at: number | undefined;
        for (const b of boosts) { seen.add(b.coin); if (seen.size >= m.target && at === undefined) at = b.ts; }
        done(m, seen.size, at); break;
      }
      case "boost_usd": {
        let sum = 0, at: number | undefined;
        for (const b of boosts) { sum += b.usd; if (sum >= m.target && at === undefined) at = b.ts; }
        done(m, Math.floor(sum), at); break;
      }
      case "boost_fresh": {
        const b = boosts.find((x) => { const c = coin(x.coin)!; return x.ts - c.launchTs <= FAIR.freshLaunchMs && x.ts >= c.launchTs; });
        done(m, b ? 1 : 0, b?.ts); break;
      }
      case "boost_modes": {
        const modes = new Set<number>(); let at: number | undefined;
        for (const b of boosts) { const md = coin(b.coin)!.mode; if (md === undefined) continue; modes.add(md); if (modes.size >= 3 && at === undefined) at = b.ts; }
        done(m, modes.size, at); break;
      }
      case "drop_bomb": done(m, bombs.length ? 1 : 0, bombs[0]); break;
      case "hold_24h": {
        const at = holds.filter((t) => t >= period.start && t < period.end && t <= inp.now).sort((a, b) => a - b)[0];
        done(m, at !== undefined ? 1 : 0, at); break;
      }
      case "launch": {
        let at: number | undefined;
        for (const [, c] of Array.from(inp.coins.entries())) if (!c.anon && c.creator.toLowerCase() === wallet && inP(c.launchTs) && (at === undefined || c.launchTs < at)) at = c.launchTs;
        done(m, at !== undefined ? 1 : 0, at); break;
      }
      case "orbit_aboard": {
        let at: number | undefined;
        for (const [addr, c] of Array.from(inp.coins.entries())) {
          if (!c.grad || !inP(c.grad.ts)) continue;
          let tokens = 0, buyUsd = 0;
          for (const f of fills) {
            if (f.coin !== addr) continue;
            if (f.block > c.grad.block || (f.block === c.grad.block && f.logIndex >= c.grad.logIndex)) break;
            if (f.side === "buy") { tokens += f.tokens; buyUsd += f.usd > 0 ? f.usd : 0; } else tokens -= f.tokens;
          }
          if (tokens > DUST && buyUsd >= FAIR.minBoostUsd && (at === undefined || c.grad.ts < at)) at = c.grad.ts;
        }
        done(m, at !== undefined ? 1 : 0, at); break;
      }
      case "ride_tier": {
        let at: number | undefined;
        for (const [addr, p] of Array.from(pos.entries())) {
          const path = (inp.coinFills?.get(addr) ?? fills.filter((f) => f.coin === addr)).filter((x) => typeof x.mcapUsd === "number").slice().sort((a, b) => a.ts - b.ts);
          for (const iv of p.intervals) {
            const s = Math.max(iv.start, period.start), e = Math.min(iv.end, period.end, inp.now);
            if (s >= e) continue;
            // the rocket's tier when this ride (inside the period) began
            let startMcap = iv.start >= period.start ? iv.startMcap : undefined;
            if (startMcap === undefined) for (const x of path) { if (x.ts <= s) startMcap = x.mcapUsd; else break; }
            if (startMcap === undefined) continue;
            const t0 = tierIndex(startMcap);
            const hit = path.find((x) => x.ts > s && x.ts < e && tierIndex(x.mcapUsd!) > t0);
            if (hit && (at === undefined || hit.ts < at)) at = hit.ts;
          }
        }
        done(m, at !== undefined ? 1 : 0, at); break;
      }
    }
  }
  return { results, ...(recheckAt !== undefined ? { recheckAt } : {}) };
}

/**
 * Drafting slingshots that pay in this period (oldest first, at most DRAFT.perDay). A claim counts when:
 *  - it falls inside the period and is not later than `asOf`, and at least DRAFT.minGapMs after the last counted one;
 *  - the wallet held the coin at that moment with a cost basis of at least DRAFT.minHoldUsd (from its own fills);
 *  - at least one drafted pilot (never the wallet itself) has a buy fill on that coin in the DRAFT.windowMs before it.
 * `coinFills` = every trader's fills per coin. Pure: the same inputs always pay the same claims.
 */
export function evaluateDrafts(inp: { wallet: string; fills: readonly MissionFill[]; coinFills: ReadonlyMap<string, readonly { ts: number; trader: string; side: string }[]>; claims: readonly DraftClaim[]; asOf: number }, period: Period): DraftClaim[] {
  const wallet = inp.wallet.toLowerCase();
  const fills = [...inp.fills].filter((f) => f.side !== "out" || f.tokens > 0).sort(order);
  const claims = inp.claims.filter((c) => c.at >= period.start && c.at < period.end && c.at <= inp.asOf).slice().sort((a, b) => a.at - b.at);
  const heldBasis = (coin: string, at: number) => {
    let tokens = 0, basis = 0;
    for (const f of fills) {
      if (f.ts > at) break;
      if (f.coin !== coin) continue;
      if (f.side === "buy") { tokens += f.tokens; basis += Number.isFinite(f.usd) && f.usd > 0 ? f.usd : 0; }
      else { const q = Math.min(f.tokens, Math.max(0, tokens)); if (tokens > DUST) { basis -= basis * (q / tokens); tokens -= q; } if (tokens <= DUST) { tokens = 0; basis = 0; } }
    }
    return tokens > DUST ? basis : 0;
  };
  const out: DraftClaim[] = [];
  let lastAt = -Infinity;
  for (const c of claims) {
    if (out.length >= DRAFT.perDay) break;
    const coin = c.coin.toLowerCase();
    if (c.at - lastAt < DRAFT.minGapMs) continue;
    if (heldBasis(coin, c.at) < DRAFT.minHoldUsd) continue;
    const pilots = new Set(c.wingmen.map((x) => x.toLowerCase()).filter((x) => x !== wallet));
    const boosted = (inp.coinFills.get(coin) ?? []).some((f) => f.side === "buy" && pilots.has(f.trader.toLowerCase()) && f.ts <= c.at && f.ts >= c.at - DRAFT.windowMs);
    if (!boosted) continue;
    out.push(c); lastAt = c.at;
  }
  return out;
}
