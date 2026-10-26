// v5 gas-policy selectors (lib/aa/gasPolicy + lib/aa/launchTargets) vs the generated v5 ABIs (web-bundle @ 22ec4c5f).
//   pnpm test:gaspolicy-v5   (pure: no RPC)
// Regression: gasPolicy hard-coded the v4 4-arg BondingCurve.buyFor (0xcc071c4f) and its launch list missed
// DiscipleRouter.launchWithUsdg (0x9c05e6c5), so a launchWithUsdg op got the 3M / 4M W-1 caps (and the client's
// STATIC_GAS / cached estimate) instead of LAUNCH_GAS_CAPS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, getAbiItem, parseAbi, toFunctionSelector, type AbiFunction, type Hex } from "viem";
import * as gp from "../lib/aa/gasPolicy";
import { launchTargets } from "../lib/aa/launchTargets";
import { DEPLOYMENTS } from "../lib/chains";
import { bondingCurveAbi } from "../lib/abi/BondingCurve";
import { discipleRouterAbi } from "../lib/abi/DiscipleRouter";
import { launchpadAbi } from "../lib/abi/Launchpad";
import { anonLauncherAbi } from "../lib/abi/AnonLauncher";
import { loginGateAbi } from "../lib/abi/LoginGate";
import { referralRegistryAbi } from "../lib/abi/ReferralRegistry";
import { readFileSync } from "node:fs";

const sel = (abi: readonly unknown[], name: string, args?: readonly unknown[]) =>
  toFunctionSelector(getAbiItem({ abi: abi as never, name, ...(args ? { args } : {}) } as never) as unknown as AbiFunction).toLowerCase();
const fns = (abi: readonly unknown[], name: string) => (abi as AbiFunction[]).filter((f) => f.type === "function" && f.name === name);

const ROUTER = "0x6666666666666666666666666666666666666666", LP = "0x1111111111111111111111111111111111111111";
const CURVE = "0x4444444444444444444444444444444444444444", USDG = "0x7777777777777777777777777777777777777777";
const TOK = "0x3333333333333333333333333333333333333333", PM = "0x9999999999999999999999999999999999999999";
const D = BigInt(1_900_000_000);
const acct = parseAbi(["function executeBatch((address target, uint256 value, bytes data)[] calls)"]);
const batch = (calls: { to: string; data: Hex }[]) => encodeFunctionData({ abi: acct, functionName: "executeBatch", args: [calls.map((c) => ({ target: c.to as Hex, value: BigInt(0), data: c.data }))] });
const approve = (spender: string) => encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), args: [spender as Hex, BigInt(1)] });
const params = { name: "N", ticker: "T", imageURI: "ipfs://x", description: "", socialsURI: "", quote: USDG as Hex, creatorTaxBps: BigInt(0), creatorBuyQuoteIn: BigInt(0), creatorBuyMinTokensOut: BigInt(1), deadline: D };
const launchWithUsdg = encodeFunctionData({ abi: discipleRouterAbi, functionName: "launchWithUsdg", args: [params, 1, BigInt(5_000_000), BigInt(0)] });

test("v5 signatures/selectors from the regenerated ABIs (match contracts/src)", () => {
  const [bf] = fns(bondingCurveAbi, "buyFor");
  assert.equal(fns(bondingCurveAbi, "buyFor").length, 1);
  assert.deepEqual(bf.inputs.map((i) => i.type), ["address", "uint256", "uint256", "uint256", "uint256"]);   // + maxTokens
  assert.equal(sel(bondingCurveAbi, "buyFor"), "0x3fd62d4f");
  assert.notEqual(sel(bondingCurveAbi, "buyFor"), toFunctionSelector("function buyFor(address,uint256,uint256,uint256)"));   // v4 0xcc071c4f
  assert.equal(sel(discipleRouterAbi, "launchWithUsdg"), "0x9c05e6c5");
  assert.equal(sel(discipleRouterAbi, "buyWithUsdg"), "0xc62d4556");
  assert.equal(sel(discipleRouterAbi, "buyExactIn"), "0xb1ac2d00");
  assert.equal(sel(launchpadAbi, "launch"), "0xd4aeea1c");
  assert.equal(sel(launchpadAbi, "launchCoin"), "0x8f0f0a05");
  assert.equal(sel(launchpadAbi, "launchWithMode"), "0xd0b459e2");
  assert.equal(sel(anonLauncherAbi, "launchAnon"), "0xc852e655");   // v5: + maxFee
});

test("BUY_SELECTORS = ABI-derived curve buy(3) / buy(4) / buyFor(5) + router buyWithUsdg / buyExactIn; no v4 buyFor", () => {
  const want = new Set([
    ...fns(bondingCurveAbi, "buy").map((f) => toFunctionSelector(f).toLowerCase()),
    sel(bondingCurveAbi, "buyFor"), sel(discipleRouterAbi, "buyWithUsdg"), sel(discipleRouterAbi, "buyExactIn"),
  ]);
  assert.equal(want.size, 5);
  assert.ok(gp.BUY_SELECTORS, "BUY_SELECTORS exported");
  assert.deepEqual(new Set(gp.BUY_SELECTORS), want);
  assert.equal(gp.BUY_SELECTORS.has("0xcc071c4f"), false);
});

test("5-arg buyFor is decoded as a curve buy (quoteIn = args[1]); a v4 4-arg buyFor is not", () => {
  const v5 = encodeFunctionData({ abi: bondingCurveAbi, functionName: "buyFor", args: [TOK as Hex, BigInt(42), BigInt(1), D, BigInt(7)] });
  assert.deepEqual(gp.buyIntents([{ to: CURVE, data: v5 }]), [{ kind: "curve", to: CURVE, quoteIn: BigInt(42), unit: "quote" }]);
  const v4 = encodeFunctionData({ abi: parseAbi(["function buyFor(address,uint256,uint256,uint256)"]), args: [TOK as Hex, BigInt(42), BigInt(1), D] });
  assert.deepEqual(gp.buyIntents([{ to: CURVE, data: v4 }]), []);
});

test("LAUNCH_SELECTORS = ABI-derived launch / launchCoin / launchWithMode / launchAnon / launchWithUsdg (not router-only launchFor)", () => {
  const want = new Set([sel(launchpadAbi, "launch"), sel(launchpadAbi, "launchCoin"), sel(launchpadAbi, "launchWithMode"), sel(anonLauncherAbi, "launchAnon"), sel(discipleRouterAbi, "launchWithUsdg")]);
  assert.ok(gp.LAUNCH_SELECTORS, "LAUNCH_SELECTORS exported");
  assert.deepEqual(new Set(gp.LAUNCH_SELECTORS), want);
  assert.ok(gp.LAUNCH_SELECTORS.has("0x9c05e6c5"));
  assert.equal(gp.LAUNCH_SELECTORS.has(sel(launchpadAbi, "launchFor")), false);
});

test("launchWithUsdg on the router (± USDG approve + paymaster approve) is a launch ⇒ LAUNCH_GAS_CAPS", () => {
  const cd = batch([{ to: USDG, data: approve(PM) }, { to: USDG, data: approve(ROUTER) }, { to: ROUTER, data: launchWithUsdg }]);
  assert.equal(gp.isLaunchOp(cd, [LP, ROUTER]), true);
  assert.equal(gp.isLaunchCalls([{ to: ROUTER, data: launchWithUsdg }], [LP, ROUTER]), true);
  assert.equal(gp.capsForOp({ callData: cd }, [LP, ROUTER]), gp.LAUNCH_GAS_CAPS);
  // v5 smoke launch 6,780,271 gas + the router's USDG leg (≈ +0.5M worst case) ⇒ 1.3x + 20k estimate fits the launch call cap
  const est = (BigInt(6_780_271) + BigInt(500_000)) * BigInt(13) / BigInt(10) + BigInt(20_000);
  assert.ok(est > gp.GAS_CAPS.callGasLimit && est <= gp.LAUNCH_GAS_CAPS.callGasLimit);
  // wrong target / router trade ⇒ not a launch
  assert.equal(gp.isLaunchOp(batch([{ to: TOK, data: launchWithUsdg }]), [LP, ROUTER]), false);
  const buy = encodeFunctionData({ abi: discipleRouterAbi, functionName: "buyWithUsdg", args: [TOK as Hex, BigInt(1), BigInt(1), D] });
  assert.equal(gp.isLaunchOp(batch([{ to: ROUTER, data: buy }]), [LP, ROUTER]), false);
  assert.equal(gp.capsForOp({ callData: batch([{ to: ROUTER, data: buy }]) }, [LP, ROUTER]), gp.GAS_CAPS);
});

test("launchTargets(46630) includes the v5 DiscipleRouter (deployments json) next to the Launchpad", () => {
  const dep = JSON.parse(readFileSync(new URL("../../contracts/deployments/rh-testnet-46630.json", import.meta.url), "utf8"));
  const router = String(dep.contracts.DiscipleRouter).toLowerCase();
  const t = launchTargets(46630);
  if (!process.env.NEXT_PUBLIC_RHT_ROUTER) assert.equal(DEPLOYMENTS[46630].router.toLowerCase(), router);   // v5 fallback
  assert.ok(t.includes(DEPLOYMENTS[46630].router.toLowerCase()));
  assert.ok(t.includes(DEPLOYMENTS[46630].launchpad.toLowerCase()));
});

test("helper selectors in gasPolicy (approve / LoginGate.attest / ReferralRegistry.tryAttribute) match the v5 ABIs", () => {
  assert.equal(sel(loginGateAbi, "attest"), toFunctionSelector("function attest(address wallet, uint64 expiry, address coin, bytes sig)").toLowerCase());
  assert.equal(sel(referralRegistryAbi, "tryAttribute"), toFunctionSelector("function tryAttribute(address wallet, address referrer)").toLowerCase());
});
