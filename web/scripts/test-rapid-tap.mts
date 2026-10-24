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
  const reg = new Reservations(() => 0, 60_000, false, () => 6);   // 6-dec USDG (18 vs 6: see the decimals tests)
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
  const reg = new Reservations(() => 0, 60_000, false, () => 6);   // 6-dec USDG
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

/* ---------- AUDIT (#141 review): receipt / relay timeout ⇒ pending_unknown, not failed ---------- */
const PO = await import("../lib/trade/pendingOps");
const { unknownOpOf, PENDING_UNKNOWN_MSG, PENDING_MSG } = await import("../lib/aa/relayOp");
const { createViemProtocol } = await import("../lib/protocol-viem");
const U = await import("../lib/usdg");
const { deployment } = await import("../lib/chains");
const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
const OTHER = ("0x" + "cd".repeat(32)) as `0x${string}`;
const TX = ("0x" + "ef".repeat(32)) as `0x${string}`;
const NONCE = (B(12345) << B(64));
/** Fake clock + sleep: each sleep advances the clock, so a 2-min watch runs instantly. */
function fakeTime() { let t = 0; const sleeps: number[] = []; return { clock: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps, set: (v: number) => { t = v; } }; }
function events(reg: InstanceType<typeof Reservations>) {
  const ev: { type: string; reason?: string; outcome?: string; amountOut?: bigint; txHash?: string }[] = [];
  reg.subscribe((e) => ev.push({ type: e.type, reason: e.reason, outcome: e.outcome, amountOut: e.amountOut, txHash: e.txHash }));
  return ev;
}

test("pending_unknown: a Timeout AAError carries the op's ids + nonce; typed code + plain copy", () => {
  const op = unknownOpOf(new AAError("Timeout", PENDING_MSG, { userOpHash: HASH, txHash: TX, nonce: NONCE, sender: USDG }));
  assert.deepEqual(op, { userOpHash: HASH, txHash: TX, nonce: NONCE, sender: USDG });
  assert.equal(unknownOpOf(new AAError("Bundler", "x", { userOpHash: HASH })), null, "only timeouts are unknown");
  assert.equal(unknownOpOf(new ProtocolError("Timeout", PENDING_MSG)), null, "a mapped ProtocolError is not an AA send error");
  const pe = new ProtocolError("pending_unknown", PENDING_UNKNOWN_MSG, { op: { reservationId: "p", userOpHash: HASH, nonce: NONCE } });
  assert.equal(tradeErrorCode(pe), "pending_unknown"); assert.equal(pe.op?.userOpHash, HASH);
  assert.equal(PENDING_UNKNOWN_MSG, "Still confirming your last trade…");
  assert.ok(!JARGON.test(playerError(pe)), playerError(pe)); assert.equal(playerError(pe), PENDING_UNKNOWN_MSG);
});

test("pending_unknown: timeout then the op fills later ⇒ booked from the receipt logs, released 'filled', no failure event", async () => {
  const reg = new Reservations(() => 0, 60_000, false); const ev = events(reg); const ft = fakeTime();
  reg.reserve("press", { side: "boost", coin: COIN, spend: { asset: USDG, raw: B(5_000_000), route: "r" } } as never);
  const logs = [{ address: COIN as `0x${string}`, data: "0x" as `0x${string}`, topics: [] }];
  let calls = 0, booked: unknown = null, settled: boolean | undefined;
  const deps = { clock: ft.clock, sleep: ft.sleep,
    byHash: async () => (++calls < 4 ? null : { userOpHash: HASH, txHash: TX, success: true, logs }),
    nonceUsed: async () => false };
  const w = PO.holdUnknown(reg, "press", { userOpHash: HASH, nonce: NONCE }, deps, { book: (l) => { booked = l.logs; return B(777); }, settle: (x) => { settled = x; } });
  assert.equal(reg.isUnknown("press"), true); assert.equal(reg.reservedRaw(USDG, { usdg: USDG }), B(5_000_000), "still held");
  assert.equal(reg.release("press", "error"), false, "GAME's / the layer's backstop can't free an unknown press");
  const out = await w;
  assert.equal(out.state, "filled"); assert.equal(booked, logs); assert.equal(settled, true);
  assert.deepEqual(ev.map((e) => e.type + ":" + (e.reason ?? e.outcome ?? "")), ["reserve:", "unknown:", "resolved:filled", "release:filled"]);
  assert.equal(ev[2].amountOut, B(777)); assert.equal(ev[2].txHash, TX);
  assert.ok(!ev.some((e) => e.reason === "error" || e.reason === "timeout" || e.outcome === "error"), "never a failure");
  assert.equal(reg.count(), 0);
  assert.ok(ft.sleeps.length === 3 && ft.sleeps[1] > ft.sleeps[0], "backoff between lookups");
});

test("pending_unknown: timeout then dropped (cap passed, nonce not advanced) ⇒ released 'error'", async () => {
  const reg = new Reservations(() => 0, 60_000, false); const ev = events(reg); const ft = fakeTime();
  reg.reserve("p2", { side: "dump", coin: COIN, tokenAmt: B(10) });
  let booked = false, settled: boolean | undefined;
  const out = await PO.holdUnknown(reg, "p2", { userOpHash: HASH, nonce: NONCE }, { clock: ft.clock, sleep: ft.sleep, byHash: async () => null, nonceUsed: async () => false },
    { book: () => { booked = true; return B(0); }, settle: (x) => { settled = x; } });
  assert.deepEqual(out, { state: "dropped", why: "cap passed, nonce not advanced" });
  assert.ok(ft.clock() >= PO.WATCH_CAP_MS && ft.clock() < PO.WATCH_CAP_MS + 1, "watched for the 2 min cap, not past it");
  assert.ok(Math.max(...ft.sleeps) <= 15_000, "backoff capped");
  assert.equal(booked, false); assert.equal(settled, false);
  assert.deepEqual(ev.slice(-2).map((e) => e.type + ":" + (e.reason ?? e.outcome)), ["resolved:error", "release:error"]);
  assert.equal(reg.count(), 0);
});

test("pending_unknown: nonce used by ANOTHER op ⇒ dropped at once; our op reverted ⇒ 'error'", async () => {
  const ft = fakeTime();
  const other = await PO.watchUnknownOp({ userOpHash: HASH, nonce: NONCE }, { clock: ft.clock, sleep: ft.sleep, byHash: async () => null, nonceUsed: async () => true,
    byNonce: async () => ({ userOpHash: OTHER, txHash: TX, success: true, logs: [] }) });
  assert.deepEqual(other, { state: "dropped", why: "nonce used by another op" }); assert.equal(ft.sleeps.length, 0);
  const reg = new Reservations(() => 0, 60_000, false); const ev = events(reg);
  reg.reserve("p3", { side: "boost", coin: COIN, usd: 1 });
  const rv = await PO.holdUnknown(reg, "p3", { userOpHash: HASH }, { clock: ft.clock, sleep: ft.sleep, byHash: async () => ({ userOpHash: HASH, txHash: TX, success: false, logs: [] }), nonceUsed: async () => undefined }, { book: () => B(1) });
  assert.equal(rv.state, "reverted"); assert.equal(ev.at(-1)?.reason, "error");
  // nonce advanced, event outside the log window ⇒ it executed: 'filled' (balances re-read), never a failure
  const reg2 = new Reservations(() => 0, 60_000, false); const ev2 = events(reg2); const ft2 = fakeTime(); let reread = false;
  reg2.reserve("p4", { side: "boost", coin: COIN, usd: 1 });
  const ld = await PO.holdUnknown(reg2, "p4", { nonce: NONCE }, { clock: ft2.clock, sleep: ft2.sleep, byHash: async () => null, nonceUsed: async () => true, byNonce: async () => null }, { book: () => B(0), landedUnbooked: () => { reread = true; } });
  assert.equal(ld.state, "landed"); assert.equal(reread, true); assert.equal(ev2.at(-1)?.reason, "filled");
});

test("pending_unknown: the hold is NOT expired at 60 s (TTL sweep and timer) while unknown; it ends only when resolved", async () => {
  let t = 0; const reg = new Reservations(() => t, 60_000, false); const ev = events(reg);
  reg.reserve("u", { side: "boost", coin: COIN, usd: 4 }); reg.reserve("k", { side: "boost", coin: COIN, usd: 1 });
  assert.equal(reg.markUnknown("u", { userOpHash: HASH, nonce: NONCE }), true);
  t = 61_000;
  assert.equal(reg.reservedCash(), 4, "known hold expired, unknown hold kept");
  assert.equal(reg.has("u"), true); assert.equal(reg.has("k"), false);
  t = 600_000; assert.equal(reg.count(), 1);
  assert.equal(reg.release("u", "timeout"), false);
  assert.equal(reg.resolveUnknown("u", "filled"), true); assert.equal(reg.count(), 0);
  assert.deepEqual(ev.filter((e) => e.type === "release").map((e) => e.reason), ["timeout", "filled"]);
  const timed = new Reservations(Date.now, 5, true);
  timed.reserve("y", { side: "dump", coin: COIN, tokenAmt: B(1) }); timed.markUnknown("y", { nonce: NONCE });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(timed.count(), 1, "the TTL timer doesn't release an unknown hold");
  timed.clear(); assert.equal(timed.count(), 0, "logout still clears");
});

test("pending_unknown: no resend while unknown — the same press is refused before any build / send; other presses use the normal math", async () => {
  const id = "press-unknown";
  R.reserve(id, { side: "boost", coin: COIN, usd: 2 });
  R.RESERVATIONS.markUnknown(id, { userOpHash: HASH, nonce: NONCE });
  const ev: string[] = []; const off = R.subscribe((e) => ev.push(e.type));
  const p = createViemProtocol();
  await assert.rejects(p.buy({ token: COIN as `0x${string}`, amountIn: B(1), minAmountOut: B(1), reservationId: id }),
    (e: unknown) => e instanceof ProtocolError && e.code === "pending_unknown" && e.op?.userOpHash === HASH && e.message === PENDING_UNKNOWN_MSG);
  assert.deepEqual(ev, [], "nothing reserved / released / re-sent for that press");
  assert.equal(R.isPendingUnknown(id), true); assert.equal(R.unknownCount(), 1);
  // another press: the unknown hold still counts against cash (normal reservation math), nothing else is blocked
  const have = B(3_000_000) * B(10) ** B(U.usdgDecimals() - 6);
  const usdg = deployment().usdg;
  R.RESERVATIONS.reserve("other", { side: "boost", coin: COIN, spend: { asset: usdg, raw: U.usdToUsdgRaw(1) } } as never);
  assert.equal(spendable(have, R.RESERVATIONS.reservedRaw(usdg, { exceptId: "other", usdg })) >= U.usdToUsdgRaw(1), true, "$3 − $2 held ≥ $1");
  R.RESERVATIONS.reserve("big", { side: "boost", coin: COIN, spend: { asset: usdg, raw: U.usdToUsdgRaw(2) } } as never);
  assert.equal(spendable(have, R.RESERVATIONS.reservedRaw(usdg, { exceptId: "big", usdg })) >= U.usdToUsdgRaw(2), false, "would need the held funds ⇒ refused");
  off(); R.RESERVATIONS.clear();
});

/* ---------- gas reserve units: USDG 18 vs 6 decimals ---------- */
test("decimals: reservations convert $ ⇄ raw USDG at 18 and at 6 decimals (gas reserve is raw base units)", () => {
  for (const dec of [18, 6]) {
    const reg = new Reservations(() => 0, 60_000, false, () => dec);
    const one = B(10) ** B(dec);
    reg.setGasReserveSource(() => one / B(4));   // $0.25 per op in raw base units
    reg.reserve("g", { side: "boost", coin: COIN, usd: 10 });
    assert.equal(reg.reservedRaw(USDG, { usdg: USDG }), B(10) * one + one / B(4), `dec ${dec}: $10 + gas cap in raw`);
    assert.equal(reg.reservedCash(), 10.25, `dec ${dec}: reservedCash in $`);
    reg.reserve("h", { side: "boost", coin: COIN, spend: { asset: USDG, raw: B(3) * one, route: "usdgroute|x|buy" } } as never);
    assert.equal(reg.reservedCash(), 13.5, `dec ${dec}: raw USDG spend → $`);
    assert.equal(reg.usdgDec(), dec);
  }
});

test("decimals: USDG decimals are read from the chain ONCE (cached) and used by usdgDecimals() / conversions", async () => {
  const d = deployment();
  if (/^0x0{40}$/i.test(d.usdg)) return;   // chain without USDG: config only
  U.resetUsdgDecimals();
  const cfg = U.usdgDecimals(), chainDec = cfg === 18 ? 6 : 18;
  let reads = 0;
  const pc = { readContract: async () => { reads++; return chainDec; } } as never;
  assert.equal(await U.readUsdgDecimals(pc), chainDec);
  assert.equal(await U.readUsdgDecimals(pc), chainDec); assert.equal(reads, 1, "one read, then cached");
  assert.equal(U.usdgDecimals(), chainDec); assert.equal(U.usdToUsdgRaw(1), B(10) ** B(chainDec));
  assert.equal(U.usdgDecimals(d), cfg, "an explicit deployment still means its config");
  assert.equal(new Reservations(() => 0, 60_000, false).usdgDec(), chainDec, "the app registry follows the chain value");
  U.resetUsdgDecimals();
  const bad = { readContract: async () => { throw new Error("rpc down"); } } as never;
  await assert.rejects(U.readUsdgDecimals(bad)); assert.equal(U.usdgDecimals(), cfg, "a failed read falls back to config");
  assert.equal(await U.readUsdgDecimals(pc), chainDec, "and is retried"); U.resetUsdgDecimals();
});

/* ---------- press id to the relay (FLOW #145) ---------- */
test("pressId: asTrade accepts the press id (carried to aaSend; TODO FLOW #145: sendCalls options slot)", async () => {
  const { asTrade } = await import("../lib/aa/session");
  let ran = false; await asTrade(undefined, async () => { ran = true; }, { pressId: "press-9" }); assert.ok(ran);
});
