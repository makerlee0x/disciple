// Unit tests for the relayer gas policy (W-1, lib/aa/gasPolicy) and the shared rate limiter (lib/server/limits).
//   pnpm test:relay-policy   (pure: no RPC, no live endpoint)
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOpGas, checkPaymaster, clientFees, GAS_CAPS, maxPrefund, MIN_PRE_VERIFICATION_GAS, relayerPrice, relayerTxFees, RELAYER_TIP, RelayPolicyError, totalGas } from "../lib/aa/gasPolicy";
import { hitLimit, memoryCounter, clientIp, type CounterStore } from "../lib/server/limits";
import { STATIC_GAS, FeeCache } from "../lib/aa/fastPath";

const hex = (n: bigint | number) => "0x" + BigInt(n).toString(16);
const BASE = BigInt(10_000_000); // 0.01 gwei (RH testnet base fee)
const op = (o: Record<string, bigint | number | string | undefined> = {}) => {
  const f = clientFees(BASE);
  const d: Record<string, string | undefined> = { callGasLimit: hex(STATIC_GAS.callGasLimit), verificationGasLimit: hex(STATIC_GAS.verificationGasLimit), preVerificationGas: hex(STATIC_GAS.preVerificationGas), maxFeePerGas: hex(f.maxFeePerGas), maxPriorityFeePerGas: hex(f.maxPriorityFeePerGas) };
  for (const [k, v] of Object.entries(o)) d[k] = v === undefined ? undefined : typeof v === "string" ? v : hex(v);
  return d;
};
const rejects = (o: Record<string, string | undefined>, code: "fee" | "gas", base = BASE) =>
  assert.throws(() => checkOpGas(o, base), (e: unknown) => e instanceof RelayPolicyError && e.code === code);

test("fee-0 op (the drain) is rejected", () => {
  rejects(op({ maxFeePerGas: 0, maxPriorityFeePerGas: 0 }), "fee");
  rejects(op({ maxFeePerGas: undefined, maxPriorityFeePerGas: undefined }), "fee");
});
test("maxFee just below 2x base + tip rejected, at the floor accepted; tip below RELAYER_TIP rejected", () => {
  rejects(op({ maxFeePerGas: relayerPrice(BASE) - BigInt(1) }), "fee");
  assert.ok(checkOpGas(op({ maxFeePerGas: relayerPrice(BASE), maxPriorityFeePerGas: RELAYER_TIP }), BASE) > BigInt(0));
  rejects(op({ maxPriorityFeePerGas: RELAYER_TIP - BigInt(1) }), "fee");
  assert.match((() => { try { checkOpGas(op({ maxFeePerGas: 0 }), BASE); } catch (e) { return (e as Error).message; } return ""; })(), /fee below relayer floor/);
});
test("huge callGasLimit / verification / PVG / total rejected; tiny PVG rejected", () => {
  rejects(op({ callGasLimit: GAS_CAPS.callGasLimit + BigInt(1) }), "gas");
  rejects(op({ callGasLimit: BigInt(10) ** BigInt(9) }), "gas");
  rejects(op({ verificationGasLimit: GAS_CAPS.verificationGasLimit + BigInt(1) }), "gas");
  rejects(op({ preVerificationGas: GAS_CAPS.preVerificationGas + BigInt(1) }), "gas");
  rejects(op({ callGasLimit: GAS_CAPS.callGasLimit, verificationGasLimit: GAS_CAPS.verificationGasLimit, preVerificationGas: BigInt(100_000) }), "gas");
  rejects(op({ preVerificationGas: MIN_PRE_VERIFICATION_GAS - BigInt(1) }), "gas");
  rejects(op({ callGasLimit: "0xzz" }), "gas");
});
test("paymaster limits count toward the cap (v0.7 packed)", () => {
  const p = op({ paymaster: "0x1111111111111111111111111111111111111111", paymasterVerificationGasLimit: GAS_CAPS.paymasterVerificationGasLimit + BigInt(1) });
  rejects(p, "gas");
  const q = op({ paymaster: "0x1111111111111111111111111111111111111111", paymasterVerificationGasLimit: BigInt(100_000), paymasterPostOpGasLimit: BigInt(50_000) });
  assert.equal(totalGas(q), STATIC_GAS.callGasLimit + STATIC_GAS.verificationGasLimit + STATIC_GAS.preVerificationGas + BigInt(150_000));
});
test("real one-tap ops pass: STATIC_GAS, first-op deploy (450k verif ×1.2), GasCache 1.5x of a 0.65M estimate", () => {
  assert.doesNotThrow(() => checkOpGas(op(), BASE));
  assert.doesNotThrow(() => checkOpGas(op({ verificationGasLimit: BigInt(540_000), callGasLimit: BigInt(1_000_000), preVerificationGas: BigInt(72_000) }), BASE));
  const est = (BigInt(650_000) * BigInt(13)) / BigInt(10) + BigInt(20_000);
  assert.doesNotThrow(() => checkOpGas(op({ callGasLimit: (est * BigInt(150)) / BigInt(100), verificationGasLimit: (BigInt(150_000) * BigInt(120)) / BigInt(100) }), BASE));
});
test("client fees clear the floor with headroom (base +40% still ok); one-tap FeeCache doubles them", async () => {
  const f = clientFees(BASE);
  assert.ok(f.maxFeePerGas >= relayerPrice(BASE) && f.maxPriorityFeePerGas >= RELAYER_TIP);
  assert.doesNotThrow(() => checkOpGas(op(), (BASE * BigInt(140)) / BigInt(100)));
  // mav2 fetchFees: clientFees(base, tip, 100) through FeeCache (×2 maxFee) → base may double before rejection
  const c = new FeeCache(3000, () => 0); const v = await c.get(async () => clientFees(BASE, BigInt(1_000_000), BigInt(100)));
  assert.doesNotThrow(() => checkOpGas(op({ maxFeePerGas: v.maxFeePerGas, maxPriorityFeePerGas: v.maxPriorityFeePerGas }), BASE * BigInt(2)));
  c.invalidate(); assert.equal(c.peek(), undefined);
  // an Alchemy tip above ours is kept
  assert.equal(clientFees(BASE, BigInt(5_000_000)).maxPriorityFeePerGas, BigInt(5_500_000));
});
test("relayer tx fees never exceed the op's ⇒ refund per gas >= cost per gas", () => {
  for (const base of [BigInt(0), BASE, BASE * BigInt(3)]) {
    const o = op({ maxFeePerGas: relayerPrice(base) + BigInt(7), maxPriorityFeePerGas: RELAYER_TIP * BigInt(3) });
    const tx = relayerTxFees(o, base);
    assert.ok(tx.maxFeePerGas <= BigInt(o.maxFeePerGas!) && tx.maxPriorityFeePerGas <= BigInt(o.maxPriorityFeePerGas!));
    const eff = (max: bigint, tip: bigint) => (max < base + tip ? max : base + tip);
    assert.ok(eff(BigInt(o.maxFeePerGas!), BigInt(o.maxPriorityFeePerGas!)) >= eff(tx.maxFeePerGas, tx.maxPriorityFeePerGas));
  }
});
test("maxPrefund is priced at >= the relayer floor (a fee-0 op never looks covered by a zero balance)", () => {
  const z = op({ maxFeePerGas: 0 });
  assert.equal(maxPrefund(z), BigInt(0));
  assert.equal(maxPrefund(z, relayerPrice(BASE)), totalGas(z) * relayerPrice(BASE));
  assert.ok(BigInt(0) < maxPrefund(z, relayerPrice(BASE)));
  const o = op(); assert.equal(maxPrefund(o, relayerPrice(BASE)), totalGas(o) * BigInt(o.maxFeePerGas!));
});
test("rate limiter: fixed window per key, retry-after, store errors fall back to memory (never unlimited)", async () => {
  const k = `t:${Math.random()}`;
  for (let i = 1; i <= 3; i++) assert.equal((await hitLimit(memoryCounter, k, 3, 60)).ok, true);
  const r = await hitLimit(memoryCounter, k, 3, 60); assert.equal(r.ok, false); assert.ok(r.retryAfterSec > 0 && r.retryAfterSec <= 60);
  assert.equal((await hitLimit(memoryCounter, k + "other", 3, 60)).ok, true);
  const broken: CounterStore = { incrEx: async () => { throw new Error("upstash down"); }, ttl: async () => -2 };
  const k2 = `t2:${Math.random()}`;
  assert.equal((await hitLimit(broken, k2, 1, 60)).ok, true); assert.equal((await hitLimit(broken, k2, 1, 60)).ok, false);
  const h = (m: Record<string, string>) => ({ get: (n: string) => m[n] ?? null });
  assert.equal(clientIp(h({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" })), "1.2.3.4");
  assert.equal(clientIp(h({ "x-real-ip": "5.6.7.8", "x-forwarded-for": "1.2.3.4" })), "5.6.7.8");
  assert.equal(clientIp(h({})), "unknown");
});

test("paymaster ops: only our paymaster, deposit must cover the max prefund at >= the relayer floor; self-pay untouched", () => {
  const PM = "0x1111111111111111111111111111111111111111";
  const o = op({ paymasterVerificationGasLimit: 120_000, paymasterPostOpGasLimit: 80_000 });
  const pmOp = { ...o, paymaster: PM };
  const need = maxPrefund(pmOp, relayerPrice(BASE));
  checkPaymaster(o, undefined, BigInt(0), BASE); // no paymaster: no-op
  checkPaymaster(pmOp, PM.toUpperCase().replace("0X", "0x"), need, BASE);
  const bad = (fn: () => void) => assert.throws(fn, (e: unknown) => e instanceof RelayPolicyError && e.code === "paymaster");
  bad(() => checkPaymaster(pmOp, PM, need - BigInt(1), BASE));
  bad(() => checkPaymaster(pmOp, undefined, need, BASE));
  bad(() => checkPaymaster({ ...pmOp, paymaster: "0x2222222222222222222222222222222222222222" }, PM, need, BASE));
  // a fee-0 paymaster op is priced at the relayer floor, not at 0
  bad(() => checkPaymaster({ ...pmOp, maxFeePerGas: "0x0" }, PM, BigInt(1), BASE));
  // paymaster gas limits count toward the prefund and the caps
  assert.equal(totalGas(pmOp), totalGas(o) + BigInt(200_000));
});

// ---- FLOW 1: launch-specific caps (≈ 7.9M estimated launch gas was rejected by the 3M / 4M W-1 caps)
import { capsForOp, isLaunchOp, isLaunchCalls, LAUNCH_GAS_CAPS } from "../lib/aa/gasPolicy";
import { encodeFunctionData, parseAbi, toFunctionSelector, type Hex } from "viem";
import { launchpadAbi } from "../lib/abi/Launchpad";
const LP = "0x1111111111111111111111111111111111111111", OTHER = "0x2222222222222222222222222222222222222222", TOK = "0x3333333333333333333333333333333333333333";
const acct = parseAbi(["function execute(address target, uint256 value, bytes data)", "function executeBatch((address target, uint256 value, bytes data)[] calls)"]);
const launchFn = (launchpadAbi as readonly { type: string; name?: string }[]).find((f) => f.type === "function" && /^launch(WithMode|Coin)?$/.test(f.name ?? "")) as { name: string };
const launchData = (toFunctionSelector(launchFn as never) + "00".repeat(64)) as Hex;
const approve = encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), args: [LP, BigInt(1)] });
const batch = (calls: { to: string; data: Hex }[]) => encodeFunctionData({ abi: acct, functionName: "executeBatch", args: [calls.map((c) => ({ target: c.to as Hex, value: BigInt(0), data: c.data }))] });
const launchOp = (callData: Hex, g: Record<string, number> = {}) => ({ ...op({ callGasLimit: 7_900_000, verificationGasLimit: 450_000, preVerificationGas: 60_000, ...g }), callData });

test("launch op (approve + launch to the Launchpad) gets the launch caps: ~7.9M call passes, >10M call / >11M total rejected", () => {
  const cd = batch([{ to: TOK, data: approve }, { to: LP, data: launchData }]);
  assert.equal(isLaunchOp(cd, [LP]), true);
  assert.equal(isLaunchCalls([{ to: LP, data: launchData }], [LP]), true);
  const o = launchOp(cd);
  assert.ok(checkOpGas(o, BASE, capsForOp(o, [LP])) > BigInt(0));
  assert.throws(() => checkOpGas(o, BASE), RelayPolicyError);   // same op under W-1 caps: rejected (the bug)
  const big = launchOp(cd, { callGasLimit: 10_000_001 });
  assert.throws(() => checkOpGas(big, BASE, capsForOp(big, [LP])), /callGasLimit .* above cap/);
  const tot = launchOp(cd, { callGasLimit: 10_000_000, verificationGasLimit: 900_000, preVerificationGas: 150_000 });
  assert.throws(() => checkOpGas(tot, BASE, capsForOp(tot, [LP])), /total gas .* above cap 11000000/);
  assert.equal(LAUNCH_GAS_CAPS.verificationGasLimit, GAS_CAPS.verificationGasLimit);   // only call + total widen
});
test("non-launch ops keep W-1 caps: wrong target, extra non-approve call, single execute of a trade, garbage callData", () => {
  assert.equal(isLaunchOp(batch([{ to: OTHER, data: launchData }]), [LP]), false);
  assert.equal(isLaunchOp(batch([{ to: LP, data: launchData }, { to: OTHER, data: "0xdeadbeef" }]), [LP]), false);
  assert.equal(isLaunchOp(batch([{ to: TOK, data: approve }]), [LP]), false);
  assert.equal(isLaunchOp(encodeFunctionData({ abi: acct, functionName: "execute", args: [LP, BigInt(0), "0xdeadbeef"] }), [LP]), false);
  assert.equal(isLaunchOp("0x1234", [LP]), false);
  assert.equal(capsForOp({ callData: batch([{ to: OTHER, data: launchData }]) }, [LP]), GAS_CAPS);
  // executeUserOp-prefixed single execute of a launch is still a launch
  const ex = encodeFunctionData({ abi: acct, functionName: "execute", args: [LP, BigInt(0), launchData] });
  assert.equal(isLaunchOp(("0x8dd7712f" + ex.slice(2)) as Hex, [LP]), true);
});

// ---- FLOW 2 (#106 + steep-curve floor): graduating buys get GRAD_GAS_CAPS (5M call / 6M total) after an on-chain check
import { buyIntents, exceedsCaps, GRAD_GAS_CAPS, gradBuyCandidate, isGradBuy, MAX_GRAD_BUY_INTENTS } from "../lib/aa/gasPolicy";
import { isGradBuyOp, relayCaps, type GradReads } from "../lib/server/gradBuy";
import { GRAD_STATIC_GAS, isGradBuyCalls, markGradBuy } from "../lib/aa/fastPath";
import { GradHint } from "../lib/trade/gradHint";
import { bondingCurveAbi } from "../lib/abi/BondingCurve";
import { discipleRouterAbi } from "../lib/abi/DiscipleRouter";
const CURVE = "0x4444444444444444444444444444444444444444", FAKE = "0x5555555555555555555555555555555555555555", ROUTER = "0x6666666666666666666666666666666666666666", USDG = "0x7777777777777777777777777777777777777777";
const REMAINING = BigInt(2_000) * BigInt(10) ** BigInt(18);   // quote left to graduation on CURVE
const D = BigInt(1_900_000_000);
const curveBuy = (q: bigint, to = CURVE) => ({ to, data: encodeFunctionData({ abi: bondingCurveAbi, functionName: "buy", args: [q, BigInt(1), D, OTHER as Hex] }) });
const routerBuy = (q: bigint, to = ROUTER) => ({ to, data: encodeFunctionData({ abi: discipleRouterAbi, functionName: "buyWithUsdg", args: [TOK as Hex, q, BigInt(1), D] }) });
const SENDER = "0x8888888888888888888888888888888888888888", Z = "0x0000000000000000000000000000000000000000";
const BIG = BigInt(10) ** BigInt(30);
type Funds = { balance?: bigint; allowance?: bigint; quote?: string; graduated?: boolean };
// batched reads: `calls` counts RPC round trips (each GradReads method = one eth_call / multicall); `seen` logs check() args
const reads = (o: Partial<GradReads> = {}, f: Funds = {}): GradReads & { calls: number; seen: { payToken: string; spender: string; quoteIn: bigint }[] } => {
  const r = {
    calls: 0, router: ROUTER, usdg: USDG, seen: [] as { payToken: string; spender: string; quoteIn: bigint }[],
    async curveOf(t: string) { r.calls++; return t.toLowerCase() === TOK ? CURVE : Z; },
    async curveInfo(c: string) {
      r.calls++;
      const known = c.toLowerCase() === CURVE || c.toLowerCase() === FAKE;
      return { token: known ? TOK : Z, quote: f.quote ?? USDG, graduated: f.graduated ?? false };
    },
    async check(a: { token: string; curve: string; quoteIn: bigint; payToken: string; owner: string; spender: string }) {
      r.calls++; r.seen.push({ payToken: a.payToken, spender: a.spender, quoteIn: a.quoteIn });
      return { curveOf: a.token.toLowerCase() === TOK ? CURVE : Z, graduates: isGradBuy(a.quoteIn, REMAINING), balance: f.balance ?? BIG, allowance: f.allowance ?? BIG };
    },
    ...o,
  };
  return r;
};
const gradOp = (calls: { to: string; data: Hex }[], g: Record<string, number> = {}) => ({ ...op({ callGasLimit: 3_400_000, verificationGasLimit: 350_000, preVerificationGas: 60_000, ...g }), sender: SENDER, callData: batch(calls) });
const approveTo = (token: string, spender: string, amt: bigint) => ({ to: token, data: encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), args: [spender as Hex, amt] }) });

test("GRAD_GAS_CAPS: 5M call / 6M total, everything else as GAS_CAPS; isGradBuy = quote >= remaining (> 0)", () => {
  assert.equal(GRAD_GAS_CAPS.callGasLimit, BigInt(5_000_000));
  assert.equal(GRAD_GAS_CAPS.total, BigInt(6_000_000));
  assert.equal(GRAD_GAS_CAPS.verificationGasLimit, GAS_CAPS.verificationGasLimit);
  assert.equal(GRAD_GAS_CAPS.preVerificationGas, GAS_CAPS.preVerificationGas);
  assert.equal(isGradBuy(REMAINING, REMAINING), true);
  assert.equal(isGradBuy(REMAINING - BigInt(1), REMAINING), false);
  assert.equal(isGradBuy(REMAINING, BigInt(0)), false);   // graduated / unknown
  // 16-band graduating buy ≈ 2.764M execution at 6-dec USDG (forge FloorSeedGas, audit r127: 2,763,988 C0 / 2,763,533 C1;
  // the forge cap stays 3.0M) ⇒ 1.3x + 20k self-bundler estimate fits 5M, not 3M — also at the 3.0M forge ceiling
  for (const exec of [BigInt(2_764_000), BigInt(3_000_000)]) {
    const est = exec * BigInt(13) / BigInt(10) + BigInt(20_000);
    assert.ok(est > GAS_CAPS.callGasLimit && est < GRAD_GAS_CAPS.callGasLimit);
  }
  // client static grad call gas (fastPath) covers the measured 6-dec buy
  assert.ok(GRAD_STATIC_GAS.callGasLimit >= BigInt(2_764_000));
  // session + USDG gas static grad limits fit the grad total with paymaster gas
  assert.ok(GRAD_STATIC_GAS.callGasLimit + GRAD_STATIC_GAS.verificationGasLimit + GRAD_STATIC_GAS.preVerificationGas + BigInt(300_000) <= GRAD_GAS_CAPS.total);
});
test("buyIntents decodes curve buy / buyFor and router buyWithUsdg / buyExactIn; ignores approve, sells, garbage", () => {
  const sell = { to: CURVE, data: encodeFunctionData({ abi: bondingCurveAbi, functionName: "sell", args: [BigInt(5), BigInt(1), D] }) };
  const exact = { to: ROUTER, data: encodeFunctionData({ abi: discipleRouterAbi, functionName: "buyExactIn", args: [TOK as Hex, BigInt(9), BigInt(1), OTHER as Hex, D] }) };
  const b = buyIntents(batch([{ to: USDG, data: approve }, curveBuy(BigInt(7)), sell, routerBuy(BigInt(8)), exact]));
  assert.deepEqual(b, [
    { kind: "curve", to: CURVE, quoteIn: BigInt(7), unit: "quote" },
    { kind: "router", to: ROUTER, token: TOK, quoteIn: BigInt(8), unit: "usdg" },
    { kind: "router", to: ROUTER, token: TOK, quoteIn: BigInt(9), unit: "quote" },
  ]);
  assert.deepEqual(buyIntents("0x1234"), []);
  assert.deepEqual(buyIntents([{ to: CURVE, data: "0xdeadbeef" }]), []);
});
test("relayCaps: verified graduating buy above GAS_CAPS ⇒ GRAD_GAS_CAPS (curve and router paths)", async () => {
  const o = gradOp([approveTo(USDG, CURVE, REMAINING), curveBuy(REMAINING)]);
  assert.throws(() => checkOpGas(o, BASE), /callGasLimit .* above cap 3000000/);   // the bug: rejected under W-1 caps
  const caps = await relayCaps(o, [LP], reads());
  assert.deepEqual(caps, GRAD_GAS_CAPS);   // deepEqual: tsx may load gasPolicy twice (ESM test + CJS lib)
  assert.ok(checkOpGas(o, BASE, caps) > BigInt(0));
  assert.deepEqual(await relayCaps(gradOp([approveTo(USDG, ROUTER, BIG), routerBuy(REMAINING + BigInt(1))]), [LP], reads()), GRAD_GAS_CAPS);
  // 5M call still the limit
  const big = gradOp([curveBuy(REMAINING)], { callGasLimit: 5_000_001 });
  const bigCaps = await relayCaps(big, [LP], reads());
  assert.throws(() => checkOpGas(big, BASE, bigCaps), /callGasLimit .* above cap 5000000/);
});
test("relayCaps: GAS_CAPS for non-graduating buy, fake curve, wrong router, graduated curve, unreadable chain, non-buys", async () => {
  assert.deepEqual(await relayCaps(gradOp([curveBuy(REMAINING - BigInt(1))]), [LP], reads()), GAS_CAPS);
  assert.deepEqual(await relayCaps(gradOp([curveBuy(REMAINING, FAKE)]), [LP], reads()), GAS_CAPS);   // token() points at a token whose curve isn't FAKE
  assert.deepEqual(await relayCaps(gradOp([routerBuy(REMAINING, OTHER)]), [LP], reads()), GAS_CAPS);
  assert.deepEqual(await relayCaps(gradOp([curveBuy(REMAINING)]), [LP], reads({}, { graduated: true })), GAS_CAPS);
  assert.deepEqual(await relayCaps(gradOp([curveBuy(REMAINING)]), [LP], reads({ check: async () => { throw new Error("rpc"); } })), GAS_CAPS);
  assert.deepEqual(await relayCaps(gradOp([{ to: TOK, data: approve }]), [LP], reads()), GAS_CAPS);
  assert.equal(await isGradBuyOp("0x1234", SENDER, reads()), false);
  assert.equal(await isGradBuyOp(gradOp([curveBuy(REMAINING)]).callData, undefined, reads()), false);   // no sender ⇒ can't check funds
});
test("audit r106 (gradBuy.ts:40): only a buy that is the literal last call counts, and only if the sender can pay", async () => {
  const g = curveBuy(REMAINING);
  // last call after approves ⇒ ok; anything after the buy (even an approve) ⇒ GAS_CAPS (round 2: buy must be last)
  assert.deepEqual(await relayCaps(gradOp([approveTo(USDG, CURVE, BIG), g]), [LP], reads()), GRAD_GAS_CAPS);
  assert.deepEqual(await relayCaps(gradOp([approveTo(USDG, CURVE, BIG), g, approveTo(USDG, CURVE, BIG)]), [LP], reads()), GAS_CAPS);
  const sell = { to: CURVE, data: encodeFunctionData({ abi: bondingCurveAbi, functionName: "sell", args: [BigInt(5), BigInt(1), D] }) };
  assert.deepEqual(await relayCaps(gradOp([g, sell]), [LP], reads()), GAS_CAPS);
  assert.deepEqual(await relayCaps(gradOp([g, curveBuy(BigInt(1))]), [LP], reads()), GAS_CAPS);   // grad buy not last
  assert.deepEqual(gradBuyCandidate(batch([g, sell])), null);
  // balance / allowance < quoteIn ⇒ GAS_CAPS (the buy would revert)
  assert.deepEqual(await relayCaps(gradOp([g]), [LP], reads({}, { balance: REMAINING - BigInt(1) })), GAS_CAPS);
  assert.deepEqual(await relayCaps(gradOp([g]), [LP], reads({}, { allowance: REMAINING - BigInt(1) })), GAS_CAPS);
  assert.deepEqual(await relayCaps(gradOp([g]), [LP], reads({}, { balance: REMAINING, allowance: REMAINING })), GRAD_GAS_CAPS);
  // an approve earlier in the same op to the right spender counts (on-chain allowance 0); wrong spender / token doesn't
  assert.deepEqual(await relayCaps(gradOp([approveTo(USDG, CURVE, REMAINING), g]), [LP], reads({}, { allowance: BigInt(0) })), GRAD_GAS_CAPS);
  assert.deepEqual(await relayCaps(gradOp([approveTo(USDG, ROUTER, REMAINING), g]), [LP], reads({}, { allowance: BigInt(0) })), GAS_CAPS);
  assert.deepEqual(await relayCaps(gradOp([approveTo(TOK, CURVE, REMAINING), g]), [LP], reads({}, { allowance: BigInt(0) })), GAS_CAPS);
  // later approve overrides an earlier one (approve(0) after approve(max) ⇒ allowance 0)
  assert.deepEqual(await relayCaps(gradOp([approveTo(USDG, CURVE, BIG), approveTo(USDG, CURVE, BigInt(0)), g]), [LP], reads({}, { allowance: BigInt(0) })), GAS_CAPS);
  // spender: curve for a direct buy, router for buyWithUsdg; pay token = the curve's quote
  const r1 = reads(); await relayCaps(gradOp([g]), [LP], r1);
  assert.deepEqual(r1.seen, [{ payToken: USDG, spender: CURVE, quoteIn: REMAINING }]);
  const r2 = reads(); await relayCaps(gradOp([routerBuy(REMAINING)]), [LP], r2);
  assert.deepEqual(r2.seen, [{ payToken: USDG, spender: ROUTER, quoteIn: REMAINING }]);
});
test("audit r106 (gradBuy.ts:28): bounded + batched — ≤ MAX_GRAD_BUY_INTENTS buys, one intent checked, ≤ 3 round trips", async () => {
  assert.equal(MAX_GRAD_BUY_INTENTS, 2);
  const many = gradOp([curveBuy(BigInt(1)), curveBuy(BigInt(2)), curveBuy(REMAINING)]);
  const r = reads();
  assert.deepEqual(await relayCaps(many, [LP], r), GAS_CAPS);
  assert.equal(r.calls, 0);   // rejected before any RPC
  const two = reads();   // round 2: a second buy is not an approve ⇒ not the exact shape, rejected before any RPC
  assert.deepEqual(await relayCaps(gradOp([curveBuy(BigInt(1)), curveBuy(REMAINING)]), [LP], two), GAS_CAPS);
  assert.equal(two.calls, 0);
  const one = reads();
  assert.deepEqual(await relayCaps(gradOp([curveBuy(REMAINING)]), [LP], one), GRAD_GAS_CAPS);
  assert.equal(one.calls, 2);   // curve path: curveInfo batch + check batch
  const rt = reads();
  assert.deepEqual(await relayCaps(gradOp([routerBuy(REMAINING)]), [LP], rt), GRAD_GAS_CAPS);
  assert.equal(rt.calls, 3);    // router path: curveOf + curveInfo batch + check batch
});
test("audit r106 round 2 (gasPolicy.ts:168/:177): only the exact [approve(quote, curve|router)*, buy] shape is a candidate", async () => {
  const g = curveBuy(REMAINING), rb = routerBuy(REMAINING);
  const erc20w = parseAbi(["function transfer(address,uint256)", "function approve(address,uint256)"]);
  // accepted shapes (pure): lone buy, approve(s) to the buy's spender + buy; curve and router paths
  assert.deepEqual(gradBuyCandidate(batch([g]))?.approvals, []);
  const c2 = gradBuyCandidate(batch([approveTo(USDG, CURVE, BigInt(0)), approveTo(USDG, CURVE, REMAINING), g]));
  assert.equal(c2?.approvals.length, 2); assert.equal(c2?.quoteToken, USDG);
  assert.equal(gradBuyCandidate(batch([approveTo(USDG, ROUTER, REMAINING), rb]))?.quoteToken, USDG);
  assert.deepEqual(await relayCaps(gradOp([approveTo(USDG, CURVE, REMAINING), g]), [LP], reads()), GRAD_GAS_CAPS);
  assert.deepEqual(await relayCaps(gradOp([approveTo(USDG, ROUTER, REMAINING), rb]), [LP], reads()), GRAD_GAS_CAPS);
  // rejected before any RPC: extra / unknown calls before the buy, anything after it, wrong spender, mixed tokens
  const sell = { to: CURVE, data: encodeFunctionData({ abi: bondingCurveAbi, functionName: "sell", args: [BigInt(5), BigInt(1), D] }) };
  const drain = { to: USDG, data: encodeFunctionData({ abi: erc20w, functionName: "transfer", args: [OTHER as Hex, BIG] }) };
  const fakeApprove = { to: OTHER, data: encodeFunctionData({ abi: erc20w, functionName: "approve", args: [OTHER as Hex, BigInt(1)] }) };
  const badApprove = { to: USDG, data: ("0x095ea7b3" + "00".repeat(8)) as Hex };   // approve selector, undecodable args
  const rejected: [string, { to: string; data: Hex }[]][] = [
    ["[anyCall, buy]", [sell, g]],
    ["[usdg.transfer(away, all), buy]", [drain, g]],
    ["[approve, unknown, buy]", [approveTo(USDG, CURVE, BIG), { to: OTHER, data: "0xdeadbeef" }, g]],
    ["[buy, approve-selector call to an arbitrary contract]", [g, fakeApprove]],
    ["[buy, approve(quote, curve)]", [g, approveTo(USDG, CURVE, BIG)]],
    ["wrong spender (OTHER)", [approveTo(USDG, OTHER, BIG), g]],
    ["wrong spender (router approve for a curve buy)", [approveTo(USDG, ROUTER, BIG), g]],
    ["wrong spender (curve approve for a router buy)", [approveTo(USDG, CURVE, BIG), rb]],
    ["approves on two tokens", [approveTo(USDG, CURVE, BIG), approveTo(TOK, CURVE, BIG), g]],
    ["approve selector with garbage args", [badApprove, g]],
    ["two buys", [curveBuy(BigInt(1)), g]],
  ];
  for (const [name, calls] of rejected) {
    assert.equal(gradBuyCandidate(batch(calls)), null, name);
    const r = reads();
    assert.deepEqual(await relayCaps(gradOp(calls), [LP], r), GAS_CAPS, name);
    assert.equal(r.calls, 0, name);
  }
  // wrong token: shape ok, but the approve is not on the curve's quote (USDG) ⇒ rejected after curveInfo, before check
  const wt = reads();
  assert.deepEqual(await relayCaps(gradOp([approveTo(TOK, CURVE, BIG), g]), [LP], wt), GAS_CAPS);
  assert.equal(wt.seen.length, 0);
  // post-approve funding: approve then buy with ZERO prior allowance passes; the in-op approve (not the pre-op
  // allowance) is what the buy sees, so a short approve fails even with a huge pre-op allowance
  assert.deepEqual(await relayCaps(gradOp([approveTo(USDG, CURVE, REMAINING), g]), [LP], reads({}, { allowance: BigInt(0) })), GRAD_GAS_CAPS);
  assert.deepEqual(await relayCaps(gradOp([approveTo(USDG, ROUTER, REMAINING), rb]), [LP], reads({}, { allowance: BigInt(0) })), GRAD_GAS_CAPS);
  assert.deepEqual(await relayCaps(gradOp([approveTo(USDG, CURVE, REMAINING - BigInt(1)), g]), [LP], reads({}, { allowance: BIG })), GAS_CAPS);
  assert.deepEqual(await relayCaps(gradOp([g]), [LP], reads({}, { allowance: BigInt(0) })), GAS_CAPS);   // no approve, none on-chain
  // insufficient balance fails, approve or not
  assert.deepEqual(await relayCaps(gradOp([approveTo(USDG, CURVE, BIG), g]), [LP], reads({}, { balance: REMAINING - BigInt(1), allowance: BigInt(0) })), GAS_CAPS);
  assert.deepEqual(await relayCaps(gradOp([approveTo(USDG, CURVE, BIG), g]), [LP], reads({}, { balance: REMAINING, allowance: BigInt(0) })), GRAD_GAS_CAPS);
});
test("audit r106 round 2: a USDG-gas op's leading usdg.approve(paymaster) is allowed only for our paymaster, only first", async () => {
  const PM = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", g = curveBuy(REMAINING);
  const pmOp = (calls: { to: string; data: Hex }[], paymaster?: string) => ({ ...gradOp(calls), ...(paymaster ? { paymaster } : {}) });
  const pmA = approveTo(USDG, PM, BigInt(1_000_000));
  const rp = () => reads({ paymaster: PM }, { allowance: BigInt(0) });
  assert.deepEqual(await relayCaps(pmOp([pmA, approveTo(USDG, CURVE, REMAINING), g], PM), [LP], rp()), GRAD_GAS_CAPS);
  assert.deepEqual(await relayCaps(pmOp([pmA, g], PM), [LP], reads({ paymaster: PM })), GRAD_GAS_CAPS);
  // op without a paymaster / a foreign paymaster / no paymaster configured ⇒ the approve is just a wrong spender
  assert.deepEqual(await relayCaps(pmOp([pmA, approveTo(USDG, CURVE, REMAINING), g]), [LP], rp()), GAS_CAPS);
  assert.deepEqual(await relayCaps(pmOp([pmA, approveTo(USDG, CURVE, REMAINING), g], OTHER), [LP], rp()), GAS_CAPS);
  assert.deepEqual(await relayCaps(pmOp([pmA, approveTo(USDG, CURVE, REMAINING), g], PM), [LP], reads({}, { allowance: BigInt(0) })), GAS_CAPS);
  // not first, on the wrong token, or twice ⇒ rejected; the paymaster approve never counts as the buy's allowance
  assert.deepEqual(await relayCaps(pmOp([approveTo(USDG, CURVE, REMAINING), pmA, g], PM), [LP], rp()), GAS_CAPS);
  assert.deepEqual(await relayCaps(pmOp([approveTo(TOK, PM, BIG), approveTo(USDG, CURVE, REMAINING), g], PM), [LP], rp()), GAS_CAPS);
  assert.deepEqual(await relayCaps(pmOp([pmA, pmA, g], PM), [LP], rp()), GAS_CAPS);
  assert.deepEqual(await relayCaps(pmOp([pmA, g], PM), [LP], rp()), GAS_CAPS);   // pm approve ≠ allowance to the curve
});
test("audit r106 (gasPolicy.ts:132): buyWithUsdg (USDG units) on a non-USDG curve is skipped; buyExactIn (quote units) is checked", async () => {
  const STRAT = "0x9999999999999999999999999999999999999999";
  const r = reads({}, { quote: STRAT });
  assert.deepEqual(await relayCaps(gradOp([routerBuy(REMAINING)]), [LP], r), GAS_CAPS);
  assert.equal(r.seen.length, 0);   // no quoteBuy with a USDG amount on a STRATEGY curve
  const exact = { to: ROUTER, data: encodeFunctionData({ abi: discipleRouterAbi, functionName: "buyExactIn", args: [TOK as Hex, REMAINING, BigInt(1), OTHER as Hex, D] }) };
  const r2 = reads({}, { quote: STRAT });
  assert.deepEqual(await relayCaps(gradOp([exact]), [LP], r2), GRAD_GAS_CAPS);
  assert.deepEqual(r2.seen, [{ payToken: STRAT, spender: ROUTER, quoteIn: REMAINING }]);
  // no USDG configured ⇒ buyWithUsdg never upgraded
  assert.deepEqual(await relayCaps(gradOp([routerBuy(REMAINING)]), [LP], reads({ usdg: undefined })), GAS_CAPS);
});
test("relayCaps: ops within GAS_CAPS never touch the chain; launches keep LAUNCH_GAS_CAPS", async () => {
  const r = reads();
  const small = gradOp([curveBuy(REMAINING)], { callGasLimit: 1_800_000 });
  assert.equal(exceedsCaps(small), false);
  assert.deepEqual(await relayCaps(small, [LP], r), GAS_CAPS);
  assert.equal(r.calls, 0);
  const l = launchOp(batch([{ to: LP, data: launchData }]));
  assert.deepEqual(await relayCaps(l, [LP], r), LAUNCH_GAS_CAPS);
  assert.equal(r.calls, 0);
});
test("client: markGradBuy flags exactly that call data (mav2 then skips STATIC_GAS / GasCache)", () => {
  const g = curveBuy(REMAINING), n = curveBuy(BigInt(1));
  assert.equal(isGradBuyCalls([g]), false);
  markGradBuy(g.data);
  assert.equal(isGradBuyCalls([{ to: USDG, data: approve }, g]), true);
  assert.equal(isGradBuyCalls([{ to: USDG, data: approve }, n]), false);
  for (let i = 0; i < 100; i++) markGradBuy(curveBuy(BigInt(1000 + i)).data);   // bounded
  assert.equal(isGradBuyCalls([g]), false);
});
test("GradHint: warm answers without RPC (no ⇒ smaller amounts no, yes ⇒ larger amounts yes), TTL, drop", () => {
  let t = 0; const h = new GradHint(1500, () => t);
  assert.equal(h.known(CURVE, BigInt(10)), undefined);
  h.record(CURVE, BigInt(100), false);
  assert.equal(h.known(CURVE, BigInt(100)), false);
  assert.equal(h.known(CURVE.toUpperCase().replace("0X", "0x"), BigInt(50)), false);
  assert.equal(h.known(CURVE, BigInt(101)), undefined);
  h.record(CURVE, BigInt(500), true);
  assert.equal(h.known(CURVE, BigInt(600)), true);
  assert.equal(h.known(CURVE, BigInt(300)), undefined);
  t = 1501;
  assert.equal(h.known(CURVE, BigInt(50)), undefined);
  h.record(CURVE, BigInt(100), false); h.drop(CURVE);
  assert.equal(h.known(CURVE, BigInt(50)), undefined);
});
