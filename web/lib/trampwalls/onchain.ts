/**
 * On-chain TrampWallAdapter → DISCIPLE FLOW TrampWallManager (graduated v4 coins only).
 * Rendering stays in PR #9 (TrampWallPanel / engine); this file only talks to chain.
 *
 * Price/tick math (contracts/docs/frontend-api.md):
 *   price (quote raw per token raw) = 1.0001^tick      if tokenIsCurrency0
 *                                   = 1.0001^-tick     otherwise
 *   mcapUsd = price × totalSupplyRaw × quotePriceUsd / 1e36   (quotePriceUsd = USD WAD per 1e18 quote raw)
 * Tramp = quote-only range strictly below price; Wall = token-only range strictly above. Ticks are multiples of 60.
 * No fee share: TrampWallManager rev2 has no claimFees/pendingFees and the hook no longer donates to in-range LPs
 * (contracts/docs/redeploy-migration.md, revision 3), so nothing here reads or promises LP yield.
 */
import { decodeEventLog, encodeFunctionData, type Hex, type Log, type PublicClient } from "viem";
import { bondingCurveAbi, trampWallManagerAbi } from "../abi";
import { deployment } from "../chains";
import type { Address } from "../protocol";
import { curveOf, curveParams, friendlyError, publicClient, quoteRawToUsd } from "../protocol-viem";
import { execCalls } from "../wallet";
import { placeTramp, placeWall } from "../trampWall";
import {
  computePreview, pointsEarned, pointsFor, type PlaceTrampWallParams, type TrampWall, type TrampWallAdapter, type TrampWallEvent,
} from "./adapter";

const B = BigInt;
const LN_1_0001 = Math.log(1.0001);
export const TICK_SPACING = 60;
const mgr = () => deployment().trampWallManager;

/* ---------------- tick <-> mcap ---------------- */

export interface PoolCtx {
  tick: number;
  tickSpacing: number;
  tokenIsCurrency0: boolean;
  quote: Address;
  /** USD per quote raw unit. */
  usdPerQuoteRaw: number;
  totalSupplyRaw: number;
}

export async function poolCtx(pc: PublicClient, token: Address): Promise<PoolCtx> {
  const curve = await curveOf(pc, token);
  const [[tick, , tickSpacing, tokenIsCurrency0], qp, quote, p] = await Promise.all([
    pc.readContract({ address: mgr(), abi: trampWallManagerAbi, functionName: "poolState", args: [token] }),
    pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "quotePriceUsd" }),
    pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "quote" }),
    curveParams(pc, curve),
  ]);
  return { tick: Number(tick), tickSpacing: Number(tickSpacing) || TICK_SPACING, tokenIsCurrency0, quote,
           usdPerQuoteRaw: Number(qp) / 1e36, totalSupplyRaw: Number(p.totalSupply) };
}

/** Raw price (quote raw per token raw) at a tick. */
export const priceAtTick = (c: PoolCtx, tick: number) => Math.exp((c.tokenIsCurrency0 ? tick : -tick) * LN_1_0001);
export const mcapAtTick = (c: PoolCtx, tick: number) => priceAtTick(c, tick) * c.totalSupplyRaw * c.usdPerQuoteRaw;
/** Unaligned tick for an mcap (USD). */
export function tickAtMcap(c: PoolCtx, mcapUsd: number) {
  const price = mcapUsd / (c.totalSupplyRaw * c.usdPerQuoteRaw);
  const t = Math.log(price) / LN_1_0001;
  return c.tokenIsCurrency0 ? t : -t;
}
const floorTo = (t: number, s: number) => Math.floor(t / s) * s;
const ceilTo = (t: number, s: number) => Math.ceil(t / s) * s;

/**
 * Aligned [tickLower, tickUpper] for an mcap band, forced single-sided:
 * tramp ⇒ whole range below price, wall ⇒ whole range above (in price terms; flipped in tick space when token is c1).
 */
export function rangeFor(c: PoolCtx, kind: "tramp" | "wall", mcapLoUsd: number, mcapHiUsd: number): [number, number] {
  const s = c.tickSpacing;
  const a = tickAtMcap(c, mcapLoUsd), b = tickAtMcap(c, mcapHiUsd);
  let lo = floorTo(Math.min(a, b), s), hi = ceilTo(Math.max(a, b), s);
  if (hi === lo) hi = lo + s;
  // "below price" = lower ticks when token is c0, higher ticks when token is c1.
  const belowIsLowTicks = c.tokenIsCurrency0;
  const wantLowTicks = (kind === "tramp") === belowIsLowTicks;
  if (wantLowTicks && hi > floorTo(c.tick, s)) { const w = hi - lo; hi = floorTo(c.tick, s); if (hi > c.tick - 1) hi -= s; lo = hi - w; }
  if (!wantLowTicks && lo <= c.tick) { const w = hi - lo; lo = floorTo(c.tick, s) + s; hi = lo + w; }
  return [lo, hi];
}

/** Fraction of the range the current price has crossed (0 untouched … 1 filled). */
function filledFrac(c: PoolCtx, kind: "tramp" | "wall", lo: number, hi: number) {
  const f = (c.tick - lo) / (hi - lo);
  const fracUp = Math.max(0, Math.min(1, f)); // share of range below current tick
  // tramp fills as price FALLS through it; wall as price RISES. In tick space flip for token=c1.
  const priceUpIsTickUp = c.tokenIsCurrency0;
  const crossedUp = priceUpIsTickUp ? fracUp : 1 - fracUp;
  return kind === "wall" ? crossedUp : 1 - crossedUp;
}

/* ---------------- reads ---------------- */

type L = Log & { eventName: string; args: Record<string, unknown> };

/** cancelled: the position was closed by its owner (Cancelled log); an inactive position without one was pulled by a
 *  keeper after a full cross (Filled) — the only state that earns points. Crossed-but-not-pulled stays "active". */
async function readOne(pc: PublicClient, id: bigint, c: PoolCtx, placed?: { amount: bigint; at: number }, cancelled = false): Promise<TrampWall> {
  const [owner, token, tl, tu, , kindN, active] = await pc.readContract({ address: mgr(), abi: trampWallManagerAbi, functionName: "positions", args: [id] });
  const kind = Number(kindN) === 0 ? "tramp" : "wall";
  const lo = Number(tl), hi = Number(tu);
  const filled = active ? await pc.readContract({ address: mgr(), abi: trampWallManagerAbi, functionName: "isFilled", args: [id] }) : true;
  const mA = mcapAtTick(c, lo), mB = mcapAtTick(c, hi);
  const mcapLoUsd = Math.min(mA, mB), mcapHiUsd = Math.max(mA, mB);
  const amount = placed?.amount ?? B(0);
  // order size $: tramp = quote deposited; wall = tokens at the range's centre price (≈ quote received when filled)
  const sizeUsd = kind === "tramp" ? Number(amount) * c.usdPerQuoteRaw : Number(amount) * priceAtTick(c, (lo + hi) / 2) * c.usdPerQuoteRaw;
  const status = active ? "active" : cancelled ? "cancelled" : "filled";
  return {
    id: id.toString(), token: token as Address, owner: owner as Address, kind,
    mcapUsd: Math.sqrt(mcapLoUsd * mcapHiUsd), mcapLoUsd, mcapHiUsd, tickLower: lo, tickUpper: hi,
    amount, sizeUsd, status, filledFrac: active ? (filled ? 1 : filledFrac(c, kind, lo, hi)) : status === "filled" ? 1 : 0,
    pointsEarned: pointsEarned({ status, sizeUsd }),
    createdAt: placed?.at ?? Date.now(),
  };
}

async function placedLogs(pc: PublicClient, filter: { token?: Address; owner?: Address }) {
  const base = { address: mgr(), abi: trampWallManagerAbi, fromBlock: deployment().fromBlock, toBlock: "latest" as const };
  const [t, w, x] = await Promise.all([
    pc.getContractEvents({ ...base, eventName: "TrampPlaced", args: filter }),
    pc.getContractEvents({ ...base, eventName: "WallPlaced", args: filter }),
    pc.getContractEvents({ ...base, eventName: "Cancelled", args: filter }),
  ]);
  const placed = new Map<string, { id: bigint; token: Address; amount: bigint; block: bigint }>();
  for (const l of [...t, ...w] as unknown as L[]) {
    const a = l.args as Record<string, bigint | string>;
    placed.set(String(a.id), { id: a.id as bigint, token: a.token as Address, amount: (a.quoteAmt ?? a.tokenAmt) as bigint, block: l.blockNumber ?? B(0) });
  }
  const cancelled = new Set((x as unknown as L[]).map((l) => String(l.args.id)));
  return { placed: Array.from(placed.values()), cancelled };
}

/* ---------------- adapter ---------------- */

export interface OnchainTrampWallAdapter extends TrampWallAdapter {
  /** Permissionless: settle a crossed position to its owner (anyone may call; no tip in v0). */
  pull(id: string): Promise<{ ok: boolean; txHash?: string; reason?: string }>;
  /** Opportunistic keeper: pull up to `max` filled-but-unsettled positions on this coin with the connected wallet. */
  pullFilled(token: Address, max?: number): Promise<string[]>;
}

export function createOnchainAdapter(pc: PublicClient = publicClient()): OnchainTrampWallAdapter {
  const ctxCache = new Map<string, { at: number; c: PoolCtx }>();
  async function ctx(token: Address) {
    const k = token.toLowerCase(), hit = ctxCache.get(k);
    if (hit && Date.now() - hit.at < 5000) return hit.c;
    const c = await poolCtx(pc, token);
    ctxCache.set(k, { at: Date.now(), c });
    return c;
  }

  // Writes go through the shared wallet seam (smart account userOp when signed in; refuses when signed out — bug #3:
  // this used to call the injected wallet directly, so MetaMask could place/cancel without a DISCIPLE sign-in).
  async function send(fn: "cancel" | "pull", id: string) {
    try {
      const r = await execCalls([{ to: mgr(), data: encodeFunctionData({ abi: trampWallManagerAbi, functionName: fn, args: [B(id)] }) }]);
      return { ok: true, txHash: r.txHash };
    } catch (e) { return { ok: false, reason: friendlyError(e).message }; }
  }

  async function listBy(filter: { token?: Address; owner?: Address }) {
    const { placed, cancelled } = await placedLogs(pc, filter);
    const out = await Promise.all(placed.map(async (p) => {
      return readOne(pc, p.id, await ctx(p.token), { amount: p.amount, at: Date.now() }, cancelled.has(p.id.toString()));
    }));
    return out.sort((a, b) => b.mcapUsd - a.mcapUsd);
  }

  const adapter: OnchainTrampWallAdapter = {
    async isGraduated(token) {
      try {
        const curve = await curveOf(pc, token);
        return await pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "graduated" });
      } catch { return false; }
    },
    list: (token) => listBy({ token }),
    listMine: async (owner, token) => listBy(token ? { owner, token } : { owner }),

    async preview(p, currentMcapUsd) {
      const pv = computePreview(p, currentMcapUsd);
      try {
        const c = await ctx(p.token);
        const [lo, hi] = rangeFor(c, p.kind, pv.mcapLoUsd, pv.mcapHiUsd);
        const a = mcapAtTick(c, lo), b = mcapAtTick(c, hi);
        return { ...pv, mcapLoUsd: Math.min(a, b), mcapHiUsd: Math.max(a, b) }; // snapped to 60-tick grid
      } catch { return pv; }
    },

    async place(p: PlaceTrampWallParams) {
      try {
        if (!(await adapter.isGraduated(p.token))) return { ok: false, reason: "Tramps & walls open after graduation." };
        const c = await ctx(p.token);
        const w = (p.rangeWidthPct ?? 2) / 100;
        const [lo, hi] = rangeFor(c, p.kind, p.mcapUsd * (1 - w / 2), p.mcapUsd * (1 + w / 2));
        // minLiquidity 1: range is single-sided, no price slippage. ONE userOp (exact approve + place) via lib/trampWall.
        const r = p.kind === "tramp" ? await placeTramp(p.token, c.quote, lo, hi, p.amount, B(1)) : await placeWall(p.token, lo, hi, p.amount, B(1));
        let id = "";
        for (const l of r.logs) {
          if (l.address.toLowerCase() !== mgr().toLowerCase()) continue;
          try { const ev = decodeEventLog({ abi: trampWallManagerAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }); if (ev.eventName === "TrampPlaced" || ev.eventName === "WallPlaced") { id = String((ev.args as { id: bigint }).id); break; } } catch { /* other event */ }
        }
        return { ok: true, id, txHash: r.txHash };
      } catch (e) { return { ok: false, reason: friendlyError(e).message }; }
    },

    cancel: (id) => send("cancel", id),
    pull: (id) => send("pull", id),

    async pullFilled(token, max = 3) {
      const done: string[] = [];
      const { placed, cancelled } = await placedLogs(pc, { token });
      for (const p of placed) {
        if (done.length >= max) break;
        if (cancelled.has(p.id.toString())) continue;
        const [, , , , , , active] = await pc.readContract({ address: mgr(), abi: trampWallManagerAbi, functionName: "positions", args: [p.id] });
        if (!active) continue;
        if (!(await pc.readContract({ address: mgr(), abi: trampWallManagerAbi, functionName: "isFilled", args: [p.id] }))) continue;
        const r = await send("pull", p.id.toString());
        if (r.ok) done.push(p.id.toString());
      }
      return done;
    },

    onEvent(token, cb: (e: TrampWallEvent) => void) {
      const stops: (() => void)[] = [];
      stops.push(pc.watchContractEvent({
        address: mgr(), abi: trampWallManagerAbi, args: { token },
        onLogs: async (logs) => {
          for (const l of logs as unknown as L[]) {
            const a = l.args as Record<string, bigint | string>;
            const id = String(a.id);
            if (l.eventName === "TrampPlaced" || l.eventName === "WallPlaced") {
              try { cb({ type: "Placed", tw: await readOne(pc, a.id as bigint, await ctx(token), { amount: (a.quoteAmt ?? a.tokenAmt) as bigint, at: Date.now() }) }); } catch { /* ignore */ }
            } else if (l.eventName === "Cancelled") cb({ type: "Cancelled", id, token });
            else if (l.eventName === "Filled") {
              let pts = 0;
              try { const { placed } = await placedLogs(pc, { token }); const pl = placed.find((x) => x.id === (a.id as bigint));
                const tw = await readOne(pc, a.id as bigint, await ctx(token), pl ? { amount: pl.amount, at: Date.now() } : undefined); pts = pointsFor(tw.sizeUsd); } catch { /* ignore */ }
              cb({ type: "Filled", id, token, filledAt: Date.now(), pointsEarned: pts });
            }
          }
        },
      }));
      return () => stops.forEach((s) => s());
    },
  };
  return adapter;
}

/** USD helper for callers sizing a tramp in quote raw units. */
export async function usdToQuoteRaw(pc: PublicClient, token: Address, usd: number) {
  const curve = await curveOf(pc, token);
  const qp = await pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "quotePriceUsd" });
  return (B(Math.round(usd * 1e6)) * B(1e18) * B(1e18)) / (qp * B(1e6));
}
export { quoteRawToUsd };
