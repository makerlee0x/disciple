/** Unit tests for the v4 trade/wallet fixes (PR game/v4-trade-fixes): caps, headroom, USDG default, gating, revert unwrap, portfolio. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeErrorResult, parseAbi, type Hex } from "viem";
import { usdCapRaw, sessionHasHeadroom, addSpent, sessionPolicyFor, SESSION_NO_CAP, parseSpendLimitUsd, type CachedSession } from "../lib/aa/oneTap";
import { payUsdg } from "../lib/trade/usdgRouter";
import { price24hAgo, summarize } from "../lib/portfolio";
import { friendlyError } from "../lib/protocol-viem";
import { AAError } from "../lib/aa/core";
import { activeAddress, canTransact, execCalls, SignInRequired } from "../lib/wallet";

const E18 = BigInt(10) ** BigInt(18);
const STRAT = "0xd4d0eb01960aace441bfcb323bfaf7c3d8b555a3", USDG = "0x25030bff74764ad72b912276a603717db1c00644";

test("#1 usdCapRaw: $25k of STRATEGY @ $0.00253 ≈ 9.88M tokens; $25k USDG = 25k×1e18", () => {
  const strat = usdCapRaw(25_000, BigInt(2_530_000_000_000_000) /* 0.00253 WAD */);
  assert.ok(strat / E18 > BigInt(9_880_000) && strat / E18 < BigInt(9_882_000), String(strat / E18));
  assert.equal(usdCapRaw(25_000, E18), BigInt(25_000) * E18);
  assert.equal(usdCapRaw(0, E18), BigInt(0));
  assert.equal(usdCapRaw(25_000, BigInt(10) ** BigInt(30)), BigInt(25_000) * BigInt(1e6), "6-dec USDG (px 1e30): $25k = 25k×1e6 raw");
  assert.equal(usdCapRaw(1e40, BigInt(1)), (BigInt(1) << BigInt(128)) - BigInt(1), "clamped to uint128");
});
test("no session cap by default: uint128 max (never 0, which blocks spending); opt-in $ limit parses", () => {
  assert.equal(SESSION_NO_CAP, (BigInt(1) << BigInt(128)) - BigInt(1));
  const s = { caps: { [STRAT]: SESSION_NO_CAP.toString(), [USDG]: SESSION_NO_CAP.toString() }, spent: { [USDG]: (BigInt(10_000_000) * E18).toString() } };
  assert.equal(sessionHasHeadroom(s, { [USDG]: BigInt(1_000_000) * E18, [STRAT]: BigInt(10) ** BigInt(30) }), true, "$1M+ buys stay one-tap");
  for (const v of ["", "0", "-5", "abc", null, undefined]) assert.equal(parseSpendLimitUsd(v), null);
  assert.equal(parseSpendLimitUsd("$1,000"), 1000);
  assert.equal(parseSpendLimitUsd(250), 250);
});
test("#1 old 1e24 cap = only ~$2.5k of STRATEGY (the 'Spend limit reached' root cause)", () => {
  const usd = Number(BigInt(10) ** BigInt(24) / E18) * 0.00253;
  assert.ok(usd > 2000 && usd < 3000);
});
test("#1 sessionHasHeadroom: session key only while under cap; unknown caps ⇒ owner-sign", () => {
  const s = { caps: { [STRAT]: (BigInt(1000) * E18).toString() }, spent: {} } as Pick<CachedSession, "caps" | "spent">;
  assert.equal(sessionHasHeadroom(s, { [STRAT]: BigInt(999) * E18 }), true);
  assert.equal(sessionHasHeadroom(s, { [STRAT]: BigInt(1001) * E18 }), false);
  assert.equal(sessionHasHeadroom(s, { [USDG]: E18 }), false, "uncapped token");
  assert.equal(sessionHasHeadroom({}, { [STRAT]: E18 }), false);
  assert.equal(sessionHasHeadroom(null, {}), true, "no spend");
  const full = addSpent({ ...s, account: "0x0", entityId: 1, key: "0x", validUntil: 0, maxSlippageBps: 0 } as CachedSession, { [STRAT]: BigInt(600) * E18 });
  assert.equal(sessionHasHeadroom(full, { [STRAT]: BigInt(500) * E18 }), false);
  assert.equal(sessionHasHeadroom(full, { [STRAT]: BigInt(400) * E18 }), true);
});
test("v4 wiring: session policy defaults to the v4 deployment on 46630", () => {
  assert.equal(sessionPolicyFor(46630, ""), "0x3d3667e8880c6b633b424d645b8004788b1d6e27");
  assert.equal(sessionPolicyFor(1, ""), "");
  assert.equal(sessionPolicyFor(46630, "0x0000000000000000000000000000000000000001"), "0x0000000000000000000000000000000000000001");
});
test("#2 payUsdg: on by default on RH testnet even when NEXT_PUBLIC_PAY_USDG is unset; '0' opts out", () => {
  assert.equal(payUsdg(undefined, 46630), true);
  assert.equal(payUsdg("", 46630), true);
  assert.equal(payUsdg("0", 46630), false);
  assert.equal(payUsdg(undefined, 1), false);
  assert.equal(payUsdg("1", 1), true);
});
test("#3 wallet: not signed in ⇒ no transacting through an injected wallet (SignInRequired)", async () => {
  (globalThis as { window?: unknown }).window ??= { ethereum: { request: async () => ["0x7b0B5a326Aa4d95968e88654aF9b87624383A549"] } };
  assert.equal(canTransact(), false);
  await assert.rejects(activeAddress(), (e: unknown) => e instanceof SignInRequired);
  await assert.rejects(execCalls([{ to: STRAT, data: "0x" as Hex }] as never), (e: unknown) => e instanceof SignInRequired);
});
test("#6 friendlyError unwraps PreExecHookReverted → policy error", () => {
  const inner = encodeErrorResult({ abi: parseAbi(["error QuoteFailed(address target)"]), errorName: "QuoteFailed", args: [STRAT] });
  const outer = encodeErrorResult({ abi: parseAbi(["error PreExecHookReverted(bytes24 moduleFunction, bytes revertReason)"]), errorName: "PreExecHookReverted", args: [`0x${"11".repeat(24)}`, inner] });
  assert.equal(outer.slice(0, 10), "0x74a1a72c");
  const e = friendlyError(new AAError("Estimate", "sim", { revertData: outer }));
  assert.equal(e.code, "QuoteFailed", e.message);
  assert.equal(e.message, "Couldn't get a price right now. Try again.");
});
test("portfolio: 24h price = last fill at/before now−24h, else launch price; totals", () => {
  const now = 1_000 * 86_400_000;
  const fills = [{ ts: now - 30 * 3_600_000, priceUsd: 1e-6 }, { ts: now - 25 * 3_600_000, priceUsd: 2e-6 }, { ts: now - 3_600_000, priceUsd: 5e-6 }];
  assert.equal(price24hAgo(fills, now), 2e-6);
  assert.equal(price24hAgo([{ ts: now - 1000, priceUsd: 9e-6 }], now), 7000 / 7e9);
  const p = summarize(274.46, [{ coin: STRAT as never, tokens: 1e6, priceNow: 5e-6, price24h: 2e-6 }, { coin: USDG as never, tokens: 0, priceNow: 1, price24h: 1 }]);
  assert.equal(p.holdings.length, 1);
  assert.ok(Math.abs(p.totalUsd - 279.46) < 1e-9 && Math.abs(p.change24hUsd - 3) < 1e-9);
});
