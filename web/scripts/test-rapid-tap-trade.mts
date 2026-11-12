// SITE rapid-tap trade layer (#144, ported onto #140 + main): the shared in-flight reservation registry, the pre-send
// "balance minus what other pending trades hold" rule, and in-flight session spend against the one-tap cap.
//   pnpm test:rapid-tap-trade   (pure: no RPC). GAME's TradeBridge checks stay in test:rapid-tap.
import { test } from "node:test";
import assert from "node:assert/strict";

const warned: unknown[][] = [];
const realWarn = console.warn;
console.warn = (...a: unknown[]) => { warned.push(a); };
test.after(() => { console.warn = realWarn; });

const R = await import("../lib/trade/reservations");
const { Reservations, PendingSpend, spendable } = R;
const Shim = await import("../lib/flight/reservationsShim");
const { sessionHasHeadroom } = await import("../lib/aa/oneTap");
const { tradeSigner } = await import("../lib/aa/loginSetup");
const { SPEND_LIMIT_MSG } = await import("../lib/aa/relayOp");

const USDG = "0x00000000000000000000000000000000000000aa";
const COIN = "0x00000000000000000000000000000000000000bb";
const B = (n: number | string) => BigInt(n);

test("shim: GAME's import path is the trade layer's registry (one instance, nothing counted twice)", () => {
  assert.equal(Shim.RESERVATIONS, R.RESERVATIONS);
  assert.equal(Shim.reserve, R.reserve);
});

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

test("registry: gas cap from FLOW's source is held per BOOST AND per DUMP, always counted as cash (USDG), never as tokens", () => {
  const reg = new Reservations(() => 0, 60_000, false, () => 6);   // 6-dec USDG
  reg.setGasReserveSource(() => B(250_000));   // $0.25 cap per op
  reg.reserve("b", { side: "boost", coin: COIN, usd: 1 });
  reg.reserve("s", { side: "dump", coin: COIN, tokenAmt: B(1) });
  assert.equal(reg.get("b")!.gasReserve, B(250_000)); assert.equal(reg.get("s")!.gasReserve, B(250_000), "a DUMP pays gas too");
  assert.equal(reg.reservedCash(), 1.5, "$1 boost + two $0.25 gas caps");
  assert.equal(reg.reservedRaw(USDG, { usdg: USDG }), B(1_500_000));
  assert.equal(reg.reservedTokens(COIN), B(1), "the dump's gas is not held from tokens");
  assert.equal(reg.reservedRaw(COIN, { usdg: USDG }), B(1), "coin holds: sell amount only");
  // merge keeps the cap; an explicit cap wins; a 0 / undefined source (gas not paid in USDG) holds nothing
  reg.reserve("s", { side: "dump", coin: COIN, spend: { asset: COIN, raw: B(1), route: "coin|x|sell" } } as never);
  assert.equal(reg.get("s")!.gasReserve, B(250_000)); assert.equal(reg.reservedCash(), 1.5, "re-reserve: no double count");
  reg.reserve("t", { side: "dump", coin: COIN, tokenAmt: B(2), gasReserve: B(100_000) }); assert.equal(reg.get("t")!.gasReserve, B(100_000));
  const off = new Reservations(() => 0, 60_000, false, () => 6); off.setGasReserveSource(() => B(0));
  off.reserve("d", { side: "dump", coin: COIN, tokenAmt: B(1) }); assert.equal(off.get("d")!.gasReserve, undefined); assert.equal(off.reservedCash(), 0);
});

test("dump cash-check: a DUMP's gas counts against cash for the next trade (and against the dump's own cash check), not tokens", () => {
  const reg = new Reservations(() => 0, 60_000, false, () => 6);
  reg.setGasReserveSource(() => B(250_000));
  const cash = B(1_200_000);   // $1.20 USDG
  reg.reserve("d1", { side: "dump", coin: COIN, spend: { asset: COIN, raw: B(5), route: "coin|x|sell" } } as never);
  // a $1 BOOST after it: its own cap $0.25 + the dump's $0.25 held ⇒ $1.50 > $1.20 ⇒ refused before sending
  reg.reserve("b1", { side: "boost", coin: COIN, spend: { asset: USDG, raw: B(1_000_000), route: "usdgroute|x|buy" } } as never);
  const need = B(1_000_000) + reg.get("b1")!.gasReserve!;
  assert.equal(spendable(cash, reg.reservedRaw(USDG, { exceptId: "b1", usdg: USDG })) >= need, false, "dump gas held from cash");
  // a second DUMP's own gas check (dumpGasCheck: cash − others ≥ its cap) sees d1's gas + b1's spend + gas
  reg.reserve("d2", { side: "dump", coin: COIN, spend: { asset: COIN, raw: B(1), route: "coin|x|sell" } } as never);
  const othersCash = reg.reservedRaw(USDG, { exceptId: "d2", usdg: USDG });
  assert.equal(othersCash, B(250_000) + B(1_000_000) + B(250_000));
  assert.equal(spendable(cash, othersCash) >= reg.get("d2")!.gasReserve!, false, "no cash left for d2's gas ⇒ refused (held by trades in flight)");
  // tokens: d2's check only counts d1's sell amount (no gas)
  assert.equal(reg.reservedRaw(COIN, { exceptId: "d2", usdg: USDG }), B(5));
  reg.release("b1", "error");
  assert.equal(spendable(cash, reg.reservedRaw(USDG, { exceptId: "d2", usdg: USDG })) >= reg.get("d2")!.gasReserve!, true, "after b1 releases: $1.20 − $0.25 ≥ $0.25");
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

test("cap refusal copy: plain words, no ids", () => {
  assert.equal(SPEND_LIMIT_MSG, "Spend limit reached");
});
