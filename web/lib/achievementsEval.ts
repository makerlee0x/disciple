/**
 * Pure V1 achievement evaluator (SITE engine core; no I/O, unit-tested in scripts/test-achievements-server.mts).
 * Input: ONE wallet's full history — its fills on every coin, plus the Launched / GraduatedToV4 events of the coins it
 * traded or launched — in any order (sorted here by (block, logIndex)). Output: the first qualifying event per rule
 * (the unlock proof) and per-rule progress. Deterministic: re-running over the same history gives the same unlocks,
 * so the KV engine (lib/server/achievements.ts) can replay a wallet from scratch every time it changes — positions are
 * never carried between runs, so a re-run, a backfill or a re-indexed fill can't double-count.
 * Rules (ids, thresholds) are GAME's data in lib/achievements.ts (V1_RULES); this file only knows criteria kinds.
 */
import type { AchEvent, AchFillEvent, AchPosition, AchievementRule, AchievementUnlockRecord } from "./achievements";

/** dust below which a position counts as empty (tokens are 18-dec floats) */
const DUST = 1e-9;

export interface EvalResult {
  unlocks: AchievementUnlockRecord[];
  /** rule id → { progress, target } (progress clamps at target once unlocked) */
  progress: Record<string, { progress: number; target: number }>;
}

export const ruleTarget = (r: AchievementRule): number => {
  if (r.target && r.target > 0) return r.target;
  const c = r.criteria;
  return c.kind === "realized_profit" ? c.minProfitUsd : c.kind === "realized_multiple" ? c.minMultiple : 1;
};

const order = (a: AchEvent, b: AchEvent) => a.block - b.block || a.logIndex - b.logIndex;

export function evaluateWallet(walletIn: string, events: readonly AchEvent[], rules: readonly AchievementRule[]): EvalResult {
  const wallet = walletIn.toLowerCase();
  const evs = [...events].sort(order);
  const pos = new Map<string, AchPosition>();
  const posOf = (coin: string) => pos.get(coin) ?? pos.set(coin, { tokens: 0, basisUsd: 0, curveTokens: 0, curveBuyUsd: 0 }).get(coin)!;
  const creatorOf = new Map<string, { creator: string; anon: boolean }>();
  /** the wallet's curve buys per tx:coin (graduating_buy: the buy just before GraduatedToV4 in the same tx) */
  const curveBuysInTx = new Map<string, AchFillEvent[]>();
  const unlocked = new Map<string, AchievementUnlockRecord>();
  const best = new Map<string, number>();
  const bump = (id: string, v: number) => { if (v > (best.get(id) ?? 0)) best.set(id, v); };
  const unlock = (r: AchievementRule, e: AchEvent, coin?: string) => {
    if (unlocked.has(r.id)) return;
    unlocked.set(r.id, { id: r.id, wallet, coin, tx: e.tx, block: e.block, logIndex: e.logIndex, ts: e.ts });
  };

  for (const e of evs) {
    if (e.kind === "launch") {
      creatorOf.set(e.coin, { creator: e.creator.toLowerCase(), anon: e.anon });
      if (e.creator.toLowerCase() === wallet && !e.anon) for (const r of rules) if (r.criteria.kind === "launch") unlock(r, e, e.coin);
      continue;
    }
    if (e.kind === "graduation") {
      const p = pos.get(e.coin);
      const c = creatorOf.get(e.coin);
      const mineGradBuy = (curveBuysInTx.get(`${e.tx}:${e.coin}`) ?? []).filter((f) => f.logIndex < e.logIndex).sort((a, b) => b.logIndex - a.logIndex)[0];
      for (const r of rules) {
        const k = r.criteria;
        if (k.kind === "launch_graduated" && c && !c.anon && c.creator === wallet) unlock(r, e, e.coin);
        else if (k.kind === "held_through_graduation" && p && p.curveTokens > DUST && p.curveBuyUsd >= k.minCurveBuyUsd) unlock(r, e, e.coin);
        // proof = the graduating buy itself (the player's tx/log), not the GraduatedToV4 log
        else if (k.kind === "graduating_buy" && mineGradBuy && mineGradBuy.usd >= k.minUsd) unlock(r, mineGradBuy, e.coin);
      }
      continue;
    }
    // fill
    if (e.wallet.toLowerCase() !== wallet) continue;
    const p = posOf(e.coin);
    const usd = Number.isFinite(e.usd) && e.usd > 0 ? e.usd : 0;
    if (e.side === "buy") {
      p.tokens += e.tokens; p.basisUsd += usd;
      if (e.venue === "curve") {
        p.curveTokens += e.tokens; p.curveBuyUsd += usd;
        const k = `${e.tx}:${e.coin}`; (curveBuysInTx.get(k) ?? curveBuysInTx.set(k, []).get(k)!).push(e);
      }
      for (const r of rules) if (r.criteria.kind === "buy" && usd >= r.criteria.minUsd) unlock(r, e, e.coin);
      continue;
    }
    // sell: average-cost basis of the tokens sold that this wallet BOUGHT (transfer-in tokens have no basis ⇒ ignored)
    const q = Math.min(e.tokens, Math.max(0, p.tokens));
    const basis = p.tokens > DUST ? p.basisUsd * (q / p.tokens) : 0;
    const proceeds = e.tokens > 0 ? usd * (q / e.tokens) : 0;
    if (p.tokens > DUST) { p.basisUsd -= basis; p.tokens -= q; if (p.tokens <= DUST) { p.tokens = 0; p.basisUsd = 0; } }
    if (e.venue === "curve") p.curveTokens = Math.max(0, p.curveTokens - e.tokens);
    const profit = proceeds - basis, mult = basis > 0 ? proceeds / basis : 0;
    for (const r of rules) {
      const k = r.criteria;
      if (k.kind === "sell_impact") { if (e.impactBps !== undefined && e.impactBps >= k.minImpactBps && usd >= k.minUsd) unlock(r, e, e.coin); }
      else if (k.kind === "realized_profit" && q > DUST) { bump(r.id, profit); if (profit >= k.minProfitUsd) unlock(r, e, e.coin); }
      else if (k.kind === "realized_multiple" && q > DUST && basis >= k.minBasisUsd) { bump(r.id, mult); if (mult >= k.minMultiple) unlock(r, e, e.coin); }
    }
  }

  const progress: EvalResult["progress"] = {};
  for (const r of rules) {
    const target = ruleTarget(r);
    progress[r.id] = { progress: unlocked.has(r.id) ? target : Math.max(0, Math.min(target, best.get(r.id) ?? 0)), target };
  }
  return { unlocks: rules.map((r) => unlocked.get(r.id)).filter((x): x is AchievementUnlockRecord => !!x), progress };
}
