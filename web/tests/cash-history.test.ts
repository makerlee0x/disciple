import { describe, expect, it } from "vitest";
import { cashRows, throughForwarder, RELAY_SOLVER, type CashTags, type UsdgLeg } from "@/lib/cashHistory";

const W = "0x" + "a1".repeat(20), S = "0x" + "b2".repeat(20), RELAYER = "0x" + "c3".repeat(20), ROUTER = "0x" + "d4".repeat(20);
const TURBO = "0x" + "e5".repeat(20), EXT = "0x" + "f6".repeat(20), FEES = "0x" + "07".repeat(20), SOLVER = "0x" + "18".repeat(20);
const tx = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const leg = (n: number, from: string, to: string, usd: number, ts = n * 1000): UsdgLeg => ({ tx: tx(n), block: n, logIndex: 0, ts, from, to, usd });
const tags = (o: Partial<CashTags> = {}): CashTags => ({
  protocol: new Set([ROUTER.toLowerCase()]), fees: new Set([FEES.toLowerCase()]), rewards: new Set(), turboIn: new Set(), turboOut: [], market: [], ...o,
});

describe("flight log cash rows", () => {
  it("labels deposits, withdrawals and drops trade legs", () => {
    const rows = cashRows(W, [leg(1, EXT, W, 25), leg(2, W, ROUTER, 5), { ...leg(3, W, EXT, 10) }, { ...leg(3, W, RELAYER, 0.02), logIndex: 1 }], tags());
    expect(rows.map((r) => [r.kind, +r.usd.toFixed(2)])).toEqual([["withdraw", 10.02], ["deposit", 25]]);
    expect(rows[1].text).toBe("0xf6f6…f6f6");
  });

  it("labels a market buy and sale by the listing's tx, summing the buyer's legs", () => {
    const market = [
      { listing: "aa", side: "bought" as const, item: "skin-x", name: "Chrome Ace", price: 1000, sellerGets: 930, soldAt: 5000, tx: tx(5) },
      { listing: "bb", side: "sold" as const, item: "skin-y", name: "Ember", price: 2000, sellerGets: 1860, soldAt: 7000, tx: tx(7) },
    ];
    const rows = cashRows(W, [leg(5, W, S, 9.3), { ...leg(5, W, RELAYER, 0.72), logIndex: 1 }, leg(7, S, W, 18.6)], tags({ market }));
    expect(rows.map((r) => [r.kind, r.text, +r.usd.toFixed(2)])).toEqual([["sold", "Ember", 18.6], ["bought", "Chrome Ace", 10.02]]);
  });

  it("matches an admin-settled sale with no tx by amount and time, and shows unscanned sales from the market record", () => {
    const market = [
      { listing: "cc", side: "sold" as const, item: "i", name: "Nova", price: 1000, sellerGets: 930, soldAt: 10_000 },
      { listing: "dd", side: "bought" as const, item: "j", name: "Late", price: 500, sellerGets: 465, soldAt: 99_000 },
    ];
    const rows = cashRows(W, [leg(9, S, W, 9.3)], tags({ market }));
    expect(rows.map((r) => [r.kind, r.text])).toEqual([["bought", "Late"], ["sold", "Nova"]]);
    expect(rows.filter((r) => r.kind === "deposit")).toHaveLength(0);
  });

  it("labels Turbo cash in by its deposit address and Turbo cash back by time and amount", () => {
    const rows = cashRows(W, [leg(20, W, TURBO, 10, 20_000), leg(30, SOLVER, W, 7.95, 31_000), leg(40, SOLVER, W, 50, 40_000)],
      tags({ turboIn: new Set([TURBO.toLowerCase()]), turboOut: [{ at: 30_000, usd: 8 }] }));
    expect(rows.map((r) => r.kind)).toEqual(["deposit", "turbo-out", "turbo-in"]);
  });

  it("labels creator fee claims", () => {
    expect(cashRows(W, [leg(50, FEES, W, 3.1)], tags())[0].kind).toBe("fees");
  });
  it("a card top-up paid out by Relay's solver reads Card, not its address", () => {
    const rows = cashRows(W, [leg(9, RELAY_SOLVER, W, 16.48)], tags());
    expect(rows[0]).toMatchObject({ kind: "deposit", text: "Card" });
  });

  it("sees through the permit forwarder: a gasless Turbo add is TO TURBO with the fee built in (maker 2026-11-20)", () => {
    const FWD = "0x" + "29".repeat(20);
    const legs = [leg(9, W, FWD, 6)];
    const onward = new Map([[tx(9), [{ to: TURBO, usd: 5.9912, logIndex: 1 }, { to: RELAYER, usd: 0.0088, logIndex: 2 }]]]);
    const shown = throughForwarder(W, legs, FWD, onward);
    const rows = cashRows(W, shown, tags({ turboIn: new Set([TURBO.toLowerCase()]) }));
    expect(rows.map((r) => [r.kind, +r.usd.toFixed(2)])).toEqual([["turbo-in", 6]]);
    // a plain cash-out through it names the real destination; no onward legs known keeps the forwarder leg
    expect(cashRows(W, throughForwarder(W, legs, FWD, new Map([[tx(9), [{ to: EXT, usd: 5.99, logIndex: 1 }, { to: RELAYER, usd: 0.01, logIndex: 2 }]]])), tags())[0].text).toBe("0xf6f6…f6f6");
    expect(throughForwarder(W, legs, FWD, new Map())).toEqual(legs);
  });
});
