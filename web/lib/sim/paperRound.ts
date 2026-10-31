/**
 * PAPER TRADING on the coin screen: pure adapters from a SimRun (+ PaperBrain) to the coin screen's existing inputs, and
 * the round bookkeeping (standings, results, dev export, scripted personas for tuning). No chain, wallet or RPC: every
 * number here is simulated. Holder rows use the same HoldersSnapshot shape lib/flight/holdersReal + engine.js read;
 * trade ticks use DexChart's "disciple:event" Trade shape; bot names come from lib/defaultUsername (the live default).
 */
import { defaultUsername } from "@/lib/defaultUsername";
import { YOU, type SimRun, type SimTrade } from "./run";
import { ARCH_LABEL, START_CASH, type PaperBrain, type Tier } from "./paper";

/** the player's row id in holders / standings / trades */
export const PAPER_ME = YOU;
/** simulated epoch for chart timestamps: round second t → PAPER_EPOCH_MS + t × 1000 */
export const PAPER_EPOCH_MS = Date.UTC(2026, 0, 1);
/** DexChart simEvent name (PaperCoin dispatches tradeTick() payloads on it) */
export const PAPER_TRADE_EVENT = "disciple:papertrade";

export const botDisplayName = (wallet: string) => defaultUsername(wallet) || wallet.slice(0, 6);

export interface PaperHolderRow { address: string; balance: string; tokens: number; pct: number; usd: number; label: "pool" | "curve" | "locker" | "burn" | null; mine: boolean; name?: string }
/** HoldersSnapshot for 'disciple:holders-real': bots + you (by tokens), then system rows — Bonding curve before ASCEND,
 *  Pool (tokens in the pool) + Locked LP (the locked graduation floor, $) after. */
export function holdersSnapshot(run: SimRun, top = 60) {
  const S = run.m.S, px = run.m.price(), wei = (t: number) => BigInt(Math.max(0, Math.round(t * 1e6))) * BigInt(1e12);
  const row = (address: string, tokens: number, mine: boolean, name?: string): PaperHolderRow =>
    ({ address, balance: wei(tokens).toString(), tokens, pct: tokens / S * 100, usd: tokens * px, label: null, mine, name });
  const rows: PaperHolderRow[] = [];
  for (const b of run.bots) if (b.pos.size > 1e-6) rows.push(row(b.wallet, b.pos.size, false, botDisplayName(b.wallet)));
  if (run.player.pos.size > 1e-6) rows.push(row(PAPER_ME, run.player.pos.size, true, "you"));
  rows.sort((a, b) => b.tokens - a.tokens);
  const out = rows.slice(0, top);
  if (run.m.phase === "curve") out.push({ ...row("0x00000000000000000000000000000000000c0e7e", S - run.m.sold, false), label: "curve" });
  else if (run.m.pool) {
    const P = run.m.pool; out.push({ ...row("0x0000000000000000000000000000000000000001", P.Y, false), label: "pool" });
    const fl = P.floorState(), fq = fl.quote, ft = fl.tokens;
    out.push({ ...row("0x00000000000000000000000000000000001f1001", ft, false), usd: fq + ft * px, label: "locker" });
  }
  return { rows: out, asOfBlock: run.blk, source: "sim" as const, at: PAPER_EPOCH_MS + run.t * 1000 };
}

/** DexChart tick ("disciple:event" Trade shape + a simulated ts) */
export function tradeTick(tr: SimTrade, i: number) {
  return { type: "Trade", token: "SIMULATOR", mcapUsd: tr.mcap, usd: tr.usd, side: tr.side, txHash: `sim-${i}`, logIndex: 0, block: Math.round(tr.t * 10), ts: PAPER_EPOCH_MS + tr.t * 1000 };
}
/** 'disciple:feednames' map {lc wallet → default name} so the Trades card names bots like live wallets */
export function feedNames(run: SimRun) { const o: Record<string, string> = {}; for (const b of run.bots) o[b.wallet.toLowerCase()] = botDisplayName(b.wallet); return o; }

export interface Standing { rank: number; wallet: string; name: string; kind: "human" | "bot"; tier: Tier | "player"; arch: string; cash: number; value: number; worth: number; pnl: number; realized: number; fees: number; trades: number }
/** ranked by cash + position value (mark; open tramps/walls at pool value); ties → higher realized, then fewer fees */
export function standings(run: SimRun, brain: PaperBrain): Standing[] {
  const px = run.m.price(), sc = START_CASH[brain.difficulty];
  const ordersVal = (owner: string) => { if (!run.m.pool) return 0; let v = 0; for (const o of run.ordersOf(owner)) { const g = run.m.pool.amounts(o); v += g.quote + g.tokens * px; } return v; };
  const rows: Standing[] = run.bots.map((b) => { const M = brain.meta.get(b.id), value = b.pos.size * px, worth = b.cash + value + ordersVal(b.wallet);
    return { rank: 0, wallet: b.wallet, name: botDisplayName(b.wallet), kind: "bot", tier: M?.tier ?? "easy", arch: M ? ARCH_LABEL[M.arch] : b.arch, cash: b.cash, value, worth, pnl: worth - sc, realized: b.pos.realized, fees: b.pos.fees ?? 0, trades: b.buys + b.sells }; });
  const P = run.player, value = P.pos.size * px, worth = P.cash + value + ordersVal(YOU);
  rows.push({ rank: 0, wallet: YOU, name: "you", kind: "human", tier: "player", arch: "you", cash: P.cash, value, worth, pnl: worth - P.cash0, realized: P.pos.realized, fees: P.pos.fees ?? 0, trades: P.buys + P.sells });
  rows.sort((a, b) => b.worth - a.worth || b.realized - a.realized || a.fees - b.fees);
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}

/** money check: start money = Σ cash + curve reserve / pool quote + fees + sniper tax + gas (+ floor) — tested */
export function moneyCheck(run: SimRun, brain: PaperBrain) {
  const start = START_CASH[brain.difficulty] * (run.bots.length) + run.player.cash0;
  const cash = run.bots.reduce((a, b) => a + b.cash, 0) + run.player.cash;
  return { start, cash, fees: brain.totals.fees, gas: brain.totals.gas, snipeTax: brain.totals.snipeTax, reserve: run.m.phase === "curve" ? run.m.reserveAt(run.m.g) : null };
}

/** the player's best round trip: largest realized PnL booked on a single sell */
export function bestTrade(run: SimRun, brain: PaperBrain) {
  let best: { t: number; pnl: number; usd: number } | null = null;
  // replay the player's fills through the same average-cost ledger
  let size = 0, cost = 0;
  for (const tr of brain.log) {
    if (!tr.mine) continue;
    if (tr.side === "buy") { size += tr.tokens; cost += tr.usd; }
    else { const basis = size > 0 ? cost * Math.min(1, tr.tokens / size) : 0, pnl = tr.usd * (1 - run.m.fee) - basis; size -= tr.tokens; cost -= basis; if (!best || pnl > best.pnl) best = { t: tr.t, pnl, usd: tr.usd }; }
  }
  return best;
}

export function roundSummary(run: SimRun, brain: PaperBrain) {
  const st = standings(run, brain), me = st.find((s) => s.kind === "human")!, byTier: Record<string, { n: number; avgWorth: number; avgPnl: number }> = {}, byArch: Record<string, { n: number; avgPnl: number; trades: number }> = {};
  for (const s of st) {
    const t = (byTier[s.tier] ??= { n: 0, avgWorth: 0, avgPnl: 0 }); t.n++; t.avgWorth += s.worth; t.avgPnl += s.pnl;
    const a = (byArch[s.arch] ??= { n: 0, avgPnl: 0, trades: 0 }); a.n++; a.avgPnl += s.pnl; a.trades += s.trades;
  }
  for (const v of Object.values(byTier)) { v.avgWorth /= v.n; v.avgPnl /= v.n; }
  for (const v of Object.values(byArch)) v.avgPnl /= v.n;
  return {
    simulated: true, difficulty: brain.difficulty, seed: run.seed, simSeconds: +run.t.toFixed(1), bots: run.bots.length, startCash: START_CASH[brain.difficulty],
    graduated: run.m.gradAt != null, graduationSec: run.m.gradAt != null ? +run.m.gradAt.toFixed(1) : null, peakMcap: Math.round(run.peak), finalMcap: Math.round(run.m.mcap()),
    trades: brain.totals.trades, fees: +brain.totals.fees.toFixed(2), gas: +brain.totals.gas.toFixed(2), sniperTax: +brain.totals.snipeTax.toFixed(2), sniperTaxHits: brain.totals.snipeHits,
    player: { rank: me.rank, of: st.length, worth: +me.worth.toFixed(2), pnl: +me.pnl.toFixed(2), trades: me.trades, bestTrade: bestTrade(run, brain) },
    byTier, byArchetype: byArch, phases: brain.phaseLog,
  };
}
/** dev-only export (?dev=1 / non-prod) */
export function roundJson(run: SimRun, brain: PaperBrain) {
  return { summary: roundSummary(run, brain), standings: standings(run, brain).map((s) => ({ ...s, cash: +s.cash.toFixed(4), value: +s.value.toFixed(4), worth: +s.worth.toFixed(4), pnl: +s.pnl.toFixed(4) })), inputs: run.inputs };
}
export function tradesCsv(run: SimRun, brain: PaperBrain) {
  const tierOf = new Map(run.bots.map((b) => [b.wallet, brain.meta.get(b.id)]));
  const lines = ["t,side,usd,tokens,mcap,wallet,name,tier,archetype,gas"];
  for (const t of brain.log) { const M = t.wallet ? tierOf.get(t.wallet) : undefined;
    lines.push([t.t.toFixed(1), t.side, t.usd.toFixed(4), t.tokens.toFixed(4), t.mcap.toFixed(2), t.wallet ?? "", t.mine ? "you" : botDisplayName(t.wallet ?? ""), t.mine ? "player" : M?.tier ?? "", t.mine ? "you" : M ? ARCH_LABEL[M.arch] : "", (t.gas ?? 0).toFixed(2)].join(",")); }
  return lines.join("\n");
}

/** scripted players for the tuning suite (spec Sec. 11) — they act through playerTrade(), the same path as the UI */
export type Persona = "novice" | "decent" | "strong";
export interface PersonaState { peak: number; entry: number; ladder: number; last: number }
export const newPersonaState = (): PersonaState => ({ peak: 0, entry: 0, ladder: 0, last: -1e9 });
/** call about once per simulated second */
export function personaAct(run: SimRun, brain: PaperBrain, who: Persona, s: PersonaState, rand: () => number = Math.random) {
  const P = run.player, m = run.m.mcap(), back = (sec: number) => brain.seen(run, 0, sec), gas = run.cfg.player.gasUsd, sc = START_CASH[brain.difficulty];
  const value = P.pos.size * run.m.price(), mom = m / back(10) - 1;
  if (P.pos.size > 0) s.peak = Math.max(s.peak, m);
  const preset = [10, 25, 50, 100].filter((x) => x <= P.cash - gas);
  const size = (f: number) => { const v = sc * f; return preset.length ? preset.reduce((a, x) => (Math.abs(x - v) < Math.abs(a - v) ? x : a)) : 0; };
  const buy = (usd: number) => { if (usd >= 1 && usd <= P.cash - gas) run.playerTrade("buy", usd); };
  const sell = (frac: number) => { if (P.pos.size > 0 && P.cash >= gas) run.playerTrade("sell", 0, { frac }); };
  if (who === "novice") {
    if (mom > 0.05 && rand() < 0.3 && P.cash > 11) buy(size(0.25));
    else if (P.pos.size > 0 && rand() < 0.02) sell(1);
    return;
  }
  if (who === "decent") {
    if (P.pos.size === 0 && mom > 0.04 && run.t > 8 && P.cash > 11) { buy(Math.min(P.cash * 0.4, size(0.4))); s.entry = m; s.ladder = 0; return; }
    if (P.pos.size > 0) {
      const g = m / s.entry - 1;
      if (g < -0.15) { sell(1); return; }
      if (s.ladder === 0 && g > 0.25) { s.ladder = 1; sell(0.5); return; }
      if (s.ladder === 1 && g > 0.5) { s.ladder = 2; sell(1); }
    }
    return;
  }
  let hi = m; for (let i = 1; i <= 60; i += 5) hi = Math.max(hi, back(i));
  if (run.t > 8 && m < hi * 0.9 && P.cash > 11 && value < sc * 0.6 && run.t - s.last > 10) { buy(size(0.2)); s.last = run.t; return; }
  if (P.pos.size > 0 && m < s.peak * 0.9) { sell(1); s.peak = 0; return; }
  if (P.pos.size > 0 && run.m.phase === "curve" && run.m.g > 0.7) sell(0.25);
}
