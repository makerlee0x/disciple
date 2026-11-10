import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  type Hex,
} from "viem";
import {
  decodePoolInfo,
  decodeSwap,
  depthLadder,
  discipleHookAbi,
  discipleKey,
  maxSizeWithinImpact,
  maxIn,
  minOut,
  poolId,
  poolsForPair,
  ROBINHOOD,
  tryQuoteExactIn,
  turnover,
  watchSet,
} from "../src/index.ts";

const { hook, tokens, strategyUsdg } = ROBINHOOD;

test("live v0.2 pool id from its key (fee 0, tickSpacing 1, hook)", () => {
  assert.equal(poolId(discipleKey(hook, tokens.USDG, tokens.STRATEGY, 1)), strategyUsdg.id);
});

test("source leg ids from the deploy script's keys", () => {
  const k1 = { currency0: tokens.STRATEGY, currency1: tokens.MSTR, fee: 0x800000, tickSpacing: 8, hooks: "0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544" as Hex };
  const k2 = { currency0: tokens.USDG, currency1: tokens.MSTR, fee: 2500, tickSpacing: 25, hooks: "0x0000000000000000000000000000000000000000" as Hex };
  assert.deepEqual([poolId(k1), poolId(k2)], strategyUsdg.sourceV4Ids);
});

const pack = (parts: [bigint, number][]): bigint => parts.reduce((w, [v, byte]) => w | (v << BigInt(8 * byte)), 0n);

test("decodePoolInfo: head and two-hop v4 source", () => {
  const head = pack([[1n, 0], [1n, 1], [1n, 2], [0n, 3], [10_000n, 4], [BigInt(tokens.STRATEGY), 7]]);
  const s0 = pack([[3n, 0], [1n, 1], [0n, 2], [BigInt(ROBINHOOD.poolManager), 6]]);
  const s2 = pack([[0n, 0], [0n, 1], [0n, 2], [3n, 3], [0n, 4], [BigInt(ROBINHOOD.poolManager), 5]]);
  const i = decodePoolInfo(head, s0, BigInt(strategyUsdg.sourceV4Ids[0]), s2, BigInt(strategyUsdg.sourceV4Ids[1]));
  assert.equal(i.exists && i.live && i.coinIs0 && !i.local, true);
  assert.equal(i.feePips, 10_000);
  assert.equal(i.coin.toLowerCase(), tokens.STRATEGY.toLowerCase());
  assert.equal(i.remoteEid, 0);
  assert.deepEqual(i.legs.map((l) => [l.kind, l.v4Id, l.baseIs0]), [
    ["v4", strategyUsdg.sourceV4Ids[0], true],
    ["v4", strategyUsdg.sourceV4Ids[1], false],
  ]);
  assert.deepEqual(watchSet(hook, i).v4PoolIds, strategyUsdg.sourceV4Ids);
});

test("slippage helpers round against the trader", () => {
  assert.equal(minOut(10_001n, 50), 9_950n);
  assert.equal(maxIn(10_001n, 50), 10_052n);
});

test("turnover", () => {
  const t = turnover(166, 200, 1.1);
  assert.ok(Math.abs(t.turnover - 0.83) < 1e-9);
  assert.ok(Math.abs(t.perDay - 0.83 / 1.1) < 1e-9);
});

test("decodeSwap reads HookSwap and ignores other events", () => {
  const topics = encodeEventTopics({ abi: discipleHookAbi, eventName: "HookSwap", args: { id: strategyUsdg.id, sender: hook } });
  const data = encodeAbiParameters(
    [{ type: "int128" }, { type: "int128" }, { type: "uint128" }, { type: "uint128" }],
    [-525_485n * 10n ** 15n, 1_000_000n, 0n, 10_000n],
  );
  const s = decodeSwap({ data, topics: topics as Hex[] });
  assert.equal(s?.amount1, 1_000_000n);
  assert.equal(s?.fee1, 10_000n);
  const other = encodeEventTopics({ abi: discipleHookAbi, eventName: "LocalMode", args: { id: strategyUsdg.id } });
  assert.equal(decodeSwap({ data: encodeAbiParameters([{ type: "bool" }], [true]), topics: other as Hex[] }), null);
});

/** A fake RPC: quoteView fills up to `cap` input (default `out`: 2 per 1 in), then reverts TradeTooLarge. */
function fakeClient(cap: bigint, pairs = 1n, out = (a: bigint) => a * 2n) {
  return createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params: unknown[] }) {
        if (method === "eth_blockNumber") return "0x10";
        if (method !== "eth_call") throw new Error(method);
        const call = (params as [{ data: Hex }])[0];
        const f = decodeFunctionData({ abi: discipleHookAbi, data: call.data });
        if (f.functionName === "poolsOf") return encodeFunctionResult({ abi: discipleHookAbi, functionName: "poolsOf", result: pairs });
        if (f.functionName !== "quoteView") throw new Error(f.functionName);
        const amt = -(f.args[2] as bigint);
        if (amt > cap) {
          throw { code: 3, message: "execution reverted", data: encodeErrorResult({ abi: discipleHookAbi, errorName: "TradeTooLarge" }) };
        }
        return encodeFunctionResult({ abi: discipleHookAbi, functionName: "quoteView", result: [amt, out(amt)] });
      },
    }, { retryCount: 0 }),
  });
}

test("tryQuoteExactIn returns null on a NO_FILL revert", async () => {
  const c = fakeClient(1_000n);
  assert.deepEqual(await tryQuoteExactIn(c, hook, strategyUsdg.id, false, 10n), { amountIn: 10n, amountOut: 20n });
  assert.equal(await tryQuoteExactIn(c, hook, strategyUsdg.id, false, 1_001n), null);
});

test("maxSizeWithinImpact: stops at the revert on a flat curve", async () => {
  const got = await maxSizeWithinImpact(fakeClient(123_456n), hook, strategyUsdg.id, false, 1n, 100);
  assert.ok(got <= 123_456n && got >= 123_333n, String(got));
});

test("maxSizeWithinImpact: 1% impact on a constant-product curve", async () => {
  // out = R * a / (R + a): 1% worse than the ref trade at a ~= (R + ref) / 0.99 - R ~= 1.0101e10
  // (ref is large enough that rounding its own output doesn't loosen the limit)
  const R = 10n ** 12n;
  const c = fakeClient(10n ** 30n, 1n, (a) => (R * a) / (R + a));
  const got = await maxSizeWithinImpact(c, hook, strategyUsdg.id, false, 10n ** 6n, 100);
  assert.ok(got >= 10_090_000_000n && got <= 10_101_100_000n, String(got));
});

test("depthLadder marks unfillable sizes", async () => {
  const l = await depthLadder(fakeClient(500n), hook, strategyUsdg.id, true, [100n, 1_000n]);
  assert.deepEqual(l.map((r) => r.quote?.amountOut ?? null), [200n, null]);
});

test("poolsForPair builds every key for the pair", async () => {
  const p = await poolsForPair(fakeClient(0n, 2n), hook, tokens.STRATEGY, tokens.USDG);
  assert.equal(p.length, 2);
  assert.equal(p[0].id, strategyUsdg.id);
  assert.equal(p[1].key.tickSpacing, 2);
});
