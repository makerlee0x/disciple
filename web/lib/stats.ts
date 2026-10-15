/**
 * Typed player stats layer. Computes KPIs, rockets table, playstyle, CT flavor
 * from trades shaped like protocol Trade events + indexer fields
 * (priceBefore/After, impactBps, mcapAfter).
 */
import { BOMB_TIERS, IDENTITY_THRESHOLDS, TIERS, levelFromPoints, seasonRank } from "./config";
import type { Address } from "./protocol";

export interface StatsTrade {
  token: Address;
  ticker: string;
  name: string;
  side: "buy" | "sell";
  /** Gross $ notional */
  usd: number;
  priceBefore: number;
  priceAfter: number;
  /** Price impact, basis points */
  impactBps: number;
  mcapAfter: number;
  /** ms epoch */
  ts: number;
  launchTs: number;
  topFuelerAtGrad?: boolean;
  assistedGraduation?: boolean;
  isLauncher?: boolean;
  graduated?: boolean;
  peakMcap?: number;
  txHash?: string;
  block?: number;
}

export interface SparkPoint { t: number; v: number }

export interface KpiCard {
  key: string; label: string; total: number; d30: number;
  format: "usd" | "pct" | "hours" | "number";
  sparkTotal: SparkPoint[]; spark30: SparkPoint[];
}

export interface RocketRow {
  token: Address; ticker: string; name: string; tierName: string; tierIndex: number;
  entries: number; pnl: number; winRate: number; avgHoldHours: number; bombs: number;
  badges: string[]; volume: number; graduated: boolean;
}

export interface ActivityItem {
  id: string; ts: number; kind: "buy" | "sell" | "bomb";
  text: string; usd?: number; ticker?: string;
}

export interface PlaystyleAxes {
  fueling: number; holding: number; crewJoins: number; graduations: number;
  bombs: number; impact: number; dumpsIntoPumps: number; quickFlips: number;
}

export interface TraitRadar {
  conviction: number; aggression: number; timing: number;
  sniping: number; diamondHands: number; crewSpirit: number;
}

export interface CtFlavor {
  ruggedCount: number; roundsTripped: number; biggestW: number; biggestL: number;
  fumbledBag: number; timeInTrenchesHours: number; apeScore: number; graduationsWitnessed: number;
}

export interface IdentityMetrics {
  avgHoldHours: number; tradeCount: number; buyCount: number; sellCount: number;
  sniperBuyFraction: number; diamondHandsCount: number; paperHandsCount: number;
  exitLiqEvents: number; sizePercentile: number; distinctRockets: number;
  openUpnlLossFrac: number; openHoldHours: number; bombCount: number; nukeCount: number;
  crewCaptainGrads: number; gateKeeperAssists: number; launches: number;
  graduatedLaunches: number; kingmakerCount: number; points: number; realizedPnl: number;
  roi: number; roiPercentile: number; closedTrades: number; jeetCount: number;
  heldThroughDrawdownFrac: number;
}

export interface PlayerStats {
  handle: string; persona: string; points: number;
  level: ReturnType<typeof levelFromPoints>;
  rank: ReturnType<typeof seasonRank>;
  leaderboardRank: number; leaderboardTopPct: number;
  pointsBehindFirst: number; pointsToNextRank: number;
  kpis: KpiCard[];
  rings: { key: string; label: string; value: number; max: number; format: "usd" | "number" | "multiple" | "rank"; sub?: string }[];
  cumulativePnl: SparkPoint[];
  volumeByDay: { day: string; volume: number }[];
  holdHist: { bucket: string; count: number }[];
  pnlCalendar: { date: string; pnl: number }[];
  playstyle: PlaystyleAxes; pveScore: number; pvpScore: number; traits: TraitRadar;
  rockets: RocketRow[]; activity: ActivityItem[]; ct: CtFlavor;
  metrics: IdentityMetrics;
  topBadges: { id: string; name: string; rarity: string }[];
  showcaseIcon: string | null;
}

export function tierAt(mcap: number): { name: string; index: number } {
  let idx = 0;
  for (let i = 0; i < TIERS.length; i++) if (mcap >= TIERS[i].lo) idx = i;
  return { name: TIERS[idx].name, index: idx };
}

export function bombName(impactPct: number): string {
  let name = "BRAKE";
  for (const b of BOMB_TIERS) if (impactPct >= b.min) name = b.name;
  return name;
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const score = (n: number, lo: number, hi: number) => Math.round(clamp01((n - lo) / (hi - lo)) * 100);

interface Pos {
  size: number; cost: number; realized: number; holdStart: number;
  entryPx: number; peakPx: number; troughPx: number; entryMcap: number; peakMcap: number;
  bombs: number; entries: number; ticker: string; name: string; graduated: boolean;
  topFuelerAtGrad: boolean; assistedGraduation: boolean; isLauncher: boolean;
  wins: number; losses: number; holds: number[]; volume: number; lastPx: number; firstBuyTs: number; launchTs: number;
}

export interface StatsOptions {
  handle: string; persona: string; points: number;
  leaderboardRank: number; leaderboardSize: number; firstPlacePoints: number;
  now: number; showcaseIcon?: string | null; sizePercentile?: number; roiPercentile?: number;
}

export function computeStats(trades: StatsTrade[], o: StatsOptions): PlayerStats {
  const T = IDENTITY_THRESHOLDS;
  const now = o.now;
  const d30 = now - 30 * 864e5;
  const pos = new Map<Address, Pos>();
  const sorted = [...trades].sort((a, b) => a.ts - b.ts);

  const series: SparkPoint[] = [];
  const volSeries: SparkPoint[] = [];
  const volDay = new Map<string, number>();
  const pnlDay = new Map<string, number>();
  const holdBuckets = new Map<string, number>();
  const activity: ActivityItem[] = [];
  let cum = 0, cumVol = 0, vol = 0, vol30 = 0, real30 = 0;
  let buys = 0, sells = 0, snipes = 0, bombs = 0, nukes = 0, impactSum = 0;
  let dumps = 0, flips = 0, paper = 0, exitLiq = 0, jeets = 0, roundTrips = 0, rugged = 0;
  let bigW = 0, bigL = 0, fumbled = 0, bestX = 1;
  let holdSum = 0, holdN = 0, hold30 = 0, holdN30 = 0, wins = 0, losses = 0, wins30 = 0, losses30 = 0;

  for (const t of sorted) {
    let p = pos.get(t.token);
    if (!p) {
      p = { size: 0, cost: 0, realized: 0, holdStart: 0, entryPx: 0, peakPx: 0, troughPx: 0, entryMcap: 0,
        peakMcap: 0, bombs: 0, entries: 0, ticker: t.ticker, name: t.name, graduated: false,
        topFuelerAtGrad: false, assistedGraduation: false, isLauncher: false, wins: 0, losses: 0,
        holds: [], volume: 0, lastPx: 0, firstBuyTs: 0, launchTs: t.launchTs };
      pos.set(t.token, p);
    }
    p.graduated ||= !!t.graduated;
    p.topFuelerAtGrad ||= !!t.topFuelerAtGrad;
    p.assistedGraduation ||= !!t.assistedGraduation;
    p.isLauncher ||= !!t.isLauncher;
    p.peakMcap = Math.max(p.peakMcap, t.peakMcap ?? 0, t.mcapAfter);
    const px = t.priceAfter;
    p.lastPx = px;
    p.volume += t.usd; vol += t.usd; cumVol += t.usd;
    if (t.ts >= d30) vol30 += t.usd;
    volDay.set(dayKey(t.ts), (volDay.get(dayKey(t.ts)) ?? 0) + t.usd);
    if (p.size > 0) { p.peakPx = Math.max(p.peakPx, px); p.troughPx = Math.min(p.troughPx, px); }

    if (t.side === "buy") {
      buys++;
      if (p.size <= 0) {
        p.holdStart = t.ts; p.entryPx = px; p.peakPx = px; p.troughPx = px; p.entryMcap = t.mcapAfter;
        
      }
      if (!p.firstBuyTs) p.firstBuyTs = t.ts;
      p.size += t.usd / px; p.cost += t.usd; p.entries++;
      if (t.ts - t.launchTs <= T.sniperEntrySec * 1000) snipes++;
      activity.push({ id: `${t.ts}-${t.token}-b`, ts: t.ts, kind: "buy", text: `Fueled ${t.ticker}`, usd: t.usd, ticker: t.ticker });
    } else {
      sells++;
      const imp = t.impactBps / 100;
      impactSum += imp;
      if (imp >= BOMB_TIERS[1].min) {
        bombs++; p.bombs++;
        activity.push({ id: `${t.ts}-${t.token}-x`, ts: t.ts, kind: "bomb", text: `Dropped ${bombName(imp)} on ${t.ticker}`, usd: t.usd, ticker: t.ticker });
      } else {
        activity.push({ id: `${t.ts}-${t.token}-s`, ts: t.ts, kind: "sell", text: `Braked ${t.ticker}`, usd: t.usd, ticker: t.ticker });
      }
      if (imp >= BOMB_TIERS[4].min) nukes++;
      if (p.size > 0) {
        const tokens = Math.min(p.size, t.usd / t.priceBefore);
        const frac = tokens / p.size;
        const basis = p.cost * frac;
        const pnl = tokens * t.priceBefore - basis;
        p.realized += pnl; cum += pnl;
        if (t.ts >= d30) real30 += pnl;
        pnlDay.set(dayKey(t.ts), (pnlDay.get(dayKey(t.ts)) ?? 0) + pnl);
        bigW = Math.max(bigW, pnl); bigL = Math.min(bigL, pnl);
        const h = (t.ts - p.holdStart) / 3.6e6;
        holdSum += h; holdN++; p.holds.push(h);
        if (t.ts >= d30) { hold30 += h; holdN30++; }
        const b = h < 1 / 60 ? "<1m" : h < 5 / 60 ? "1–5m" : h < 0.5 ? "5–30m" : h < 2 ? "30m–2h" : h < 12 ? "2–12h" : h < 48 ? "12–48h" : "48h+";
        holdBuckets.set(b, (holdBuckets.get(b) ?? 0) + 1);
        const peakX = p.peakPx / p.entryPx;
        bestX = Math.max(bestX, t.priceBefore / p.entryPx);
        if (peakX >= T.roundTripMultiple && pnl < 0) roundTrips++;
        if (h * 60 <= T.paperHandsSellMinutes && t.priceBefore < p.peakPx && t.priceBefore >= p.peakPx * (1 - T.paperHandsDip)) paper++;
        if (peakX >= T.jeetPumpMultiple && h * 60 <= T.jeetDumpMinutes && pnl > 0) jeets++;
        if (h * 60 < 15) flips++;
        if (imp >= BOMB_TIERS[2].min && t.mcapAfter > p.entryMcap * 1.2) dumps++;
        if (p.entryPx >= p.peakPx * (1 - T.exitLiqNearHigh) && t.priceBefore <= p.entryPx * (1 - T.exitLiqDrawdown)) exitLiq++;
        if (t.priceBefore <= p.entryPx * T.ruggedMcapFraction) rugged++;
        if (p.peakPx > t.priceBefore) fumbled += tokens * (p.peakPx - t.priceBefore);
        if (pnl >= 0) { wins++; p.wins++; if (t.ts >= d30) wins30++; } else { losses++; p.losses++; if (t.ts >= d30) losses30++; }
        p.cost -= basis; p.size -= tokens;
        if (p.size <= 1e-9) { p.size = 0; p.cost = 0; p.holdStart = 0; }
      }
    }
    series.push({ t: t.ts, v: cum });
    volSeries.push({ t: t.ts, v: cumVol });
  }

  let upnl = 0, diamonds = 0, ddHolds = 0, openHold = 0, bagLoss = 0;
  for (const p of Array.from(pos.values())) {
    if (p.size <= 0) continue;
    const u = p.size * p.lastPx - p.cost;
    upnl += u;
    const held = (now - p.holdStart) / 3.6e6;
    openHold = Math.max(openHold, held);
    const dd = 1 - p.troughPx / p.entryPx;
    if (dd >= T.diamondDrawdown) diamonds++;
    if (dd >= T.believerDrawdownHold) ddHolds++;
    if (u < 0 && held >= T.bagHolderHoldHours) bagLoss = Math.max(bagLoss, -u / p.cost);
    bestX = Math.max(bestX, p.lastPx / p.entryPx);
    if (p.lastPx <= p.entryPx * T.ruggedMcapFraction) rugged++;
    if (p.peakPx > p.lastPx) fumbled += p.size * (p.peakPx - p.lastPx);
  }

  const closed = wins + losses;
  const avgHold = holdN ? holdSum / holdN : openHold;
  const avgHold30 = holdN30 ? hold30 / holdN30 : avgHold;
  const winRate = closed ? wins / closed : 0;
  const winRate30 = wins30 + losses30 ? wins30 / (wins30 + losses30) : winRate;
  const deployed = Math.max(1, sorted.filter((t) => t.side === "buy").reduce((a, t) => a + t.usd, 0));
  const deployed30 = Math.max(1, sorted.filter((t) => t.side === "buy" && t.ts >= d30).reduce((a, t) => a + t.usd, 0));
  const roi = (cum + upnl) / deployed;
  const roi30 = real30 / deployed30;

  const in30 = (s: SparkPoint[]) => {
    const w = s.filter((p) => p.t >= d30);
    if (w.length < 2) return [{ t: d30, v: 0 }, { t: now, v: 0 }];
    const b = w[0].v;
    return w.map((p) => ({ t: p.t, v: p.v - b }));
  };
  const runRate = (fn: (closedSoFar: { w: number; n: number; h: number }) => number) => {
    const out: SparkPoint[] = [];
    let w = 0, n = 0, h = 0;
    const open = new Map<Address, number>();
    for (const t of sorted) {
      if (t.side === "buy") { if (!open.has(t.token)) open.set(t.token, t.ts); continue; }
      const st = open.get(t.token) ?? t.ts;
      const prev = out.length ? out[out.length - 1].v : 0;
      n++; h += (t.ts - st) / 3.6e6;
      if (t.priceAfter >= 0 && prev >= 0) w += t.impactBps < 1500 ? 1 : 0;
      out.push({ t: t.ts, v: fn({ w, n, h }) });
    }
    return out.length >= 2 ? out : [{ t: now - 864e5, v: 0 }, { t: now, v: 0 }];
  };
  const wrSeries = runRate((x) => (x.w / x.n) * 100);
  const holdSeries = runRate((x) => x.h / x.n);

  const kpis: KpiCard[] = [
    { key: "rpnl", label: "Realized PnL", total: cum, d30: real30, format: "usd", sparkTotal: series, spark30: in30(series) },
    { key: "upnl", label: "uPnL", total: upnl, d30: upnl, format: "usd", sparkTotal: series.map((p) => ({ t: p.t, v: p.v * 0 + upnl * clamp01((p.t - series[0].t) / Math.max(1, now - series[0].t)) })), spark30: in30(series) },
    { key: "vol", label: "Volume", total: vol, d30: vol30, format: "usd", sparkTotal: volSeries, spark30: in30(volSeries) },
    { key: "roi", label: "% Gain (ROI)", total: roi * 100, d30: roi30 * 100, format: "pct", sparkTotal: series.map((p) => ({ t: p.t, v: (p.v / deployed) * 100 })), spark30: in30(series) },
    { key: "wr", label: "Win Rate", total: winRate * 100, d30: winRate30 * 100, format: "pct", sparkTotal: wrSeries, spark30: wrSeries.filter((p) => p.t >= d30) },
    { key: "hold", label: "Avg Hold", total: avgHold, d30: avgHold30, format: "hours", sparkTotal: holdSeries, spark30: holdSeries.filter((p) => p.t >= d30) },
  ];

  const all = Array.from(pos.values());
  const crewCaptainGrads = all.filter((p) => p.topFuelerAtGrad && p.graduated).length;
  const gateKeeperAssists = all.filter((p) => p.assistedGraduation).length;
  const launches = all.filter((p) => p.isLauncher).length;
  const graduatedLaunches = all.filter((p) => p.isLauncher && p.graduated).length;
  const kingmakerCount = all.filter((p) => tierAt(p.peakMcap).index >= T.kingmakerTierIndex && p.firstBuyTs - p.launchTs <= 6 * 3.6e6).length;
  const grads = all.filter((p) => p.graduated).length;
  const topPct = (o.leaderboardRank / o.leaderboardSize) * 100;
  const level = levelFromPoints(o.points);
  const rank = seasonRank(o.points);

  const rings: PlayerStats["rings"] = [
    { key: "lpnl", label: "Lifetime PnL", value: cum + upnl, max: Math.max(1000, Math.abs(cum + upnl) * 1.4), format: "usd", sub: `${(roi * 100).toFixed(0)}% ROI` },
    { key: "fueled", label: "Rockets Fueled", value: pos.size, max: 20, format: "number", sub: `${buys} fuel shots` },
    { key: "bombs", label: "Bombs Dropped", value: bombs, max: 25, format: "number", sub: `${nukes} nuke+` },
    { key: "crews", label: "Crews Joined", value: all.filter((p) => p.entries > 0 && p.firstBuyTs - p.launchTs > 0).length, max: 20, format: "number", sub: `${grads} graduated` },
    { key: "bestx", label: "Best ×", value: bestX, max: 20, format: "multiple", sub: "biggest multiple" },
    { key: "rank", label: "Leaderboard", value: o.leaderboardRank, max: o.leaderboardSize, format: "rank", sub: `Top ${topPct.toFixed(1)}%` },
  ];

  const holdOrder = ["<1m", "1–5m", "5–30m", "30m–2h", "2–12h", "12–48h", "48h+"];
  const firstTs = sorted[0]?.ts ?? now;
  const avgSize = deployed / Math.max(1, buys);

  const playstyle: PlaystyleAxes = {
    fueling: score(buys, 0, 40), holding: score(avgHold, 0, 48), crewJoins: score(pos.size, 0, 15),
    graduations: score(grads + gateKeeperAssists, 0, 8), bombs: score(bombs, 0, 20),
    impact: score(sells ? impactSum / sells : 0, 0, 25), dumpsIntoPumps: score(dumps, 0, 8), quickFlips: score(flips, 0, 30),
  };
  const pveScore = Math.round((playstyle.fueling + playstyle.holding + playstyle.crewJoins + playstyle.graduations) / 4);
  const pvpScore = Math.round((playstyle.bombs + playstyle.impact + playstyle.dumpsIntoPumps + playstyle.quickFlips) / 4);
  const traits: TraitRadar = {
    conviction: score(avgHold, 0, 72), aggression: score(impactSum, 0, 250), timing: score(winRate, 0.25, 0.8),
    sniping: score(buys ? snipes / buys : 0, 0, 0.7), diamondHands: score(diamonds * 2 + ddHolds, 0, 6),
    crewSpirit: score(gateKeeperAssists * 2 + crewCaptainGrads * 3 + grads, 0, 14),
  };

  const rockets: RocketRow[] = Array.from(pos.entries()).map(([token, p]) => {
    const ti = tierAt(p.peakMcap);
    const badges: string[] = [];
    if (p.graduated) badges.push("Gates");
    if (p.topFuelerAtGrad) badges.push("Captain");
    if (p.isLauncher) badges.push("Launcher");
    if (p.bombs >= 2) badges.push("Bomber");
    if (p.firstBuyTs - p.launchTs <= T.sniperEntrySec * 1000) badges.push("Sniped");
    return {
      token, ticker: p.ticker, name: p.name, tierName: ti.name, tierIndex: ti.index, entries: p.entries,
      pnl: p.realized + (p.size > 0 ? p.size * p.lastPx - p.cost : 0),
      winRate: p.wins + p.losses ? p.wins / (p.wins + p.losses) : 0,
      avgHoldHours: p.holds.length ? p.holds.reduce((a, b) => a + b, 0) / p.holds.length : (p.size > 0 ? (now - p.holdStart) / 3.6e6 : 0),
      bombs: p.bombs, badges, volume: p.volume, graduated: p.graduated,
    };
  }).sort((a, b) => b.pnl - a.pnl);

  const metrics: IdentityMetrics = {
    avgHoldHours: avgHold, tradeCount: buys + sells, buyCount: buys, sellCount: sells,
    sniperBuyFraction: buys ? snipes / buys : 0, diamondHandsCount: diamonds, paperHandsCount: paper,
    exitLiqEvents: exitLiq, sizePercentile: o.sizePercentile ?? Math.min(0.995, avgSize / 1000),
    distinctRockets: pos.size, openUpnlLossFrac: bagLoss, openHoldHours: openHold, bombCount: bombs, nukeCount: nukes,
    crewCaptainGrads, gateKeeperAssists, launches, graduatedLaunches, kingmakerCount, points: o.points,
    realizedPnl: cum, roi, roiPercentile: o.roiPercentile ?? 0.5, closedTrades: closed, jeetCount: jeets,
    heldThroughDrawdownFrac: pos.size ? ddHolds / pos.size : 0,
  };

  activity.sort((a, b) => b.ts - a.ts);
  return {
    handle: o.handle, persona: o.persona, points: o.points, level, rank,
    leaderboardRank: o.leaderboardRank, leaderboardTopPct: topPct,
    pointsBehindFirst: Math.max(0, o.firstPlacePoints - o.points), pointsToNextRank: rank.pointsToNext,
    kpis, rings, cumulativePnl: series,
    volumeByDay: Array.from(volDay.entries()).sort().map(([day, volume]) => ({ day, volume })),
    holdHist: holdOrder.map((bucket) => ({ bucket, count: holdBuckets.get(bucket) ?? 0 })),
    pnlCalendar: Array.from(pnlDay.entries()).sort().map(([date, pnl]) => ({ date, pnl })),
    playstyle, pveScore, pvpScore, traits, rockets, activity: activity.slice(0, 30),
    ct: { ruggedCount: rugged, roundsTripped: roundTrips, biggestW: bigW, biggestL: bigL, fumbledBag: fumbled,
      timeInTrenchesHours: (now - firstTs) / 3.6e6, apeScore: Math.round(score(buys, 0, 60) * 0.4 + score(pos.size, 0, 18) * 0.3 + (100 - score(avgHold, 0, 24)) * 0.3),
      graduationsWitnessed: grads },
    metrics, topBadges: [], showcaseIcon: o.showcaseIcon ?? null,
  };
}
