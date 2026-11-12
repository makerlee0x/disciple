/** Rewards popup totals: on-chain amounts + the off-chain manual payout ledger, with no trade counted twice. */
import { describe, expect, it } from "vitest";
import { offchainReferral, summarize, type LedgerRow } from "../lib/claims/rewards";
import { REF, referrerLedger, type LedgerStore, type ReferralRow } from "../lib/server/referralLedger";

const NOW = 1_800_000_000;
const DAY = 86_400;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const row = (n: number, usd: number, ts = NOW - DAY, li = 0): LedgerRow => ({ id: `${tx(n)}:${li}`, tx: tx(n), ts, usd });
const total = (onClaimable: number, onClaimed: number, offUsd: number, history: { ts: number; usd: number }[] = []) =>
  summarize(
    onClaimable ? [{ kind: "referral", usd: onClaimable }] : [],
    onClaimed ? [{ kind: "referral", usd: onClaimed }] : [],
    history.map((h) => ({ kind: "referral" as const, ...h })),
    NOW,
    offUsd ? [{ kind: "referral", usd: offUsd }] : [],
  );

describe("offchainReferral + summarize", () => {
  it("none: no on-chain and no ledger rows is $0", () => {
    const off = offchainReferral([], new Map(), 0);
    expect(off).toEqual({ usd: 0, entries: [], overlapUsd: 0, mode: "none" });
    const s = total(0, 0, off.usd);
    expect(s.totalUsd).toBe(0);
    expect(s.byKind.referral.earnedUsd).toBe(0);
    expect(s.claimableUsd).toBe(0);
  });

  it("on-chain only: unchanged from before (claimed + claimable)", () => {
    const off = offchainReferral(null, new Map([[tx(1), 1]]), 3);
    expect(off.usd).toBe(0);
    const s = total(1, 2, off.usd);
    expect(s.totalUsd).toBe(3);
    expect(s.claimableUsd).toBe(1);
    expect(s.byKind.referral.earnedUsd).toBe(3);
  });

  it("off-chain only: ledger rows count toward total, earned, history and this week, never claimable", () => {
    const rows = [row(1, 0.25, NOW - DAY), row(2, 0.5, NOW - 10 * DAY)];
    const off = offchainReferral(rows, new Map(), 0);
    expect(off.mode).toBe("tx");
    expect(off.usd).toBeCloseTo(0.75);
    expect(off.entries).toHaveLength(2);
    const s = total(0, 0, off.usd, off.entries);
    expect(s.totalUsd).toBeCloseTo(0.75);
    expect(s.byKind.referral.earnedUsd).toBeCloseTo(0.75);
    expect(s.claimableUsd).toBe(0);
    expect(s.weekUsd).toBeCloseTo(0.25); // only the row inside the last 7 days
  });

  it("both, different trades: amounts add up", () => {
    const off = offchainReferral([row(5, 0.4)], new Map([[tx(1), 1]]), 1.2);
    expect(off.usd).toBeCloseTo(0.4);
    expect(off.overlapUsd).toBe(0);
    expect(total(0.2, 1, off.usd).totalUsd).toBeCloseTo(1.6);
  });

  it("no double count: a ledger row whose tx also credited me on-chain is left out", () => {
    const off = offchainReferral([row(1, 0.3), row(2, 0.7)], new Map([[tx(1).toUpperCase().replace("0X", "0x"), 1]]), 0.3);
    expect(off.usd).toBeCloseTo(0.7);
    expect(off.overlapUsd).toBeCloseTo(0.3);
    expect(off.entries.map((e) => e.usd)).toEqual([0.7]);
    // on-chain 0.3 (claimed) + ledger 0.7 = 1.0, not 1.3
    expect(total(0, 0.3, off.usd).totalUsd).toBeCloseTo(1.0);
  });

  it("no double count, batched tx: only as many ledger rows as on-chain credits are dropped", () => {
    const rows = [row(9, 0.1, NOW - 100, 0), row(9, 0.2, NOW - 100, 1), row(9, 0.3, NOW - 100, 2)];
    const off = offchainReferral(rows, new Map([[tx(9), 2]]), 0.3);
    expect(off.overlapUsd).toBeCloseTo(0.3); // first two (by id) dropped
    expect(off.usd).toBeCloseTo(0.3);
    // stable: same answer on every load
    expect(offchainReferral([...rows].reverse(), new Map([[tx(9), 2]]), 0.3)).toEqual(off);
  });

  it("on-chain history unreadable: counts the larger of on-chain and ledger, never both", () => {
    const rows = [row(1, 1), row(2, 1)];
    const a = offchainReferral(rows, null, 1.5);
    expect(a.mode).toBe("max");
    expect(a.usd).toBeCloseTo(0.5);
    expect(a.entries).toEqual([]);
    expect(total(0, 1.5, a.usd).totalUsd).toBeCloseTo(2);
    const b = offchainReferral(rows, null, 3);
    expect(b.usd).toBe(0);
    expect(total(0, 3, b.usd).totalUsd).toBe(3);
    const c = offchainReferral(rows, null, 0);
    expect(c.usd).toBe(2);
    expect(c.entries).toHaveLength(2);
  });

  it("ignores bad rows and a failed ledger read (null)", () => {
    expect(offchainReferral(null, new Map(), 0).mode).toBe("none");
    const off = offchainReferral([row(1, NaN), row(2, -1), row(3, 0), row(4, 0.5)], new Map(), 0);
    expect(off.usd).toBe(0.5);
  });
});

function store(rows: ReferralRow[]): LedgerStore {
  const members = rows.map((r) => JSON.stringify(r));
  return {
    async get() { return null; }, async set() {}, async setNX() { return true; }, async zadd() {}, async zrem() { return 0; },
    async zrange(k: string) { return k === REF.rows() ? [...members, "not json"] : []; },
  };
}

describe("referrerLedger (GET /api/profile/referral-ledger)", () => {
  const ME = "0x00000000000000000000000000000000000000B1";
  const OTHER = "0x00000000000000000000000000000000000000b2";
  const FRIEND = "0x00000000000000000000000000000000000000aa";
  const r = (id: string, referrer: string, amountUsdg: number, ts = 1_762_797_600_000): ReferralRow =>
    ({ id, ts, date: "2026-11-10", referrer: referrer.toLowerCase(), friend: FRIEND, amountUsdg });

  it("returns only this referrer's rows, in seconds, with the tx and no friend wallet", async () => {
    const l = await referrerLedger(ME, { store: store([r(`${tx(1)}:3`, ME, 0.01), r(`${tx(2)}:0`, OTHER, 5), r(`${tx(3)}:1`, ME, 0.02)]) });
    expect(l.referrer).toBe(ME.toLowerCase());
    expect(l.totalUsd).toBeCloseTo(0.03);
    expect(l.rows).toEqual([
      { id: `${tx(1)}:3`, tx: tx(1), ts: 1_762_797_600, usd: 0.01 },
      { id: `${tx(3)}:1`, tx: tx(3), ts: 1_762_797_600, usd: 0.02 },
    ]);
    expect(JSON.stringify(l)).not.toContain(FRIEND.slice(2));
  });

  it("empty ledger is $0", async () => {
    const l = await referrerLedger(ME, { store: store([]) });
    expect(l).toEqual({ referrer: ME.toLowerCase(), totalUsd: 0, rows: [] });
  });
});
