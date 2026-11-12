/**
 * Account referral bind (flow/account-referral-bind): first-touch in the browser, saved to the account at sign-in
 * (Rewardful / Impact pattern), and the manual payout sheet reading that bind instead of ReferralRegistry.referrerOf.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Fill } from "../lib/trades";

// In-memory stand-in for Upstash (get/set/setNX + zsets), shared by the bind and the ledger.
const kvData = new Map<string, string>();
const zData = new Map<string, Map<string, number>>();
const mem = {
  kind: "local" as const,
  async get(k: string) { return kvData.get(k) ?? null; },
  async set(k: string, v: string) { kvData.set(k, v); },
  async setNX(k: string, v: string) { if (kvData.has(k)) return false; kvData.set(k, v); return true; },
  async zadd(k: string, items: { score: number; member: string }[]) {
    const m = zData.get(k) ?? new Map<string, number>(); zData.set(k, m);
    for (const i of items) if (!m.has(i.member)) m.set(i.member, i.score);
  },
  async zrange(k: string, limit = 1000) {
    return Array.from((zData.get(k) ?? new Map<string, number>()).entries()).sort((a, b) => a[1] - b[1]).slice(0, limit).map(([m]) => m);
  },
  async zrem(k: string, ...members: string[]) { const m = zData.get(k); let n = 0; for (const x of members) if (m?.delete(x)) n++; return n; },
};
vi.mock("@/lib/server/kv", () => ({ kv: () => mem }));
vi.mock("@/lib/server/usernames", () => ({ usernameOf: vi.fn(async (a: string) => (a === REF_1 ? "alice" : null)), walletOf: vi.fn(async () => null) }));
// The on-chain registry must not be read for the payout sheet any more.
const readContract = vi.fn(async () => { throw new Error("referrerOf must not be called"); });
vi.mock("@/lib/server/chat/identity", () => ({ serverPc: () => ({ readContract }) }));

import { BIND, accountReferrerOf, bindAccountReferrer, handleBind } from "../lib/server/referralBind";
import { REF, markReferralDirty, payoutCsvForDate, recordReferralSlices } from "../lib/server/referralLedger";
import { BIND_DONE, tryBind } from "../lib/referralBindClient";
import { GET as payoutRoute } from "../app/api/cron/referral-payout/route";

const DID = "did:privy:abcdefgh1234";
const DID_2 = "did:privy:zzzzzzzz9999";
const ME = "0x00000000000000000000000000000000000000aa";
const MY_SMART = "0x00000000000000000000000000000000000000ab";
const REF_1 = "0x00000000000000000000000000000000000000b1";
const REF_2 = "0x00000000000000000000000000000000000000b2";
const USDG = "0x00000000000000000000000000000000000000d1";
const NOW = Date.UTC(2026, 10, 10, 18, 0, 0);
const DAY = 86_400_000;
const touch = (a: string | null, u: string | null = null, t = NOW - DAY) => ({ u, a, t });

beforeEach(() => { kvData.clear(); zData.clear(); readContract.mockClear(); });

describe("bindAccountReferrer", () => {
  it("saves the first-touch referrer to the account and each of its wallets (set-if-absent)", async () => {
    const r = await bindAccountReferrer({ did: DID, wallets: [ME, MY_SMART], touch: touch(REF_1) }, mem, NOW);
    expect(r).toEqual({ ok: true, referrer: REF_1, bound: true });
    expect(JSON.parse(kvData.get(BIND.account(DID))!)).toEqual({ r: REF_1, t: NOW - DAY, at: NOW });
    expect(await accountReferrerOf(ME, mem)).toBe(REF_1);
    expect(await accountReferrerOf(MY_SMART, mem)).toBe(REF_1);
  });

  it("first write wins: a later link never overwrites the saved referrer", async () => {
    await bindAccountReferrer({ did: DID, wallets: [ME], touch: touch(REF_1) }, mem, NOW);
    const r = await bindAccountReferrer({ did: DID, wallets: [ME], touch: touch(REF_2) }, mem, NOW + 1);
    expect(r).toEqual({ ok: true, referrer: REF_1, bound: false });
    expect(await accountReferrerOf(ME, mem)).toBe(REF_1);
  });

  it("cookie cleared / other browser: no touch or a new touch leaves the saved referrer in place", async () => {
    await bindAccountReferrer({ did: DID, wallets: [ME], touch: touch(REF_1) }, mem, NOW);
    expect(await bindAccountReferrer({ did: DID, wallets: [ME], touch: null }, mem, NOW + DAY)).toEqual({ ok: true, referrer: REF_1, bound: false });
    // a wallet linked later on the same account inherits the account's first referrer, not the new browser's touch
    await bindAccountReferrer({ did: DID, wallets: [ME, MY_SMART], touch: touch(REF_2, null, NOW + DAY) }, mem, NOW + 2 * DAY);
    expect(await accountReferrerOf(ME, mem)).toBe(REF_1);
    expect(await accountReferrerOf(MY_SMART, mem)).toBe(REF_1);
  });

  it("a wallet already bound keeps its referrer even if another account later claims it", async () => {
    await bindAccountReferrer({ did: DID, wallets: [ME], touch: touch(REF_1) }, mem, NOW);
    await bindAccountReferrer({ did: DID_2, wallets: [ME], touch: touch(REF_2) }, mem, NOW + 1);
    expect(await accountReferrerOf(ME, mem)).toBe(REF_1);
  });

  it("rejects self-referral (referrer is one of the signed-in account's wallets)", async () => {
    expect(await bindAccountReferrer({ did: DID, wallets: [ME, MY_SMART], touch: touch(ME) }, mem, NOW)).toEqual({ ok: false, reason: "self" });
    expect(await bindAccountReferrer({ did: DID, wallets: [ME, MY_SMART], touch: touch(MY_SMART.toUpperCase().replace("0X", "0x")) }, mem, NOW)).toEqual({ ok: false, reason: "self" });
    expect(kvData.size).toBe(0);
    // a refused self-referral does not block a real referrer afterwards
    expect((await bindAccountReferrer({ did: DID, wallets: [ME], touch: touch(REF_1) }, mem, NOW)).ok).toBe(true);
  });

  it("rejects a touch with no wallet (username-only / empty cookie) and expired touches", async () => {
    expect(await bindAccountReferrer({ did: DID, wallets: [ME], touch: touch(null, "alice") }, mem, NOW)).toEqual({ ok: false, reason: "no_wallet" });
    expect(await bindAccountReferrer({ did: DID, wallets: [ME], touch: { u: null, a: null, t: NOW } }, mem, NOW)).toEqual({ ok: false, reason: "no_wallet" });
    expect(await bindAccountReferrer({ did: DID, wallets: [ME], touch: "garbage" }, mem, NOW)).toEqual({ ok: false, reason: "no_wallet" });
    expect(await bindAccountReferrer({ did: DID, wallets: [ME], touch: touch(REF_1, null, NOW - 31 * DAY) }, mem, NOW)).toEqual({ ok: false, reason: "expired" });
    expect(kvData.size).toBe(0);
  });
});

describe("handleBind (POST /api/referral/bind)", () => {
  const user = { id: DID, emails: ["x@example.com"], wallets: [ME] };
  const deps = {
    store: mem,
    authenticate: async (t: string | null) => (t === "good" ? { ok: true as const, user } : { ok: false as const, status: 401 as const, reason: "Sign in first." }),
    accountsOf: async () => [ME, MY_SMART],
    now: () => NOW,
  };
  it("needs a Privy session", async () => {
    expect((await handleBind(deps, null, { wallet: ME, ref: touch(REF_1) }))[0]).toBe(401);
    expect(kvData.size).toBe(0);
  });
  it("the posted wallet must belong to the signed-in account", async () => {
    const [s, b] = await handleBind(deps, "good", { wallet: REF_2, ref: touch(REF_1) });
    expect(s).toBe(403);
    expect(b.error).toBe("not_your_wallet");
  });
  it("binds once, is idempotent, and stores no email", async () => {
    expect(await handleBind(deps, "good", { wallet: ME, ref: touch(REF_1) })).toEqual([200, { ok: true, bound: true }]);
    expect(await handleBind(deps, "good", { wallet: MY_SMART, ref: touch(REF_2) })).toEqual([200, { ok: true, bound: false }]);
    expect(await accountReferrerOf(MY_SMART, mem)).toBe(REF_1);
    expect(Array.from(kvData.values()).join(" ")).not.toContain("example.com");
  });
  it("self-referral answers 200 with ok:false (non-blocking)", async () => {
    expect(await handleBind(deps, "good", { wallet: ME, ref: touch(MY_SMART) })).toEqual([200, { ok: false, error: "self" }]);
  });
});

describe("tryBind (client, after sign-in)", () => {
  const ls = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };
  it("posts the first touch once per wallet + referrer", async () => {
    const storage = ls();
    const post = vi.fn(async () => ({ ok: true, status: 200 }));
    const d = { ref: () => touch(REF_1), token: async () => "tok", post, storage };
    expect(await tryBind(ME, d)).toBe("sent");
    expect(await tryBind(ME, d)).toBe("skip");
    expect(post).toHaveBeenCalledTimes(1);
    expect(JSON.parse((post.mock.calls[0] as unknown as [string])[0])).toEqual({ wallet: ME, ref: touch(REF_1) });
    expect(storage.m.has(BIND_DONE(ME, REF_1))).toBe(true);
  });
  it("skips with no touch, no wallet in the touch, self-referral, or no session yet; retries after a 5xx/401", async () => {
    const post = vi.fn(async () => ({ ok: false, status: 503 }));
    expect(await tryBind(ME, { ref: () => null, token: async () => "tok", post, storage: ls() })).toBe("skip");
    expect(await tryBind(ME, { ref: () => touch(null, "alice"), token: async () => "tok", post, storage: ls() })).toBe("skip");
    expect(await tryBind(ME, { ref: () => touch(ME), token: async () => "tok", post, storage: ls() })).toBe("skip");
    expect(await tryBind(ME, { ref: () => touch(REF_1), token: async () => null, post, storage: ls() })).toBe("skip");
    expect(post).not.toHaveBeenCalled();
    const storage = ls();
    const d = { ref: () => touch(REF_1), token: async () => "tok", post, storage };
    await tryBind(ME, d); await tryBind(ME, d);
    expect(post).toHaveBeenCalledTimes(2); // not marked done on 503
  });
  it("never throws", async () => {
    const d = { ref: () => touch(REF_1), token: async () => "tok", post: async () => { throw new Error("offline"); }, storage: ls() };
    expect(await tryBind(ME, d)).toBe("skip");
  });
});

function fill(p: Partial<Fill> = {}): Fill {
  return {
    id: "0x01:0", tx: "0x" + "1".padStart(64, "0"), logIndex: 0, block: 1, ts: NOW,
    coin: "0x00000000000000000000000000000000000000c1", trader: ME, side: "buy", venue: "curve",
    tokens: 100, usd: 100, priceUsd: 1, mcapUsd: 1e6, usdBasis: "quote", ...p,
  } as Fill;
}

describe("payout sheet uses the account bind (not ReferralRegistry.referrerOf)", () => {
  it("records a row for a trader with a saved referrer, none without, and never reads referrerOf", async () => {
    await bindAccountReferrer({ did: DID, wallets: [ME], touch: touch(REF_1) }, mem, NOW);
    const OTHER = "0x00000000000000000000000000000000000000ee";
    const r = await recordReferralSlices([fill(), fill({ id: "0x02:0", trader: OTHER })], undefined, { usdg: USDG, usdgDecimals: 6 });
    expect(r).toMatchObject({ recorded: 1, noReferrer: 1, failed: 0 });
    expect(readContract).not.toHaveBeenCalled();
    const rows = (await mem.zrange(REF.rows(), 10)).map((m) => JSON.parse(m));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ referrer: REF_1, friend: ME });
    const csv = await payoutCsvForDate("2026-11-10");
    expect(csv.summary.trim().split("\n")[1]).toBe(`2026-11-10,${REF_1},alice,1,0.01000000`);
  });

  it("GET /api/cron/referral-payout drains dirty fills through the bind and returns the CSV", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    await bindAccountReferrer({ did: DID, wallets: [ME], touch: touch(REF_1) }, mem, NOW);
    await markReferralDirty([fill({ id: "0x03:0" })]);
    const res = await payoutRoute(new Request("https://x.test/api/cron/referral-payout?date=2026-11-10", { headers: { authorization: "Bearer s3cret" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Referral-Drained-Recorded")).toBe("1");
    expect(res.headers.get("X-Referral-Referrers")).toBe("1");
    expect(await res.text()).toContain(`2026-11-10,${REF_1},alice,1,0.01000000`);
    expect(readContract).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
