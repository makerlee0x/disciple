/**
 * SIMULATOR tramps & walls adapter: the same TrampWallAdapter seam the live panel uses, backed by the sim
 * market's range orders (./pool.ts, TrampWallManager semantics). The player's placements are real liquidity
 * in the sim pool: tramps absorb sells below the price, walls absorb buys above it, bots trade into them,
 * and a keeper closes filled ones for the 0.1% tip. State lives in the SimRun (fresh every run); a read-only
 * mirror goes to the sim-only key SIM_STORAGE.tw ("disciple.sim.tw", never the live "disciple.tw.v1").
 */
import type { Address } from "../protocol";
import { computePreview, pointsFor, type PlaceTrampWallParams, type TrampWall, type TrampWallAdapter, type TrampWallEvent } from "../trampwalls/adapter";
import { SIM_STORAGE } from "./config";
import { YOU, type SimRun } from "./run";
import type { Pool, RangeOrder } from "./pool";

/** the player's address in the sim (the panel compares owners against it) */
export const SIM_ME = "0x00000000000000000000000000000000005111ed" as Address;
/** filled/cancelled orders stay listed (and drawn) this long, in sim seconds */
const RECENT_S = 12;

export function toTrampWall(o: RangeOrder, pool: Pool, S: number, token: Address): TrampWall {
  const g = pool.amounts(o), left = o.kind === "tramp" ? (o.outQuote ?? g.quote) : (o.outTokens ?? g.tokens);
  return {
    id: String(o.id), token, owner: (o.owner === YOU ? SIM_ME : o.owner) as Address, kind: o.kind,
    mcapUsd: o.a * o.b * S, mcapLoUsd: o.a * o.a * S, mcapHiUsd: o.b * o.b * S,
    amount: BigInt(Math.max(0, Math.floor(o.deposit * 1e6))), sizeUsd: o.sizeUsd,
    status: o.status, filledFrac: o.deposit > 0 ? Math.max(0, Math.min(1, 1 - left / o.deposit)) : 0,
    feesEarnedUsd: 0,   // no LP yield on a range order in the sim (the contract has none either)
    pointsEarned: o.owner === YOU && o.status === "filled" ? pointsFor(o.kind, o.sizeUsd) : 0,
    createdAt: o.placedT * 1000, filledAt: o.status === "filled" && o.closedT != null ? o.closedT * 1000 : undefined,
  };
}

export function createSimTrampWallAdapter(getRun: () => SimRun | null, storage?: Pick<Storage, "setItem">): TrampWallAdapter {
  const live = (token: Address) => {
    const r = getRun(), pool = r?.m.pool; if (!r || !pool) return [];
    const out = pool.orders.filter((o) => o.status === "active" || (o.closedT != null && r.t - o.closedT < RECENT_S)).map((o) => toTrampWall(o, pool, r.m.S, token));
    try { storage?.setItem(SIM_STORAGE.tw, JSON.stringify(out.map((t) => ({ ...t, amount: String(t.amount) })))); } catch { /* ignore */ }
    return out;
  };
  return {
    async isGraduated() { return getRun()?.m.phase === "pool"; },
    async list(token) { return live(token); },
    async listMine(owner, token) {
      const r = getRun(), pool = r?.m.pool; if (!r || !pool || owner !== SIM_ME) return [];
      return pool.orders.filter((o) => o.owner === YOU).slice(-20).reverse().map((o) => toTrampWall(o, pool, r.m.S, token ?? ("SIMULATOR" as Address)));
    },
    async preview(p, cur) {
      const pv = { ...computePreview(p, cur), estFeeShareUsdPerDay: 0 }, r = getRun();
      if (!r?.m.pool) return { ...pv, valid: false, reason: "Tramps & walls open after graduation" };
      if (pv.valid && p.kind === "tramp" && p.sizeUsd > r.player.cash + 1e-9) return { ...pv, valid: false, reason: `insufficient sim balance (${r.player.cash.toFixed(2)})` };
      if (pv.valid && p.kind === "wall" && p.mcapUsd > 0 && p.sizeUsd / (p.mcapUsd / r.m.S) > r.player.pos.size * (1 + 1e-9)) return { ...pv, valid: false, reason: "not enough tokens for this wall — buy some first" };
      return pv;
    },
    async place(p: PlaceTrampWallParams) {
      const r = getRun(); if (!r) return { ok: false, reason: "no sim run" };
      const res = r.playerPlace(p.kind, p.mcapUsd, p.rangeWidthPct ?? 2, p.sizeUsd);
      return res.ok ? { ok: true, id: String(res.id), txHash: "sim:tw:" + res.id } : { ok: false, reason: res.reason };
    },
    async cancel(id) {
      const r = getRun(); if (!r) return { ok: false, reason: "no sim run" };
      const res = r.playerCancel(+id); return res.ok ? { ok: true, txHash: "sim:tw-cancel:" + id } : res;
    },
    onEvent(token, cb) {
      const r = getRun(); if (!r) return () => {};
      const off = r.on(({ order }) => {
        const pool = r.m.pool; if (!order || !pool) return;
        const tw = toTrampWall(order, pool, r.m.S, token);
        const e: TrampWallEvent = order.status === "active" ? { type: "Placed", tw }
          : order.status === "cancelled" ? { type: "Cancelled", id: tw.id, token }
          : { type: "Filled", id: tw.id, token, filledAt: tw.filledAt ?? Date.now(), pointsEarned: tw.pointsEarned };
        cb(e);
      });
      return () => { off(); };
    },
  };
}
