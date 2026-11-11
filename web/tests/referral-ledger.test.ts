/** Off-chain referral ledger: fee-slice rows + America/Chicago daily CSV (flow/referral-ledger). */
import { afterEach, describe, expect, it } from "vitest";
import type { Fill } from "../lib/trades";
import type { LedgerStore, ReferralRow, TradeFeeRoutedArgs } from "../lib/server/referralLedger";
import {
  SUMMARY_HEADER, DETAIL_HEADER, REF, buildPayoutCsv, chicagoDate, feeIndex, formatUsdg,
  markReferralDirty, previousChicagoDate, processReferralDirty, recordReferralSlices,
  referralSliceFromFill, referralSliceFromNotional,
} from "../lib/server/referralLedger";

function mem(): LedgerStore & { data: { kv: Map<string, string>; z: Map<string, Map<string, number>> } } {
  const kv = new Map<string, string>();
  const z = new Map<string, Map<string, number>>();
  const store: LedgerStore & { data: { kv: Map<string, string>; z: Map<string, Map<string, number>> } } = {
    data: { kv, z },
    async get(k) { return kv.get(k) ?? null; },
    async set(k, v) { kv.set(k, v); },
    async setNX(k, v) { if (kv.has(k)) return false; kv.set(k, v); return true; },
    async zadd(k, items) {
      const m = z.get(k) ?? new Map();
      z.set(k, m);
      for (const i of items) if (!m.has(i.member)) m.set(i.member, i.score);
    },
    async zrange(k, limit = 1000) {
      return Array.from((z.get(k) ?? new Map()).entries()).sort((a, b) => a[1] - b[1]).slice(0, limit).map(([m]) => m);
    },
    async zrem(k, ...members) {
      const m = z.get(k);
      if (!m) return 0;
      let n = 0;
      for (const x of members) if (m.delete(x)) n++;
      return n;
    },
  };
  return store;
}

const FRIEND_A = "0x00000000000000000000000000000000000000aa";
const FRIEND_B = "0x00000000000000000000000000000000000000bb";
const REF_1 = "0x00000000000000000000000000000000000000b1";
const REF_2 = "0x00000000000000000000000000000000000000b2";
const COIN = "0x00000000000000000000000000000000000000c1";
const USDG = "0x00000000000000000000000000000000000000d1";

let seq = 0;
afterEach(() => { seq = 0; });

function fill(p: Partial<Fill> = {}): Fill {
  seq++;
  const side = p.side ?? "buy";
  const usd = p.usd ?? 100;
  return {
    id: p.id ?? `0x${seq.toString(16).padStart(8, "0")}:0`,
    tx: p.tx ?? `0x${seq.toString(16).padStart(64, "0")}`,
    logIndex: p.logIndex ?? 0,
    block: p.block ?? seq,
    ts: p.ts ?? Date.UTC(2026, 10, 10, 18, 0, 0), // 2026-11-10 12:00 CST
    coin: (p.coin ?? COIN).toLowerCase(),
    trader: (p.trader ?? FRIEND_A).toLowerCase(),
    side,
    venue: p.venue ?? "curve",
    tokens: p.tokens ?? usd,
    usd,
    priceUsd: p.priceUsd ?? 1,
    mcapUsd: p.mcapUsd ?? 1e6,
    usdBasis: p.usdBasis ?? "quote",
    ...p,
  };
}

const refs = (map: Record<string, string | null>) =>
  async (friend: string) => map[friend.toLowerCase()] ?? null;

async function rowsOf(s: LedgerStore): Promise<ReferralRow[]> {
  return (await s.zrange(REF.rows(), 10_000)).map((m) => JSON.parse(m) as ReferralRow);
}

describe("referral slice math (FeeMath 33/33/33/1)", () => {
  it("a $100 trade yields a $0.01 referral slice (1% of the 1% fee)", () => {
    expect(referralSliceFromNotional(100)).toBeCloseTo(0.01, 12);
    expect(referralSliceFromNotional(50)).toBeCloseTo(0.005, 12);
    expect(referralSliceFromNotional(0)).toBe(0);
  });
  it("curve buy/sell uses playerUsd (usdIn / usdOut when present, else usd)", () => {
    const buy = referralSliceFromFill(fill({ side: "buy", usd: 90, usdIn: 100 }));
    const sell = referralSliceFromFill(fill({ side: "sell", usd: 40, usdOut: 50 }));
    expect(buy?.amountUsdg).toBeCloseTo(0.01, 12);
    expect(sell?.amountUsdg).toBeCloseTo(0.005, 12);
    expect(buy?.note).toBeUndefined();
    expect(sell?.source).toBe("fill");
  });
  it("post-grad buy fee in the coin is valued at the fill price, with a note", () => {
    const s = referralSliceFromFill(fill({ venue: "hook", side: "buy", tokens: 99, priceUsd: 2, usd: 200 }));
    expect(s?.note).toBe("post-grad buy fee in coin, valued at fill price");
    // feeTokens = 99 * 100/9900 = 1; slice = 0.01 tokens × $2
    expect(s?.amountUsdg).toBeCloseTo(0.02, 12);
  });
  it("TradeFeeRouted quote-side USDG amount is preferred over fill math", () => {
    const ev: TradeFeeRoutedArgs = {
      token: COIN, feeToken: USDG, trader: FRIEND_A, feeIsQuote: true,
      creatorShare: 330_000n, lpShare: 330_000n, treasuryShare: 330_000n, referralShare: 10_000n,
    };
    const s = referralSliceFromFill(fill({ usd: 999 }), ev, { usdg: USDG, usdgDecimals: 6 });
    expect(s?.source).toBe("event");
    expect(s?.amountUsdg).toBeCloseTo(0.01, 12);
    expect(s?.note).toBeUndefined();
  });
  it("TradeFeeRouted coin-side fee (feeIsQuote=false) uses fill.priceUsd and the note", () => {
    const ev: TradeFeeRoutedArgs = {
      token: COIN, feeToken: COIN, trader: FRIEND_A, feeIsQuote: false,
      creatorShare: 33n * 10n ** 16n, lpShare: 33n * 10n ** 16n, treasuryShare: 33n * 10n ** 16n, referralShare: 10n ** 16n,
    };
    const s = referralSliceFromFill(fill({ venue: "hook", side: "buy", tokens: 99, priceUsd: 3, usd: 300 }), ev);
    expect(s?.note).toBe("post-grad buy fee in coin, valued at fill price");
    expect(s?.amountUsdg).toBeCloseTo(0.03, 8); // 0.01 tokens × $3
  });
});

describe("chicago day boundaries", () => {
  it("uses America/Chicago, not UTC midnight", () => {
    // 10 Nov 2026 is after DST ended (1 Nov), so CST = UTC-6.
    expect(chicagoDate(Date.UTC(2026, 10, 11, 5, 59, 59))).toBe("2026-11-10");
    expect(chicagoDate(Date.UTC(2026, 10, 11, 6, 0, 0))).toBe("2026-11-11");
    expect(chicagoDate(Date.UTC(2026, 10, 10, 18, 0, 0))).toBe("2026-11-10");
  });
  it("previousChicagoDate is the prior complete Chicago day", () => {
    expect(previousChicagoDate(Date.UTC(2026, 10, 11, 6, 0, 0))).toBe("2026-11-10");
    expect(previousChicagoDate(Date.UTC(2026, 10, 11, 5, 59, 59))).toBe("2026-11-09");
  });
});

describe("recordReferralSlices", () => {
  it("is idempotent: a fill is counted once even if the indexer re-runs", async () => {
    const s = mem();
    const f = fill({ usd: 100 });
    const d = { store: s, referrerOf: refs({ [FRIEND_A]: REF_1 }), usdg: USDG, usdgDecimals: 6 };
    const a = await recordReferralSlices([f], undefined, d);
    const b = await recordReferralSlices([f], undefined, d);
    expect(a.recorded).toBe(1);
    expect(b.recorded).toBe(0);
    expect(b.skipped).toBe(1);
    const rows = await rowsOf(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].amountUsdg).toBeCloseTo(0.01, 12);
    expect(rows[0].referrer).toBe(REF_1);
    expect(rows[0].friend).toBe(FRIEND_A);
  });

  it("records both buys and sells", async () => {
    const s = mem();
    const d = { store: s, referrerOf: refs({ [FRIEND_A]: REF_1 }), usdg: USDG, usdgDecimals: 6 };
    const r = await recordReferralSlices([
      fill({ side: "buy", usd: 100 }),
      fill({ side: "sell", usd: 50 }),
    ], undefined, d);
    expect(r.recorded).toBe(2);
    const rows = await rowsOf(s);
    const amts = rows.map((x) => x.amountUsdg).sort((a, b) => a - b);
    expect(amts[0]).toBeCloseTo(0.005, 12);
    expect(amts[1]).toBeCloseTo(0.01, 12);
  });

  it("handles gasless (usdIn/usdOut from UsdgTrade) and regular fills the same way", async () => {
    const s = mem();
    const d = { store: s, referrerOf: refs({ [FRIEND_A]: REF_1 }), usdg: USDG, usdgDecimals: 6 };
    const gaslessBuy = fill({ side: "buy", usd: 90, usdIn: 100 }); // router UsdgTrade wins
    const regularBuy = fill({ side: "buy", usd: 100 }); // direct curve, no UsdgTrade
    const r = await recordReferralSlices([gaslessBuy, regularBuy], undefined, d);
    expect(r.recorded).toBe(2);
    const rows = await rowsOf(s);
    expect(rows.every((x) => Math.abs(x.amountUsdg - 0.01) < 1e-12)).toBe(true);
  });

  it("writes no row when the friend has no locked referrer", async () => {
    const s = mem();
    const f = fill({ usd: 100 });
    const d = { store: s, referrerOf: async () => null, usdg: USDG, usdgDecimals: 6 };
    const a = await recordReferralSlices([f], undefined, d);
    expect(a.recorded).toBe(0);
    expect(a.noReferrer).toBe(1);
    expect(await rowsOf(s)).toHaveLength(0);
    const b = await recordReferralSlices([f], undefined, d);
    expect(b.skipped).toBe(1);
    expect(await rowsOf(s)).toHaveLength(0);
  });

  it("credits the friend's own locked referrer (not some other friend's)", async () => {
    const s = mem();
    const d = {
      store: s,
      referrerOf: refs({ [FRIEND_A]: REF_1, [FRIEND_B]: REF_2 }),
      usdg: USDG, usdgDecimals: 6,
    };
    await recordReferralSlices([
      fill({ trader: FRIEND_A, usd: 100, coin: COIN }),
      fill({ trader: FRIEND_A, usd: 100, coin: "0x00000000000000000000000000000000000000c2" }),
      fill({ trader: FRIEND_B, usd: 200 }),
    ], undefined, d);
    const rows = await rowsOf(s);
    expect(rows).toHaveLength(3);
    const a = rows.filter((r) => r.friend === FRIEND_A);
    const b = rows.filter((r) => r.friend === FRIEND_B);
    expect(a.every((r) => r.referrer === REF_1)).toBe(true);
    expect(b.every((r) => r.referrer === REF_2)).toBe(true);
    expect(a.reduce((n, r) => n + r.amountUsdg, 0)).toBeCloseTo(0.02, 12);
    expect(b[0].amountUsdg).toBeCloseTo(0.02, 12);
  });

  it("leaves the fill unseen when referrerOf fails, so a later pass can retry", async () => {
    const s = mem();
    const f = fill({ usd: 100 });
    let fail = true;
    const d = {
      store: s,
      referrerOf: async () => { if (fail) throw new Error("rpc"); return REF_1; },
      usdg: USDG, usdgDecimals: 6,
    };
    const a = await recordReferralSlices([f], undefined, d);
    expect(a.failed).toBe(1);
    expect(await rowsOf(s)).toHaveLength(0);
    fail = false;
    const b = await recordReferralSlices([f], undefined, d);
    expect(b.recorded).toBe(1);
    expect(await rowsOf(s)).toHaveLength(1);
  });

  it("matches TradeFeeRouted events to fills like the UsdgTrade indexer (n-th of tx/token/trader)", async () => {
    const s = mem();
    const tx = `0x${"ab".repeat(32)}`;
    const evs = feeIndex([
      { tx, args: { token: COIN, feeToken: USDG, trader: FRIEND_A, feeIsQuote: true, creatorShare: 330_000n, lpShare: 330_000n, treasuryShare: 330_000n, referralShare: 10_000n } },
      { tx, args: { token: COIN, feeToken: USDG, trader: FRIEND_A, feeIsQuote: true, creatorShare: 660_000n, lpShare: 660_000n, treasuryShare: 660_000n, referralShare: 20_000n } },
    ]);
    const d = { store: s, referrerOf: refs({ [FRIEND_A]: REF_1 }), usdg: USDG, usdgDecimals: 6 };
    await recordReferralSlices([
      fill({ tx, logIndex: 1, id: `${tx}:1`, usd: 1 }),
      fill({ tx, logIndex: 3, id: `${tx}:3`, usd: 1 }),
    ], evs, d);
    const rows = (await rowsOf(s)).sort((a, b) => a.id.localeCompare(b.id));
    expect(rows[0].amountUsdg).toBeCloseTo(0.01, 12);
    expect(rows[1].amountUsdg).toBeCloseTo(0.02, 12);
  });
});

describe("dirty queue + CSV", () => {
  it("processReferralDirty records once and is safe to re-run", async () => {
    const s = mem();
    const d = { store: s, referrerOf: refs({ [FRIEND_A]: REF_1 }), usdg: USDG, usdgDecimals: 6 };
    await markReferralDirty([fill({ usd: 100 })], d);
    const a = await processReferralDirty(d);
    const b = await processReferralDirty(d);
    expect(a.recorded).toBe(1);
    expect(b.recorded).toBe(0);
    expect(await s.zrange(REF.dirty(), 10)).toHaveLength(0);
  });

  it("splits rows across the America/Chicago day boundary into two payout days", async () => {
    const s = mem();
    const d = { store: s, referrerOf: refs({ [FRIEND_A]: REF_1 }), usdg: USDG, usdgDecimals: 6 };
    await recordReferralSlices([
      fill({ usd: 100, ts: Date.UTC(2026, 10, 11, 5, 59, 59) }), // 2026-11-10 23:59 CST
      fill({ usd: 200, ts: Date.UTC(2026, 10, 11, 6, 0, 0) }),    // 2026-11-11 00:00 CST
    ], undefined, d);
    const rows = await rowsOf(s);
    const a = buildPayoutCsv("2026-11-10", rows);
    const b = buildPayoutCsv("2026-11-11", rows);
    expect(a.rows).toBe(1);
    expect(b.rows).toBe(1);
    expect(a.summary).toContain("0.01000000");
    expect(b.summary).toContain("0.02000000");
    expect(a.summary).not.toContain("0.02000000");
  });

  it("CSV format: summary per referrer, detail per referrer and friend, username quoted when needed", async () => {
    const rows: ReferralRow[] = [
      { id: "t1:0", ts: 1, date: "2026-11-10", referrer: REF_1, friend: FRIEND_A, amountUsdg: 0.01 },
      { id: "t2:0", ts: 2, date: "2026-11-10", referrer: REF_1, friend: FRIEND_A, amountUsdg: 0.01 },
      { id: "t3:0", ts: 3, date: "2026-11-10", referrer: REF_1, friend: FRIEND_B, amountUsdg: 0.02, note: "post-grad buy fee in coin, valued at fill price" },
      { id: "t4:0", ts: 4, date: "2026-11-11", referrer: REF_1, friend: FRIEND_A, amountUsdg: 9 }, // other day, excluded
    ];
    const csv = buildPayoutCsv("2026-11-10", rows, { [REF_1]: "lee,maker", [FRIEND_A]: "alice", [FRIEND_B]: "bob" });
    expect(csv.summary.split("\n")[0]).toBe(SUMMARY_HEADER);
    expect(csv.detail.split("\n")[0]).toBe(DETAIL_HEADER);
    expect(csv.referrers).toBe(1);
    expect(csv.rows).toBe(3);
    const sum = csv.summary.trim().split("\n")[1];
    expect(sum).toBe(`2026-11-10,${REF_1},"lee,maker",2,0.04000000`);
    const detail = csv.detail.trim().split("\n").slice(1);
    expect(detail).toHaveLength(2);
    expect(detail[0]).toBe(`2026-11-10,${REF_1},"lee,maker",${FRIEND_A},alice,2,0.02000000,`);
    expect(detail[1]).toBe(`2026-11-10,${REF_1},"lee,maker",${FRIEND_B},bob,1,0.02000000,"post-grad buy fee in coin, valued at fill price"`);
    expect(formatUsdg(0.01)).toBe("0.01000000");
  });
});
