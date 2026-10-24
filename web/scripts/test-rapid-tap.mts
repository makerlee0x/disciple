// Rapid-tap (SITE part of GAME's lee-approved spec): reservation registry, release on fill / error / timeout,
// in-flight-aware quotes, session-cap reservation (cap race refused before sending) and the 429 / spend-limit mapping.
//   pnpm test:rapid-tap   (pure: no RPC, nothing broadcast)
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeErrorResult, parseAbi } from "viem";

const warned: unknown[][] = [];
const realWarn = console.warn;
console.warn = (...a: unknown[]) => { warned.push(a); };
test.after(() => { console.warn = realWarn; });

const R = await import("../lib/trade/reservations");
const { Reservations, PendingSpend, spendable } = R;
const { marginalQuote } = await import("../lib/trade/hotCache");
const { sessionHasHeadroom } = await import("../lib/aa/oneTap");
const { tradeSigner } = await import("../lib/aa/loginSetup");
const { rateLimitOf, retryAfterMs, rateLimitFromError, SLOW_DOWN_MSG, SPEND_LIMIT_MSG, JARGON } = await import("../lib/aa/relayOp");
const { AAError } = await import("../lib/aa/core");
const { friendlyError, tradeErrorCode, ProtocolError } = await import("../lib/protocol-viem");
const { playerError } = await import("../lib/playerError");

const USDG = "0x00000000000000000000000000000000000000aa";
const COIN = "0x00000000000000000000000000000000000000bb";
const B = (n: number | string) => BigInt(n);

/* ---------- registry ---------- */
test("registry: reserve / release are idempotent per id, events fire once per change", () => {
  const reg = new Reservations(() => 0, 60_000, false);
  const ev: string[] = [];
  const off = reg.subscribe((e) => ev.push(`${e.type}:${e.id}:${e.reason ?? ""}`));
  reg.reserve("p1", { side: "boost", coin: COIN, usd: 5 });
  reg.reserve("p1", { side: "boost", coin: COIN, usd: 5 });   // GAME re-reserves the same press: no double count
  assert.equal(reg.count(), 1); assert.equal(reg.reservedCash(), 5);
  assert.equal(reg.release("p1", "filled"), true);
  assert.equal(reg.release("p1", "error"), false, "second release is a no-op (trade-layer backstop)");
  assert.equal(reg.reservedCash(), 0);
  off(); reg.reserve("p2", { side: "dump", coin: COIN, tokenAmt: B(7) });
  assert.deepEqual(ev, ["reserve:p1:", "reserve:p1:", "release:p1:filled"], "unsubscribe stops events");
});

test("registry: GAME's $ reservation and the trade layer's raw spend merge under one press id (no double count)", () => {
  const reg = new Reservations(() => 0, 60_000, false);
  reg.reserve("press-1", { side: "boost", coin: COIN, usd: 10 });
  assert.equal(reg.reservedRaw(USDG, { usdg: USDG }), B(10_000_000), "GAME-only $ counts as USDG raw");
  reg.reserve("press-1", { side: "boost", coin: COIN, spend: { asset: USDG, raw: B(10_000_000), route: "r" } } as never);
  assert.equal(reg.count(), 1);
  assert.equal(reg.reservedRaw(USDG, { usdg: USDG }), B(10_000_000), "merged, not added");
  assert.equal(reg.get("press-1")!.usd, 10, "GAME's fields kept");
  assert.equal(reg.reservedRaw(USDG, { usdg: USDG, exceptId: "press-1" }), B(0), "a trade doesn't block itself");
});

test("registry: dumps hold coin, pendingNet reports both sides (display only)", () => {
  const reg = new Reservations(() => 0, 60_000, false);
  reg.reserve("b", { side: "boost", coin: COIN, usd: 3 });
  reg.reserve("s1", { side: "dump", coin: COIN.toLowerCase(), tokenAmt: B(100) });
  reg.reserve("s2", { side: "dump", coin: COIN, spend: { asset: COIN, raw: B(50) } } as never);
  assert.equal(reg.reservedTokens(COIN), B(150));
  assert.deepEqual(reg.pendingNet(COIN), { buys: 1, buyUsd: 3, sells: 2, sellTokens: B(150) });
  assert.equal(reg.count("dump"), 2); assert.equal(reg.count("boost"), 1);
});

test("registry: gas cap from FLOW's source is held per BOOST, counted as USDG and in reservedCash", () => {
  const reg = new Reservations(() => 0, 60_000, false);
  reg.setGasReserveSource(() => B(250_000));   // $0.25 cap per op
  reg.reserve("b", { side: "boost", coin: COIN, usd: 1 });
  reg.reserve("s", { side: "dump", coin: COIN, tokenAmt: B(1) });
  assert.equal(reg.get("b")!.gasReserve, B(250_000)); assert.equal(reg.get("s")!.gasReserve, undefined);
  assert.equal(reg.reservedCash(), 1.25);
  assert.equal(reg.reservedRaw(USDG, { usdg: USDG }), B(1_250_000));
});

test("reservation race: two overlapping taps can't both spend the same cash (no fake fill, balance untouched)", () => {
  const reg = new Reservations(() => 0, 60_000, false);
  const have = B(10_000_000);   // real balance $10, never edited by the trade layer
  const tap = (id: string, raw: bigint) => {
    reg.reserve(id, { side: "boost", coin: COIN, spend: { asset: USDG, raw, route: "r" } } as never);
    return spendable(have, reg.reservedRaw(USDG, { exceptId: id, usdg: USDG })) >= raw;
  };
  assert.equal(tap("a", B(7_000_000)), true);
  assert.equal(tap("b", B(7_000_000)), false, "second $7 tap refused while the first is pending");
  reg.release("b", "error");
  assert.equal(tap("c", B(3_000_000)), true, "what's left still goes");
  reg.release("a", "error");   // first trade failed: its cash is back
  assert.equal(tap("d", B(7_000_000)), true);
  assert.equal(have, B(10_000_000));
});

test("release on timeout: TTL timer and the lazy sweep both release as 'timeout'", async () => {
  let t = 0; const reg = new Reservations(() => t, 1_000, false);
  const why: string[] = []; reg.subscribe((e) => e.type === "release" && why.push(e.reason!));
  reg.reserve("x", { side: "boost", coin: COIN, usd: 2 });
  t = 1_001; assert.equal(reg.reservedCash(), 0); assert.deepEqual(why, ["timeout"]);
  const timed = new Reservations(Date.now, 5, true);
  const w2: string[] = []; timed.subscribe((e) => e.type === "release" && w2.push(e.reason!));
  timed.reserve("y", { side: "dump", coin: COIN, tokenAmt: B(1) });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(w2, ["timeout"]); assert.equal(timed.count(), 0);
});

test("release on error: a throwing listener never breaks reserve / release", () => {
  const reg = new Reservations(() => 0, 60_000, false);
  reg.subscribe(() => { throw new Error("boom"); });
  reg.reserve("z", { side: "boost", coin: COIN, usd: 1 });
  assert.equal(reg.release("z", "error"), true); assert.equal(reg.count(), 0);
  assert.ok(warned.some((a) => String(a[0]).startsWith("[disciple]")));
});

test("module API: exported wrappers share the app registry", () => {
  const id = R.autoReservationId(); assert.match(id, /^trade:\d+$/);
  R.reserve(id, { side: "dump", coin: COIN, tokenAmt: B(9) });
  assert.equal(R.reservedTokens(COIN), B(9)); assert.equal(R.inflightCount("dump"), 1);
  assert.equal(R.release(id, "cancel"), true); assert.equal(R.inflightCount(), 0); assert.equal(R.reservedCash(), 0);
});

/* ---------- quotes with pending trades ---------- */
test("quote with pending trades: marginal over same-side pending, slippage base not loosened", async () => {
  const curve = (a: bigint) => a * B(1000) / (B(1000) + a / B(1000));   // concave: later units get less
  const quote = async (a: bigint) => curve(a);
  const solo = await marginalQuote("k-solo", B(1_000_000), quote);
  const behind = await marginalQuote("k-behind", B(1_000_000), quote, B(2_000_000));
  assert.equal(solo, curve(B(1_000_000)));
  assert.equal(behind, curve(B(3_000_000)) - curve(B(2_000_000)));
  assert.ok(behind < solo, "a tap behind a pending buy quotes (and sets minOut from) the worse marginal price");
  assert.equal(await marginalQuote("k-zero", B(5), quote, B(0)), curve(B(5)), "no pending ⇒ the plain quote");
});

/* ---------- session cap reservation ---------- */
test("cap: in-flight session spend counts against the cap", () => {
  const s = { caps: { [USDG.toLowerCase()]: "10000000" }, spent: { [USDG.toLowerCase()]: "2000000" } };
  const d = { [USDG]: B(5_000_000) };
  assert.equal(sessionHasHeadroom(s as never, d), true);
  assert.equal(sessionHasHeadroom(s as never, d, { [USDG.toLowerCase()]: B(4_000_000) }), false);
  assert.equal(sessionHasHeadroom(s as never, d, { [USDG.toLowerCase()]: B(3_000_000) }), true, "exactly at cap is fine");
});

test("cap: PendingSpend holds / refunds synchronously", () => {
  const p = new PendingSpend();
  const a = p.hold({ [USDG]: B(4) }); const b = p.hold({ [USDG]: B(3), [COIN]: B(0) });
  assert.deepEqual(p.total(), { [USDG.toLowerCase()]: B(7) }); assert.equal(p.size, 2);
  p.drop(a); assert.deepEqual(p.total(), { [USDG.toLowerCase()]: B(3) });
  p.drop(b); p.drop(b); assert.equal(p.size, 0); assert.deepEqual(p.total(), {});
});

test("cap refusal: a cap race in session-only mode is refused before sending; otherwise decision (4) is unchanged", () => {
  const base = { trade: true, eligible: true, live: true, headroom: false, strictMode: true, deployed: true } as const;
  assert.deepEqual(tradeSigner({ ...base, capRace: true }), { as: "refuse", why: "spend limit (trades in flight)" });
  assert.deepEqual(tradeSigner({ ...base }), { as: "owner", why: "spend limit used up" }, "cap used by confirmed spend ⇒ owner (decision 4)");
  assert.deepEqual(tradeSigner({ ...base, capRace: true, strictMode: false }), { as: "owner", why: "spend limit used up" }, "one-tap off ⇒ owner");
  assert.deepEqual(tradeSigner({ ...base, capRace: true, deployed: undefined }), { as: "owner", why: "spend limit used up" }, "unknown status never blocks");
  assert.deepEqual(tradeSigner({ ...base, headroom: true, capRace: true }), { as: "session" });
});

/* ---------- 429 / limit mapping ---------- */
test("429 mapping: HTTP 429, JSON-RPC -32005 and rate-limit text; Retry-After seconds / date / message", () => {
  const now = Date.parse("2026-10-24T15:00:00Z");
  assert.deepEqual(rateLimitOf({ status: 429, retryAfter: "3", now }), { retryAfterMs: 3000 });
  assert.deepEqual(rateLimitOf({ code: -32005, message: "rate limited, retry in 2s", now }), { retryAfterMs: 2000 });
  assert.equal(rateLimitOf({ status: 429, now })?.retryAfterMs, undefined); assert.ok(rateLimitOf({ status: 429, now }));
  assert.equal(rateLimitOf({ status: 500, code: -32000, message: "execution reverted", now }), null);
  assert.equal(retryAfterMs("Sat, 24 Oct 2026 15:00:05 GMT", undefined, now), 5000);
  assert.equal(retryAfterMs("garbage", undefined, now), undefined);
});

test("429 mapping: rateLimitFromError walks the cause chain (viem HttpRequestError shape)", () => {
  const inner = Object.assign(new Error("HTTP request failed. Status: 429"), { status: 429, headers: new Headers({ "retry-after": "4" }) });
  const outer = new Error("bundler failed", { cause: inner });
  assert.deepEqual(rateLimitFromError(outer), { retryAfterMs: 4000 });
  assert.equal(rateLimitFromError(new Error("nonce too low")), null);
});

test("typed codes: AA RateLimited → rate_limited + retryAfterMs; spend limit → spend_limit; plain copy", () => {
  const rl = friendlyError(new AAError("RateLimited", SLOW_DOWN_MSG, { retryAfterMs: 1500 }));
  assert.ok(rl instanceof ProtocolError);
  assert.equal(rl.code, "rate_limited"); assert.equal(rl.retryAfterMs, 1500); assert.equal(rl.message, SLOW_DOWN_MSG);
  assert.equal(tradeErrorCode(rl), "rate_limited");
  const sl = friendlyError(new AAError("Policy", SPEND_LIMIT_MSG, { spendLimit: true, tradeError: "spend_limit" }));
  assert.equal(sl.code, "spend_limit"); assert.equal(sl.message, SPEND_LIMIT_MSG); assert.equal(tradeErrorCode(sl), "spend_limit");
  const rd = encodeErrorResult({ abi: parseAbi(["error SpendCapExceeded(address quote, uint256 spent, uint256 cap)"]), errorName: "SpendCapExceeded", args: [USDG as `0x${string}`, B(1), B(1)] });
  const dec = friendlyError(new AAError("Estimate", "simulation failed: execution reverted", { revertData: rd }));
  assert.equal(dec.code, "spend_limit"); assert.equal(dec.message, SPEND_LIMIT_MSG);
  assert.equal(tradeErrorCode(new Error("x")), undefined);
  for (const e of [rl, sl, dec]) { const m = playerError(e); assert.ok(!JARGON.test(m), m); assert.ok(m === SLOW_DOWN_MSG || m === SPEND_LIMIT_MSG); }
});
