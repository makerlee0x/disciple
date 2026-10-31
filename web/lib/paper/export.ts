/** Round data export for mechanics tuning (JSON + CSV). Pure: works in the browser (download) and in node scripts. */
import { ARCH_LABEL, type Archetype } from "./config";
import { PaperRound, PLAYER_ID } from "./engine";

export function roundSummary(r: PaperRound) {
  const st = r.standings();
  const byArch: Record<string, { n: number; avgNetWorth: number; avgPnlPct: number; trades: number; fees: number; gas: number; snipeTax: number; tipsPaid: number; tipsReceived: number }> = {};
  const byTier: Record<string, { n: number; avgNetWorth: number }> = {};
  for (const s of st) {
    const w = r.wallets[s.walletId]; const k = w.archetype ?? "player", t = w.tier ?? "player";
    const a = (byArch[k] ??= { n: 0, avgNetWorth: 0, avgPnlPct: 0, trades: 0, fees: 0, gas: 0, snipeTax: 0, tipsPaid: 0, tipsReceived: 0 });
    a.n++; a.avgNetWorth += s.finalNetWorth; a.avgPnlPct += (s.finalNetWorth / r.cfg.startCash - 1) * 100; a.trades += w.trades;
    a.fees += w.feesPaid; a.gas += w.gasPaid; a.snipeTax += w.snipeTaxPaid; a.tipsPaid += w.tipsPaid; a.tipsReceived += w.tipsReceived;
    const b = (byTier[t] ??= { n: 0, avgNetWorth: 0 }); b.n++; b.avgNetWorth += s.finalNetWorth;
  }
  for (const a of Object.values(byArch)) { a.avgNetWorth /= a.n; a.avgPnlPct /= a.n; }
  for (const b of Object.values(byTier)) b.avgNetWorth /= b.n;
  const endT = r.t, lastMin = r.leaderLog.filter((x) => x.t > endT - 60).length > 0 && r.leaderLog.length > 1 && r.leaderLog[r.leaderLog.length - 1].t > endT - 60;
  const me = st.find((s) => s.walletId === PLAYER_ID)!;
  return {
    seed: r.seed, difficulty: r.cfg.difficulty, endReason: r.ended, durationSec: endT, graduated: r.graduated, graduationSec: r.gradT,
    finalMcap: r.mcap, peakMcap: Math.max(...r.path), pctSold: r.pctSold,
    trades: r.trades.length, buys: r.trades.filter((t) => t.side === "buy").length,
    fees: r.totals.fees, gas: r.totals.gas, sniperTax: r.totals.snipeTax, sniperTaxHits: r.totals.snipeHits,
    crewTipsTotal: r.trades.reduce((a, t) => a + t.crewTip, 0), crewTipSells: r.trades.filter((t) => t.crewTip > 0).length,
    cappedBuys: r.totals.capped, rejected: r.totals.rejected,
    leaderChanges: Math.max(0, r.leaderLog.length - 1), leaderChangedInFinalMinute: lastMin,
    winner: { name: st[0].displayName, tier: st[0].tier ?? "player", archetype: st[0].archetype ? ARCH_LABEL[st[0].archetype as Archetype] : "player", netWorth: st[0].finalNetWorth },
    player: { rank: me.rank, of: st.length, netWorth: me.finalNetWorth },
    byTier, byArchetype: byArch,
  };
}

export function roundJson(r: PaperRound) {
  const step = Math.round(1000 / r.cfg.tickMs);
  return {
    v: 1, kind: "disciple.paper.round", simulated: true,
    config: r.cfg, seed: r.seed, summary: roundSummary(r), phases: r.phaseLog,
    curvePath: r.path.filter((_, i) => i % step === 0).map((m, i) => ({ t: i, mcap: +m.toFixed(2) })),
    trades: r.trades, standings: r.standings(),
    wallets: r.wallets.map(({ id, kind, displayName, tier, archetype, paperRating, cash, tokens, realizedPnl, feesPaid, gasPaid, snipeTaxPaid, tipsPaid, tipsReceived, trades }) =>
      ({ id, kind, displayName, tier, archetype, paperRating, cash, tokens, realizedPnl, feesPaid, gasPaid, snipeTaxPaid, tipsPaid, tipsReceived, trades })),
  };
}

const csv = (rows: (string | number | boolean | null | undefined)[][]) => rows.map((r) => r.map((x) => (x == null ? "" : typeof x === "number" ? +x.toFixed(6) : String(x).replace(/[",\n]/g, " "))).join(",")).join("\n");

/** trades CSV (one row per trade, wallet labels inline) */
export function tradesCsv(r: PaperRound) {
  return csv([["id", "t", "tick", "wallet", "kind", "tier", "archetype", "side", "cash", "tokens", "price", "fee", "gas", "sniperTax", "crewTip", "capped", "pnl", "mcapAfter"],
    ...r.trades.map((t) => { const w = r.wallets[t.walletId]; return [t.id, t.t, t.tick, w.displayName, w.kind, w.tier, w.archetype, t.side, t.cashAmount, t.tokenAmount, t.price, t.fee, t.gasFee, t.snipeTax, t.crewTip, t.capped, t.pnl, t.mcapAfter]; })]);
}
/** curve path CSV, 1 row per second */
export function curveCsv(r: PaperRound) {
  const step = Math.round(1000 / r.cfg.tickMs);
  return csv([["t", "mcap"], ...r.path.filter((_, i) => i % step === 0).map((m, i) => [i, m])]);
}
