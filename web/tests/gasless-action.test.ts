/** flow/gasless-claims: allowlist, fee math, blocked msg.sender-only selectors, typed-data + multicall shape. */
import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { anonLauncherAbi, trampWallManagerAbi } from "../lib/abi";
import { DEPLOYMENTS } from "../lib/chains";
import {
  ACTION_GAS, actionGas, blockedActionMessage, blockedCallsMessage, checkGaslessActionRequest,
  describeBlockedCall, encodeActionCall, isRelayableCall,
  parseGaslessActionRequest, partitionRelayableCalls, transferTypedData, withdrawFeeRaw,
  type ActionCall, type GaslessActionRequest,
} from "../lib/trade/gaslessAction";
import { multicall3Abi } from "../lib/trade/gaslessWithdraw";
import { curveFeeVaultAbi } from "../lib/claims/vault";
import { unmarkedRate } from "../lib/server/usdgEthRate";
import { rateFromEnv } from "../lib/server/usdgEthRate";

const user = privateKeyToAccount(generatePrivateKey());
const feeTo = "0x00000000000000000000000000000000000000ee" as Address;
const usdg = DEPLOYMENTS[46630].usdg;
const launcher = "0x00000000000000000000000000000000000000aa" as Address;
const NOW = 1_000_000;

function claimCall(to = user.address): ActionCall {
  return {
    to: launcher,
    data: encodeFunctionData({
      abi: anonLauncherAbi, functionName: "claimManyBySig",
      args: [{ owner: user.address, tokens: [launcher], to, relayerFeeBps: 0n, deadline: BigInt(NOW + 120), sig: "0x11" as Hex }],
    }),
  };
}
function pullCall(): ActionCall {
  return { to: DEPLOYMENTS[46630].trampWallManager, data: encodeFunctionData({ abi: trampWallManagerAbi, functionName: "pull", args: [1n] }) };
}

describe("allowlist and blocked functions", () => {
  it("claimManyBySig and tramp pull (on the deployed manager) are relayable; FeeRouter/Launchpad/place/cancel are not", () => {
    expect(isRelayableCall("anonClaim", claimCall())).toBe(true);
    expect(isRelayableCall("trampPull", pullCall())).toBe(true);
    expect(isRelayableCall("trampPull", { ...pullCall(), to: launcher })).toBe(false);
    const blocked = encodeFunctionData({ abi: [{ type: "function", name: "claimCreatorFees", inputs: [{ type: "address" }], outputs: [] }] as const, functionName: "claimCreatorFees", args: [launcher] });
    expect(describeBlockedCall(blocked)).toBe("FeeRouter.claimCreatorFees(address)");
    expect(blockedActionMessage("Launchpad.claim(address)")).toMatch(/no on-behalf or signature variant/);
    const { relayable, blocked: b } = partitionRelayableCalls("anonClaim", [claimCall(), { to: launcher, data: blocked }]);
    expect(relayable).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(blockedCallsMessage(b)).toMatch(/claimCreatorFees/);
  });
});

describe("lp-accrue CurveFeeVault private-coin claims", () => {
  const vault = "0x00000000000000000000000000000000000000bb" as Address;
  const vaultClaim = (to: Address = user.address): ActionCall => ({
    to: vault,
    data: encodeFunctionData({
      abi: curveFeeVaultAbi, functionName: "claimManyAsStealthBySig",
      args: [{ owner: user.address, tokens: [launcher], to, relayerFeeBps: 0n, deadline: BigInt(NOW + 120), sig: "0x11" as Hex }],
    }),
  });
  it("claimManyAsStealthBySig is relayable next to claimManyBySig; claimCreatorFeesAsStealth (msg.sender) is not", () => {
    expect(isRelayableCall("anonClaim", vaultClaim())).toBe(true);
    const asSender = { to: vault, data: encodeFunctionData({ abi: curveFeeVaultAbi, functionName: "claimCreatorFeesAsStealth", args: [launcher, user.address] }) };
    const { relayable, blocked } = partitionRelayableCalls("anonClaim", [claimCall(), vaultClaim(), asSender]);
    expect(relayable).toHaveLength(2);
    expect(blocked).toHaveLength(1);
    expect(describeBlockedCall(asSender.data)).toMatch(/claimManyAsStealthBySig instead/);
  });
  it("vault claim payout must be the signer's wallet", () => {
    const ok = parseGaslessActionRequest({ kind: "anonClaim", signer: user.address, calls: [claimCall(), vaultClaim()], fee: 0n, feeTo });
    checkGaslessActionRequest(ok, { usdg, usdgDecimals: 6, nowSec: NOW, feeTo });
    const bad = parseGaslessActionRequest({ kind: "anonClaim", signer: user.address, calls: [vaultClaim(feeTo)], fee: 0n, feeTo });
    expect(() => checkGaslessActionRequest(bad, { usdg, usdgDecimals: 6, nowSec: NOW, feeTo })).toThrow(/payout must be the signer's/);
  });
});

describe("fee math (same 1.0x paymaster rate, round up)", () => {
  it("actionGas adds permit pad and per-extra claim, trampPull is heavier, 1.0x rate is unchanged", () => {
    expect(actionGas("anonClaim", 1, false)).toBe(ACTION_GAS.anonClaim + 20_000n);
    expect(actionGas("anonClaim", 3, true)).toBe(ACTION_GAS.anonClaim + 2n * ACTION_GAS.anonClaimPerExtra + 50_000n + 20_000n);
    expect(actionGas("trampPull", 1, false) > actionGas("anonClaim", 1, false)).toBe(true);
    const rate = unmarkedRate(rateFromEnv({ PAYMASTER_USD_PER_ETH: "2300" }, 6));
    expect(rate).toBe(2_300_000_000n);
    const fee = withdrawFeeRaw(actionGas("anonClaim", 1, true), 10_000_000n, rate, 6);
    expect(fee).toBeGreaterThan(0n);
  });
});

describe("request + multicall shape", () => {
  it("refuses a payout not paid to the signer, and a msg.sender-only call", () => {
    const q = parseGaslessActionRequest({ kind: "anonClaim", signer: user.address, calls: [claimCall(feeTo)], fee: 0n, feeTo });
    expect(() => checkGaslessActionRequest(q, { usdg, usdgDecimals: 6, nowSec: NOW, feeTo })).toThrow(/payout must be the signer's/);
    const bad = parseGaslessActionRequest({ kind: "anonClaim", signer: user.address, calls: [pullCall()], fee: 0n, feeTo });
    expect(() => checkGaslessActionRequest(bad, { usdg, usdgDecimals: 6, nowSec: NOW, feeTo })).toThrow(/not a relayable/);
  });
  it("fee=0 tramp pull encodes only the action; fee>0 prepends Permit2 transfer", async () => {
    const pull = parseGaslessActionRequest({ kind: "trampPull", signer: user.address, calls: [pullCall()], fee: 0n, feeTo });
    checkGaslessActionRequest(pull, { usdg, usdgDecimals: 6, nowSec: NOW, feeTo });
    const dec0 = decodeFunctionData({ abi: multicall3Abi, data: encodeActionCall(pull, usdg) });
    expect((dec0.args[0] as unknown as { target: Address }[]).map((c) => c.target.toLowerCase())).toEqual([DEPLOYMENTS[46630].trampWallManager.toLowerCase()]);

    const deadline = BigInt(NOW + 120);
    const fee = 5_750n;
    const feePermit = { permitted: { token: usdg, amount: fee }, nonce: 0n, deadline };
    const feeSignature = await user.signTypedData(transferTypedData(46630, feePermit));
    const who = await recoverTypedDataAddress({ ...transferTypedData(46630, feePermit), signature: feeSignature });
    expect(who.toLowerCase()).toBe(user.address.toLowerCase());
    const q: GaslessActionRequest = { kind: "anonClaim", signer: user.address, calls: [claimCall()], fee, feeTo, feePermit, feeSignature };
    checkGaslessActionRequest(q, { usdg, usdgDecimals: 6, nowSec: NOW, feeTo, minFee: fee });
    const dec = decodeFunctionData({ abi: multicall3Abi, data: encodeActionCall(q, usdg) });
    const targets = (dec.args[0] as unknown as { target: Address }[]).map((c) => c.target.toLowerCase());
    expect(targets[0]).toBe("0x000000000022d473030f116ddee9f6b43ac78ba3"); // PERMIT2
    expect(targets[1]).toBe(launcher.toLowerCase());
    expect(encodeActionCall(q, usdg).startsWith("0x")).toBe(true);
  });
  it("amount-style minFee refusal when the signed fee is below the live quote", () => {
    const q = parseGaslessActionRequest({ kind: "anonClaim", signer: user.address, calls: [claimCall()], fee: 1n, feeTo,
      feePermit: { permitted: { token: usdg, amount: 1n }, nonce: 0n, deadline: BigInt(NOW + 10) }, feeSignature: ("0x" + "11".repeat(65)) as Hex });
    expect(() => checkGaslessActionRequest(q, { usdg, usdgDecimals: 6, nowSec: NOW, feeTo, minFee: 2n })).toThrow(/fee changed/);
  });
});
