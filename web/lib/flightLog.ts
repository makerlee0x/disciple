/**
 * Flight log (approved prototype "Flight feel", maker Nov 13): the card a pilot sees on leaving a live rocket, and the
 * numbers its Share button carries. Pure and fills-only, like the missions: every stat can be re-derived from the coin's
 * indexed trades, so a card never shows a number the chain doesn't back. lib/server/flightLog.ts loads the inputs.
 */
import { TIERS } from "./config";
import { FAIR } from "./xp";

export interface FlightLogFill { ts: number; block: number; logIndex: number; trader: string; side: "buy" | "sell"; tokens: number; usd: number; mcapUsd?: number; impactBps?: number }
export interface FlightLog {
  /** highest mcap seen while you were aboard (or, never aboard, during the flight) */
  peakMcap: number | null;
  peakTier: string | null;
  /** other pilots' 5%+ dumps that landed while you were aboard, with no sell from you in the 10 minutes after */
  bombsSurvived: number;
  /** different other pilots who boosted ($5+) while you were aboard */
  wingmen: number;
  /** your boosts ($5+) in this flight */
  boosts: number;
  /** drafting slingshots you reported on this rocket in this flight (paid later if the fills back them) */
  slingshots: number;
  /** XP the ledger credited during this flight */
  xp: number;
}

const DUST = 1e-9;
const tierName = (m: number) => { let n: string = TIERS[0].name; for (const t of TIERS) if (m >= t.lo) n = t.name; return n; };

export function computeFlightLog(inp: { wallet: string; since: number; now: number; fills: readonly FlightLogFill[]; slingshots?: number; xp?: number }): FlightLog {
  const w = inp.wallet.toLowerCase();
  const fills = [...inp.fills].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex || a.ts - b.ts);
  let tokens = 0, peakAboard: number | null = null, peakAny: number | null = null, boosts = 0;
  const wingmen = new Set<string>(), bombs: number[] = [], mySells: number[] = [];
  for (const f of fills) {
    const mine = f.trader.toLowerCase() === w, inFlight = f.ts >= inp.since && f.ts <= inp.now;
    if (mine) {
      if (f.side === "buy") { tokens += f.tokens; if (inFlight && f.usd >= FAIR.minBoostUsd) boosts++; }
      else { tokens = Math.max(0, tokens - f.tokens); if (inFlight) mySells.push(f.ts); }
    }
    if (!inFlight) continue;
    const aboard = tokens > DUST;
    if (typeof f.mcapUsd === "number" && f.mcapUsd > 0) {
      peakAny = Math.max(peakAny ?? 0, f.mcapUsd);
      if (aboard) peakAboard = Math.max(peakAboard ?? 0, f.mcapUsd);
    }
    if (mine || !aboard) continue;
    if (f.side === "buy" && f.usd >= FAIR.minBoostUsd) wingmen.add(f.trader.toLowerCase());
    if (f.side === "sell" && (f.impactBps ?? 0) >= FAIR.holdBombImpactBps && f.usd >= FAIR.bombMinUsd) bombs.push(f.ts);
  }
  const survived = bombs.filter((t) => !mySells.some((s) => s >= t && s <= Math.min(t + FAIR.holdBombMs, inp.now))).length;
  const peak = peakAboard ?? peakAny;
  return { peakMcap: peak, peakTier: peak !== null ? tierName(peak) : null, bombsSurvived: survived, wingmen: wingmen.size, boosts, slingshots: inp.slingshots ?? 0, xp: inp.xp ?? 0 };
}
