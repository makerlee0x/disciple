/**
 * Rocket logbook (main mode hook loop, maker 2026-11-13, mockup boards "1 Rocket logbook" and "1b One rocket's story").
 * Every rocket a pilot has flown, the part they played in its flight, and what it did after they left. Pure and
 * fills-only like the flight log and the missions: every line can be re-derived from the coin's indexed trades.
 * lib/server/logbook.ts loads the inputs.
 *
 * Guardrails (main mode hook loop review): it rewards being early, staying and flying with people, never trade size.
 * Red flights stay in the logbook. "On paper" values are shown as unbanked until a dump.
 */
import { TIERS } from "./config";
import { FAIR } from "./xp";

const DUST = 1e-9;
/** orbit line (curve graduation, lib/modeRules CAP_MCAP_END_USD) */
export const ORBIT_MCAP = 33_333;

export interface LogFill { ts: number; block: number; logIndex: number; trader: string; side: "buy" | "sell"; tokens: number; usd: number; mcapUsd?: number; priceUsd?: number; impactBps?: number }
export interface LogCoin { token: string; name: string; ticker: string; creator: string; graduated: boolean; mode?: number; mcapUsd?: number }

export type LogStatus = "aboard" | "green" | "red" | "even";
export type LogNewsKind = "orbit_aboard" | "orbit_after" | "zone_after" | "crew_aboard";
export interface LogNews { kind: LogNewsKind; at: number; zone?: string; crew?: number }
export type StoryKind = "boarded" | "crew_joined" | "bomb_held" | "zone" | "orbit" | "left";
export interface StoryEvent { kind: StoryKind; at: number; zone?: string; pilotNo?: number; firstCrew?: boolean; crew?: number; impactPct?: number; passengers?: number; aboard?: boolean; pilotsAboard?: number }

export interface LogEntry {
  coin: string; name: string; ticker: string; creator: string; graduated: boolean; mode?: number;
  /** first boost on this rocket */
  boardedAt: number; boardedMcap: number; boardedZone: string;
  /** your place among the rocket's pilots when you first boarded (launcher not counted), and first crew (< FAIR.crewSize ahead) */
  pilotNo: number; firstCrew: boolean;
  /** highest mcap while you were aboard */
  peakWithYou: number; peakZone: string;
  /** other pilots' 5%+ dumps that landed while you were aboard, with no sell from you in the 10 minutes after */
  bombsHeld: number;
  status: LogStatus;
  /** aboard now: since the current position opened; left: length of the last stay */
  aboardMs: number;
  /** last sell that emptied the bag (left), null while aboard */
  leftAt: number | null;
  /** realized $ (sells − cost of what was sold), every stay on this rocket */
  bankedUsd: number;
  /** aboard only: tokens held × the last fill price, and its gain on the cost of what's held (after nothing: an estimate) */
  paperUsd: number | null; paperPct: number | null;
  /** reached orbit while you were aboard */
  orbitAboard: boolean;
  /** crewmates holding it now (0 when crew unknown) */
  crewAboard: number;
  /** the newest thing that happened, for the logbook line ("Reached orbit with you aboard") */
  news: LogNews | null;
  /** last fill on the rocket */
  lastAt: number;
  nowMcap: number; nowZone: string;
  /** zones the rocket climbed while you were aboard */
  zonesClimbed: number;
  pilots: number;
}

export const zoneIndex = (mcap: number) => { let i = 0; for (let k = 0; k < TIERS.length; k++) if (mcap >= TIERS[k].lo) i = k; return i; };
export const zoneName = (mcap: number) => TIERS[zoneIndex(mcap)].name;

const order = (a: LogFill, b: LogFill) => a.block - b.block || a.logIndex - b.logIndex || a.ts - b.ts;

export interface LogInput {
  wallet: string; coin: LogCoin;
  /** every fill on the coin you have (yours included), any order */
  fills: readonly LogFill[];
  /** your crewmates' wallets (lower case), you excluded */
  crew?: ReadonlySet<string>;
  now: number;
}

/** One rocket's logbook entry and story, or null when the wallet never boosted it. */
export function logbookEntry(inp: LogInput): { entry: LogEntry; story: StoryEvent[] } | null {
  const w = inp.wallet.toLowerCase();
  const creator = inp.coin.creator.toLowerCase();
  const fills = [...inp.fills].sort(order);
  if (!fills.some((f) => f.trader.toLowerCase() === w && f.side === "buy")) return null;

  const held = new Map<string, number>();        // tokens per trader
  const pilots = new Set<string>();               // traders who have boosted (launcher not counted)
  let my = 0, myCost = 0, banked = 0, since = 0, boardedAt = 0, boardedMcap = 0, pilotNo = 0;
  let peak = 0, leftAt: number | null = null, lastStay = 0, orbitAboard = false, orbitAt: number | null = null, zoneAtLeave = -1;
  let maxZoneAfterLeave = -1, maxZoneAfterLeaveAt = 0, crewFirstAt: number | null = null, zonesClimbed = 0;
  const bombs: { at: number; impact: number }[] = [];
  const mySells: number[] = [];
  const story: StoryEvent[] = [];
  let lastMcap = 0, lastPrice = 0, lastAt = 0, zoneNow = -1, zoneMine = -1;

  for (const f of fills) {
    const t = f.trader.toLowerCase(), mine = t === w;
    const before = held.get(t) ?? 0;
    if (f.side === "buy") held.set(t, before + f.tokens); else held.set(t, Math.max(0, before - f.tokens));
    if (f.side === "buy" && t !== creator) pilots.add(t);
    const mcap = typeof f.mcapUsd === "number" && f.mcapUsd > 0 ? f.mcapUsd : lastMcap;
    lastMcap = mcap; lastAt = f.ts;
    if (typeof f.priceUsd === "number" && f.priceUsd > 0) lastPrice = f.priceUsd;

    if (mine) {
      if (f.side === "buy") {
        if (my <= DUST) {
          since = f.ts;
          if (!boardedAt) {
            boardedAt = f.ts; boardedMcap = mcap; pilotNo = pilots.size;
            story.push({ kind: "boarded", at: f.ts, zone: zoneName(mcap), pilotNo, firstCrew: pilotNo <= FAIR.crewSize });
            zoneMine = zoneIndex(mcap);
          }
          leftAt = null;
        }
        my += f.tokens; myCost += f.usd;
      } else if (my > DUST) {
        const sold = Math.min(f.tokens, my), basis = myCost * (sold / my);
        banked += f.usd * (sold / f.tokens) - basis;
        my -= sold; myCost -= basis; mySells.push(f.ts);
        if (my <= DUST) { my = 0; myCost = 0; leftAt = f.ts; lastStay = f.ts - since; zoneAtLeave = zoneIndex(mcap); story.push({ kind: "left", at: f.ts, zone: zoneName(mcap) }); }
      }
    }
    const aboard = my > DUST;
    if (aboard) peak = Math.max(peak, mcap);
    // zone crossings: while aboard they go in the story; after leaving, the highest is the news
    const z = zoneIndex(mcap);
    if (z > zoneNow) {
      if (zoneNow >= 0 && boardedAt && aboard && z > zoneMine) {
        const passengers = [...held.entries()].filter(([k, v]) => v > DUST && k !== creator).length;
        story.push({ kind: "zone", at: f.ts, zone: TIERS[z].name, passengers });
        zonesClimbed += z - zoneMine; zoneMine = z;
      }
      zoneNow = z;
    }
    if (boardedAt && !aboard && leftAt !== null && z > zoneAtLeave && z > maxZoneAfterLeave) { maxZoneAfterLeave = z; maxZoneAfterLeaveAt = f.ts; }
    // orbit: the first fill at or past the line on a graduated rocket
    if (orbitAt === null && inp.coin.graduated && mcap >= ORBIT_MCAP) {
      orbitAt = f.ts;
      if (aboard) {
        orbitAboard = true;
        const n = [...held.entries()].filter(([k, v]) => v > DUST && k !== creator).length;
        story.push({ kind: "orbit", at: f.ts, aboard: true, pilotsAboard: n });
      }
    }
    // bombs from other pilots while you're aboard
    if (!mine && aboard && f.side === "sell" && (f.impactBps ?? 0) >= FAIR.holdBombImpactBps && f.usd >= FAIR.bombMinUsd) bombs.push({ at: f.ts, impact: (f.impactBps ?? 0) / 100 });
    // crew joined: the first crewmate boost after you boarded
    if (!mine && aboard && crewFirstAt === null && f.side === "buy" && inp.crew?.has(t)) {
      crewFirstAt = f.ts;
      const n = fills.filter((x) => x.side === "buy" && x.ts >= f.ts && x.ts <= f.ts + 3600_000 && inp.crew!.has(x.trader.toLowerCase())).map((x) => x.trader.toLowerCase());
      story.push({ kind: "crew_joined", at: f.ts, crew: new Set(n).size });
    }
  }
  const held10 = bombs.filter((b) => !mySells.some((s) => s >= b.at && s <= Math.min(b.at + FAIR.holdBombMs, inp.now)));
  for (const b of held10) story.push({ kind: "bomb_held", at: b.at, impactPct: Math.round(b.impact) });
  story.sort((a, b) => a.at - b.at);

  const aboard = my > DUST;
  const crewAboard = inp.crew ? [...inp.crew].filter((c) => (held.get(c) ?? 0) > DUST).length : 0;
  const paper = aboard && lastPrice > 0 ? my * lastPrice : null;
  const status: LogStatus = aboard ? "aboard" : banked > 0.005 ? "green" : banked < -0.005 ? "red" : "even";
  let news: LogNews | null = null;
  if (orbitAboard && orbitAt !== null) news = { kind: "orbit_aboard", at: orbitAt };
  else if (orbitAt !== null && leftAt !== null && orbitAt > leftAt) news = { kind: "orbit_after", at: orbitAt };
  else if (!aboard && maxZoneAfterLeave >= 0) news = { kind: "zone_after", at: maxZoneAfterLeaveAt, zone: TIERS[maxZoneAfterLeave].name };
  else if (aboard && crewAboard > 0) news = { kind: "crew_aboard", at: inp.now, crew: crewAboard };

  const entry: LogEntry = {
    coin: inp.coin.token.toLowerCase(), name: inp.coin.name, ticker: inp.coin.ticker, creator, graduated: inp.coin.graduated, mode: inp.coin.mode,
    boardedAt, boardedMcap, boardedZone: zoneName(boardedMcap), pilotNo, firstCrew: pilotNo <= FAIR.crewSize,
    peakWithYou: peak, peakZone: zoneName(peak || boardedMcap), bombsHeld: held10.length, status,
    aboardMs: aboard ? inp.now - since : lastStay, leftAt: aboard ? null : leftAt,
    bankedUsd: Math.round(banked * 100) / 100,
    paperUsd: paper === null ? null : Math.round(paper * 100) / 100,
    paperPct: paper === null || !(myCost > 0) ? null : Math.round(((paper - myCost) / myCost) * 1000) / 10,
    orbitAboard, crewAboard, news, lastAt,
    nowMcap: inp.coin.mcapUsd ?? lastMcap, nowZone: inp.coin.graduated ? "IN ORBIT" : zoneName(inp.coin.mcapUsd ?? lastMcap),
    zonesClimbed, pilots: pilots.size,
  };
  return { entry, story };
}

export interface LogRecord { rockets: number; orbits: number; firstCrews: number; bombsHeld: number; green: number; red: number; aboard: number; news: number }

/** The "Your record" panel, from every entry. */
export function logRecord(entries: readonly LogEntry[]): LogRecord {
  const r: LogRecord = { rockets: entries.length, orbits: 0, firstCrews: 0, bombsHeld: 0, green: 0, red: 0, aboard: 0, news: 0 };
  for (const e of entries) {
    if (e.orbitAboard) r.orbits++;
    if (e.firstCrew) r.firstCrews++;
    r.bombsHeld += e.bombsHeld;
    if (e.status === "green") r.green++; else if (e.status === "red") r.red++; else if (e.status === "aboard") r.aboard++;
    if (e.news && e.news.kind !== "crew_aboard") r.news++;
  }
  return r;
}

/** Newest first: rockets with news, then aboard, then by last activity. */
export function sortLog(entries: LogEntry[]): LogEntry[] {
  const rank = (e: LogEntry) => (e.news && e.news.kind !== "crew_aboard" ? 2 : e.status === "aboard" ? 1 : 0);
  return entries.sort((a, b) => rank(b) - rank(a) || (b.news?.at ?? b.lastAt) - (a.news?.at ?? a.lastAt));
}
