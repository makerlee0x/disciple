// Unit tests for the claims stack (pure, no RPC): redeploy gate, session policy for claims/deposits,
// escrow unlock labels, custom-error decoding.   pnpm test:claims
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeErrorResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { redeployGate, abiHas } from "../lib/claims/capabilities";
import { checkCalls, depositTotal, PolicyError, type PolicyCfg } from "../lib/aa/policy";
import { unlockLabel, unlocked, withdrawCall } from "../lib/claims/referralGate";
import { claimErrorText, fmtUsd, toUsd } from "../lib/claims/common";
import { AAError } from "../lib/aa/core";
import { depositNotifierAbi, feeRouterRedeployAbi, curveRedeployAbi } from "../lib/abi/redeploy";
import { feeRouterAbi } from "../lib/abi";

const A = (n: number) => (`0x${n.toString(16).padStart(40, "0")}`) as Address;
const LP = A(1), ROUTER = A(2), TWM = A(3), FR = A(4), NOTI = A(5), USDG = A(6), ME = A(7), OTHER = A(8);
const cfg: PolicyCfg = { launchpad: LP, router: ROUTER, trampWallManager: TWM, mintable: [], defaultLimit: BigInt(10) ** BigInt(30), feeRouter: FR, depositNotifier: NOTI, usdg: USDG };
const st = () => ({ expiresAt: Date.now() + 60_000, spent: {} });
const pcNoCurve = { readContract: async () => { throw new Error("not a curve"); } } as never;
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)"]);
const call = (to: Address, data: Hex) => ({ to, data });

test("redeployGate: 1 on, 0 off, unset = ABI signal", () => {
  assert.equal(redeployGate("1", false), true);
  assert.equal(redeployGate("true", false), true);
  assert.equal(redeployGate("0", true), false);
  assert.equal(redeployGate(undefined, true), true);
  assert.equal(redeployGate(undefined, false), false);
  assert.equal(redeployGate("", false), false);
});
test("abiHas: v3 FeeRouter has the creator/referrer claims, redeploy ABI adds token-side", () => {
  assert.ok(abiHas(feeRouterAbi, "claimCreatorFees") && abiHas(feeRouterAbi, "creatorAccrued") && abiHas(feeRouterAbi, "claimReferrerFees"));
  assert.ok(abiHas(feeRouterRedeployAbi, "claimCreatorTokenFees"));
  assert.ok(abiHas(curveRedeployAbi, "pendingRewards"));
});

test("policy: FeeRouter claim selectors pass, anything else on FeeRouter is rejected", async () => {
  for (const [fn, arg] of [["claimCreatorFees", A(9)], ["claimReferrerFees", USDG], ["claimCreatorTokenFees", A(9)]] as const) {
    const data = encodeFunctionData({ abi: parseAbi([`function ${fn}(address) returns (uint256)`]), functionName: fn, args: [arg] });
    await checkCalls(pcNoCurve, cfg, st(), [call(FR, data)], ME);
  }
  const bad = encodeFunctionData({ abi: parseAbi(["function setTreasury(address)"]), functionName: "setTreasury", args: [OTHER] });
  await assert.rejects(checkCalls(pcNoCurve, cfg, st(), [call(FR, bad)], ME), PolicyError);
});
test("policy: without feeRouter configured, claim calls are rejected (fail closed)", async () => {
  const data = encodeFunctionData({ abi: feeRouterAbi, functionName: "claimCreatorFees", args: [A(9)] });
  await assert.rejects(checkCalls(pcNoCurve, { ...cfg, feeRouter: undefined }, st(), [call(FR, data)], ME), PolicyError);
});
test("policy: deposit needs exact paired approve and must be for the account", async () => {
  const amt = BigInt(10) * BigInt(10) ** BigInt(18);
  const dep = (w: Address, a: bigint) => call(NOTI, encodeFunctionData({ abi: depositNotifierAbi, functionName: "deposit", args: [w, a] }));
  const ap = (a: bigint) => call(USDG, encodeFunctionData({ abi: erc20, functionName: "approve", args: [NOTI, a] }));
  assert.equal(depositTotal([ap(amt), dep(ME, amt)], NOTI), amt);
  await checkCalls(pcNoCurve, cfg, st(), [ap(amt), dep(ME, amt)], ME);
  await assert.rejects(checkCalls(pcNoCurve, cfg, st(), [ap(amt + BigInt(1)), dep(ME, amt)], ME), /equal the deposit/);
  await assert.rejects(checkCalls(pcNoCurve, cfg, st(), [ap(amt), dep(OTHER, amt)], ME), /this account/);
  await checkCalls(pcNoCurve, cfg, st(), [call(NOTI, withdrawCall([0, 2]).data)], ME);
  const tr = call(NOTI, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [OTHER, amt] }));
  await assert.rejects(checkCalls(pcNoCurve, cfg, st(), [tr], ME), PolicyError);
});

test("unlock countdown and unlocked()", () => {
  const now = 1_700_000_000;
  assert.equal(unlockLabel(now - 1, now), "Unlocked");
  assert.equal(unlockLabel(now + 3 * 86400 + 4 * 3600 + 5, now), "Unlocks in 3d 4h");
  assert.equal(unlockLabel(now + 2 * 3600 + 15 * 60, now), "Unlocks in 2h 15m");
  assert.equal(unlockLabel(now + 20, now), "Unlocks in 1m");
  assert.equal(unlocked({ id: 0, amount: BigInt(1), unlockAt: now }, now), true);
  assert.equal(unlocked({ id: 0, amount: BigInt(1), unlockAt: now + 1 }, now), false);
});

test("revert decoding: Locked / BelowMinimum / NothingToClaim → plain copy", () => {
  const wrap = (data: Hex) => new AAError("Reverted", "reverted", { revertData: data });
  const locked = encodeErrorResult({ abi: depositNotifierAbi, errorName: "Locked", args: [BigInt(3), BigInt(1_800_000_000)] });
  assert.match(claimErrorText(wrap(locked)), /^Still locked until /);
  const below = encodeErrorResult({ abi: depositNotifierAbi, errorName: "BelowMinimum", args: [BigInt(10)] });
  assert.equal(claimErrorText(wrap(below)), "Deposit is below the minimum.");
  const none = encodeErrorResult({ abi: feeRouterAbi, errorName: "NothingToClaim" });
  assert.equal(claimErrorText(wrap(none)), "Nothing to claim yet.");
  assert.equal(claimErrorText(new Error("User rejected the request")), "Cancelled.");
});
test("USD helpers", () => {
  const a = { address: USDG, symbol: "USDG", decimals: 6, usd: 1 };
  assert.equal(toUsd(BigInt(12_340_000), a), 12.34);
  assert.equal(toUsd(BigInt(1), { ...a, usd: null }), null);
  assert.equal(fmtUsd(12.34), "$12.34");
});
