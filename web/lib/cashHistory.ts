/**
 * Flight log money rows (maker 2026-11-18: "the flight log should have transaction history of marketplace buys/sells,
 * deposits, withdraws, all of that"). Pure, shared by the server route (app/api/cash/history) and its tests.
 *
 * Source of truth is the chain: every USDG Transfer to or from the pilot's cash address, grouped by tx. Each tx is then
 * labelled from what Disciple already knows about it:
 *   market   a sold listing's tx (or, for an admin settle with no tx, the matching amount right before soldAt)
 *   turbo    out to a Turbo deposit address the server handed this pilot; in, right after a Turbo cash-back
 *   fees     in from the creator-fee contracts          rewards  in from the referral registry
 *   protocol legs (router, curve, hook…) are trades: the BOOST / DUMP rows already show those, so they're dropped
 *   anything else is a plain deposit (in) or withdrawal (out)
 */

export type CashKind = "deposit" | "withdraw" | "turbo-in" | "turbo-out" | "bought" | "sold" | "fees" | "rewards";
export interface CashRow {
  /** tx hash (one row per tx), or `mkt:<listing>` for a sale with no tx */
  id: string; ts: number; kind: CashKind; usd: number;
  /** market rows: the item's name; deposit / withdraw: the other address */
  text?: string; item?: string; tx?: string;
}
/** One USDG Transfer leg that touches the pilot (from or to them). */
export interface UsdgLeg { tx: string; block: number; logIndex: number; ts: number; from: string; to: string; usd: number }
/** A sold listing the pilot was in, as the market stored it. price in cents. */
export interface MarketSide { listing: string; side: "bought" | "sold"; item: string; name: string; price: number; sellerGets: number; soldAt: number; tx?: string }
export interface CashTags {
  /** every protocol contract (router, curve, hook, launchpad…), lowercase: their legs are trades */
  protocol: ReadonlySet<string>;
  fees: ReadonlySet<string>;
  rewards: ReadonlySet<string>;
  /** Turbo deposit addresses this pilot was given, lowercase */
  turboIn: ReadonlySet<string>;
  /** Turbo cash-backs this pilot started: when, and how much */
  turboOut: readonly { at: number; usd: number }[];
  market: readonly MarketSide[];
}

const lc = (a: string) => a.toLowerCase();
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** Turbo cash-back lands within this long after it's sent (Relay is ~seconds; Lighter's pool can take minutes). */
export const TURBO_BACK_MS = 60 * 60_000;
/** An admin-settled sale with no tx: the payment confirms just before soldAt. */
const SALE_WINDOW_MS = 15 * 60_000;

export function cashRows(walletIn: string, legs: readonly UsdgLeg[], tags: CashTags): CashRow[] {
  const w = lc(walletIn);
  const byTx = new Map<string, UsdgLeg[]>();
  for (const l of legs) { if (lc(l.from) !== w && lc(l.to) !== w) continue; const g = byTx.get(l.tx); if (g) g.push(l); else byTx.set(l.tx, [l]); }
  const marketByTx = new Map(tags.market.filter((m) => m.tx).map((m) => [lc(m.tx!), m]));
  const noTx = tags.market.filter((m) => !m.tx);
  const usedSale = new Set<string>();
  const backs = [...tags.turboOut].sort((a, b) => a.at - b.at), usedBack = new Set<number>();
  const out: CashRow[] = [];

  const groups = [...byTx.entries()].map(([tx, g]) => ({ tx, g, ts: Math.min(...g.map((x) => x.ts)) })).sort((a, b) => a.ts - b.ts);
  for (const { tx, g, ts } of groups) {
    // a leg to or from a protocol contract means the tx was a trade (or a launch): the BOOST / DUMP rows cover it
    if (g.some((l) => tags.protocol.has(lc(lc(l.from) === w ? l.to : l.from)))) continue;
    const ins = g.filter((l) => lc(l.to) === w && lc(l.from) !== w), outs = g.filter((l) => lc(l.from) === w && lc(l.to) !== w);
    const inUsd = ins.reduce((s, l) => s + l.usd, 0), outUsd = outs.reduce((s, l) => s + l.usd, 0);
    const net = inUsd - outUsd;
    if (Math.abs(net) < 0.005) continue;
    const mk = marketByTx.get(lc(tx)) ?? matchNoTx(noTx, usedSale, net, ts);
    if (mk) {
      usedSale.add(mk.listing);
      out.push({ id: tx, ts: mk.soldAt || ts, kind: mk.side, usd: Math.abs(net), text: mk.name, item: mk.item, tx });
      continue;
    }
    if (outs.some((l) => tags.turboIn.has(lc(l.to)))) { out.push({ id: tx, ts, kind: "turbo-in", usd: outUsd, tx }); continue; }
    if (net > 0) {
      const src = lc(ins.sort((a, b) => b.usd - a.usd)[0].from);
      if (tags.fees.has(src)) { out.push({ id: tx, ts, kind: "fees", usd: net, tx }); continue; }
      if (tags.rewards.has(src)) { out.push({ id: tx, ts, kind: "rewards", usd: net, tx }); continue; }
      const bi = backs.findIndex((b, i) => !usedBack.has(i) && ts >= b.at - 60_000 && ts <= b.at + TURBO_BACK_MS && net <= b.usd + 0.01 && net >= b.usd * 0.9 - 1);
      if (bi >= 0) { usedBack.add(bi); out.push({ id: tx, ts, kind: "turbo-out", usd: net, tx }); continue; }
      out.push({ id: tx, ts, kind: "deposit", usd: net, text: short(src), tx });
    } else {
      const dst = outs.sort((a, b) => b.usd - a.usd)[0].to;
      out.push({ id: tx, ts, kind: "withdraw", usd: -net, text: short(dst), tx });
    }
  }
  // sales the chain scan hasn't reached yet (or an admin settle with no matching payment) still show, from the market's record
  const seen = new Set(out.filter((r) => r.kind === "bought" || r.kind === "sold").map((r) => r.text + "|" + r.ts));
  for (const m of tags.market) {
    if (usedSale.has(m.listing) || (m.tx && byTx.has(m.tx)) || seen.has(m.name + "|" + m.soldAt)) continue;
    out.push({ id: m.tx ?? `mkt:${m.listing}`, ts: m.soldAt, kind: m.side, usd: (m.side === "sold" ? m.sellerGets : m.price) / 100, text: m.name, item: m.item, ...(m.tx ? { tx: m.tx } : {}) });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

function matchNoTx(noTx: readonly MarketSide[], used: Set<string>, net: number, ts: number): MarketSide | null {
  for (const m of noTx) {
    if (used.has(m.listing) || ts > m.soldAt + 60_000 || ts < m.soldAt - SALE_WINDOW_MS) continue;
    // buyer pays price + a network fee of a few cents; seller gets exactly price - 7%
    if (m.side === "bought" && net < 0 && -net >= m.price / 100 - 0.01 && -net <= m.price / 100 + 0.5) return m;
    if (m.side === "sold" && net > 0 && Math.abs(net - m.sellerGets / 100) < 0.011) return m;
  }
  return null;
}
