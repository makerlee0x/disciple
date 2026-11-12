/** Unit tests: parallel nonce keys, gas/fee/quote caches, relayer lock/retry, chain-ordered mcap, balance line.  pnpm test:trade-order */
import { scaledQuote } from "../lib/trade/hotCache";
import { routerBuyWithUsdgCalls, routerSellToUsdgCalls, BUY_WITH_USDG, SELL_TO_USDG, toCalls } from "../lib/trade/usdgRouter";
import { policyHasUsdg, tradeSelectors, sessionEligible, SESSION_POLICY_MODULE_ID, SESSION_POLICY_VERSION } from "../lib/aa/oneTap";
import { checkCalls, usdgBuyTotal } from "../lib/aa/policy";
import { decodeFunctionData, encodeFunctionData, parseAbi } from "viem";
import assert from "node:assert/strict";
import { NonceCursor, GasCache, FeeCache, callsKind } from "../lib/aa/fastPath";
import { TtlCache } from "../lib/trade/hotCache";
import { withRelayer, isNonceError } from "../lib/server/relayer";
import { mcapOrderer } from "../lib/events";
import { balanceLine } from "../lib/balanceLine";
let n = 0; const t = async (name: string, f: () => Promise<void> | void) => { await f(); n++; console.log("ok  ", name); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await t("NonceCursor: parallel nonce keys are unique, < 2^152, seq 0, MAv2 layout (entityId/global flag)", () => {
  const c = new NonceCursor(() => 0xabcdefn); const seen = new Set<bigint>();
  for (let i = 0; i < 5000; i++) { const n = c.next(7, false); assert.equal(n & ((1n << 64n) - 1n), 0n, "seq 0"); assert.ok(!seen.has(n)); seen.add(n);
    const full = n >> 64n; assert.equal(full & 0xffn, 0n, "non-global flag"); assert.equal((full >> 8n) & 0xffffffffn, 7n, "entityId"); assert.ok(full >> 40n < 1n << 152n); }
  const o = c.next(0, true) >> 64n; assert.equal(o & 0xffn, 1n, "owner = global validation"); assert.equal((o >> 8n) & 0xffffffffn, 0n);
  const a = new NonceCursor(), b = new NonceCursor(); assert.notEqual(a.next(0, true), b.next(0, true), "two tabs/devices don't collide");
});
await t("parallel nonces: 3 rapid ops all valid on a nonce-checking fake EntryPoint (no queue, no waiting)", async () => {
  const used = new Set<bigint>(); const ep = async (nonce: bigint) => { await sleep(5); if (used.has(nonce)) throw new Error("AA25 invalid account nonce"); used.add(nonce); return nonce; };
  const c = new NonceCursor(); const t0 = Date.now();
  const rs = await Promise.all([0, 1, 2].map(() => ep(c.next(1, false))));
  assert.equal(new Set(rs).size, 3); assert.ok(Date.now() - t0 < 40, "concurrent, not serialized");
});
await t("GasCache: per preset kind with headroom; dropped after a gas failure", () => {
  const g = new GasCache(); const kind = callsKind([{ to: "0xAa00000000000000000000000000000000000001", data: "0x095ea7b3ff" }, { to: "0xBb00000000000000000000000000000000000002", data: "0x12345678ff" }]);
  assert.equal(kind, "0xaa00000000000000000000000000000000000001:0x095ea7b3,0xbb00000000000000000000000000000000000002:0x12345678");
  g.set(kind, { callGasLimit: 100000n, verificationGasLimit: 200000n, preVerificationGas: 50000n });
  assert.deepEqual(g.get(kind), { callGasLimit: 150000n, verificationGasLimit: 240000n, preVerificationGas: 50000n }); g.drop(kind); assert.equal(g.get(kind), undefined);
});
await t("FeeCache: stale-while-revalidate, one in-flight fetch, never blocks once warm", async () => {
  let now = 0, calls = 0; const f = new FeeCache(3000, () => now); const fetch = async () => { calls++; await sleep(20); return { maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }; };
  assert.equal(f.peek(), undefined); const [a, b] = await Promise.all([f.get(fetch), f.get(fetch)]); assert.equal(calls, 1); assert.equal(a.maxFeePerGas, 20n); assert.equal(b, a);
  now = 5000; const t0 = Date.now(); const c = await f.get(fetch); assert.ok(Date.now() - t0 < 10, "stale value returned immediately"); assert.equal(c, a); await sleep(30); assert.equal(calls, 2);
});
await t("TtlCache (quotes/balances): hit within TTL, shared in-flight read, refetch after", async () => {
  let now = 0, reads = 0; const q = new TtlCache<number>(1500, () => now); const read = async () => { reads++; await sleep(5); return reads; };
  assert.equal(await Promise.all([q.get("k", read), q.get("k", read)]).then((r) => r[0]), 1); assert.equal(reads, 1);
  now = 1000; assert.equal(await q.get("k", read), 1); now = 2000; assert.equal(await q.get("k", read), 2);
});
await t("withRelayer: serial + retries nonce errors, not other errors", async () => {
  assert.ok(isNonceError(new Error("Nonce provided for the transaction is lower than the current nonce of the account.")));
  assert.ok(!isNonceError(new Error("execution reverted")));
  let tries = 0; assert.equal(await withRelayer(async () => { if (++tries < 2) throw new Error("nonce too low"); return "ok"; }), "ok"); assert.equal(tries, 2);
  let other = 0; await assert.rejects(withRelayer(async () => { other++; throw new Error("execution reverted"); })); assert.equal(other, 1);
  let active = 0, peak = 0; await Promise.all([1, 2, 3].map(() => withRelayer(async () => { active++; peak = Math.max(peak, active); await sleep(10); active--; }))); assert.equal(peak, 1);
});
await t("mcapOrderer: a late OLDER buy batch can't undo a newer DUMP; reconcile only moves forward", () => {
  const out: { type: string; mcapUsd?: number; side?: string }[] = [];
  const o = mcapOrderer((e) => out.push(e as never));
  // one tx per (block, logIndex): mcapOrderer drops a repeated tx:logIndex (its getLogs re-delivery dedupe)
  const tr = (block: number, logIndex: number, side: "buy" | "sell", mcapUsd: number) => ({ type: "Trade", side, mcapUsd, block: BigInt(block), logIndex, usd: 10, impactPct: 0, txHash: `0x${block.toString(16)}${logIndex}`, token: "0x", trader: "0x", amountIn: 0n, amountOut: 0n }) as never;
  o.trade(tr(100, 1, "buy", 33894));
  o.trade(tr(102, 3, "sell", 33018));      // DUMP lands first
  o.trade(tr(101, 0, "buy", 33749));       // older buy batch resolves late
  assert.equal(out.length, 3); assert.equal(out[2].side, "buy"); assert.equal(out[2].mcapUsd, 33018, "late buy carries the newest mcap");
  assert.equal(o.state(33900, 101n), false, "stale reconcile ignored");
  assert.equal(o.state(33018, 103n), false, "same mcap → no event");
  assert.equal(o.state(32500, 104n), true); assert.equal(out.at(-1)!.type, "State"); assert.equal(out.at(-1)!.mcapUsd, 32500);
  o.trade(tr(104, 2, "sell", 32400)); assert.equal(out.at(-1)!.mcapUsd, 32500, "trade inside an already-reconciled block keeps the newer read");
  o.trade(tr(105, 0, "sell", 32000)); assert.equal(out.at(-1)!.mcapUsd, 32000);
});
await t("balanceLine: held coin first, quote marked as what trades spend, ETH = gas", () => {
  const l = balanceLine([{ symbol: "ETH", amount: 0.0009, role: "gas" }, { symbol: "STRATEGY", amount: 999007, role: "spend" }, { symbol: "mUSDG", amount: 1000 }, { symbol: "SMK", amount: 25483509, role: "held" }]);
  assert.equal(l.text, "25.48M $SMK · 999,007 STRATEGY (pays trades) · $1,000.00 · 0.0009 ETH (fees)");
  assert.match(l.title, /Test dollars: not spent/);
  assert.equal(balanceLine([{ symbol: "STRATEGY", amount: 0, role: "spend" }, { symbol: "mUSDG", amount: 0 }]).text, "$0.00", "all-zero wallet reads $0.00, no '0 STRATEGY' / 'mUSDG 0'");
});
await t("scaledQuote: only scales DOWN (safe lower bound), respects age", () => {
  const last = { amountIn: 1000n, amountOut: 500n, at: 0 };
  assert.equal(scaledQuote(last, 400n, 1500, 100), 200n);
  assert.equal(scaledQuote(last, 1001n, 1500, 100), undefined, "bigger trade never scaled");
  assert.equal(scaledQuote(last, 400n, 1500, 2000), undefined, "stale");
});
await t("USDG router (#65 SDK mirror): exact approve + buyWithUsdg / sellToUsdg in one batch; minOut > 0", () => {
  const router = "0xCfb16275fCbcF124dDe54F3dbc36ddC684111564" as const, usdg = "0x25030Bff74764aD72b912276a603717DB1C00644" as const, token = "0xcac8A9654dE3aE01470fC9E93e58fb97d5B86bb3" as const;
  const b = routerBuyWithUsdgCalls({ router, usdg, token, usdgIn: 10n ** 19n, minTokensOut: 1n, deadline: 1n });
  assert.equal(b.length, 2); assert.equal(b[0].target, usdg); assert.equal(b[1].target, router);
  assert.equal(b[0].data.slice(0, 10), "0x095ea7b3"); assert.equal(b[1].data.slice(0, 10), BUY_WITH_USDG);
  const ap = decodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), data: b[0].data });
  assert.equal((ap.args[0] as string).toLowerCase(), router.toLowerCase()); assert.equal(ap.args[1], 10n ** 19n, "approve == usdgIn exactly");
  const sl = routerSellToUsdgCalls({ router, token, tokensIn: 5n, minUsdgOut: 1n, deadline: 1n });
  assert.equal(sl[0].target, token); assert.equal(sl[1].data.slice(0, 10), SELL_TO_USDG);
  assert.throws(() => routerBuyWithUsdgCalls({ router, usdg, token, usdgIn: 1n, minTokensOut: 0n, deadline: 1n }));
  assert.throws(() => routerSellToUsdgCalls({ router, token, tokensIn: 1n, minUsdgOut: 0n, deadline: 1n }));
  assert.equal(usdgBuyTotal(toCalls(b), router), 10n ** 19n);
  // no UniversalRouter / Permit2 anywhere
  for (const c of [...b, ...sl]) assert.ok(![ "0x8876789976decbfcbbbe364623c63652db8c0904", "0x000000000022d473030f116ddee9f6b43ac78ba3"].includes(c.target.toLowerCase()));
});
await t("session policy version gating (config): 1.1.1 ⇒ USDG calls owner-signed; 1.3.0 ⇒ session-signable", () => {
  assert.equal(policyHasUsdg("1.1.1"), false); assert.equal(policyHasUsdg("1.3.0"), true); assert.equal(policyHasUsdg("1.10.0"), true);
  assert.ok(!tradeSelectors("1.1.1").has(BUY_WITH_USDG)); assert.ok(tradeSelectors("1.3.0").has(BUY_WITH_USDG) && tradeSelectors("1.3.0").has(SELL_TO_USDG));
  // the configured version (v5 stack default 1.4.1, lib/aa/oneTap) must be one whose session key signs USDG trades
  assert.equal(SESSION_POLICY_MODULE_ID, `disciple.session-policy.${SESSION_POLICY_VERSION}`);
  assert.ok(policyHasUsdg(SESSION_POLICY_VERSION), `configured policy ${SESSION_POLICY_VERSION} is session-signable for USDG`);
});
await t("1.3.0 rules mirrored: USDG approve to a curve/tramp ⇒ owner signer; to router must be exact", async () => {
  const router = "0x00000000000000000000000000000000000000aa" as const, usdg = "0x00000000000000000000000000000000000000bb" as const, curve = "0x00000000000000000000000000000000000000cc" as const;
  const appr = (sp: string, amt: bigint) => ({ to: usdg, data: encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [sp as `0x${string}`, amt] }) });
  const buy = toCalls(routerBuyWithUsdgCalls({ router, usdg, token: curve, usdgIn: 7n, minTokensOut: 1n, deadline: 1n }))[1];
  // eligibility (uses the module's TRADE_SELECTORS; approve is always in it)
  assert.equal(sessionEligible([appr(curve, 7n)], { referral: false, usdg, router }), false, "USDG → curve is owner-only");
  assert.equal(sessionEligible([appr(router, 7n)], { referral: false, usdg, router }), true);
  const cfg = { launchpad: "0x00000000000000000000000000000000000000d1", router, trampWallManager: "0x00000000000000000000000000000000000000d2", mintable: [], defaultLimit: 10n ** 30n, usdg } as never;
  const st = { expiresAt: Date.now() + 1e6, spent: {} };
  await assert.rejects(checkCalls({} as never, cfg, st, [appr(router, 8n), buy], "0x00000000000000000000000000000000000000ee"), /must equal/);
  const d = await checkCalls({} as never, cfg, st, [appr(router, 7n), buy], "0x00000000000000000000000000000000000000ee");
  assert.equal(d[usdg], 7n, "USDG approve counts to the USDG cap");
});
console.log(`\n${n} passed`);
