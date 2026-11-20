/** maker 2026-11-19: gasless public claims, signed creator edits and the Permit2 wallet launch (players hold USDG only). */
import { describe, expect, it } from "vitest";
import {
  encodeAbiParameters, encodeFunctionData, hashTypedData, keccak256, parseAbi, recoverTypedDataAddress, stringToHex,
  concatHex, type Address, type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { deployment } from "../lib/chains";
import { checkGaslessActionRequest, claimTokenArg, isRelayableCall, parseGaslessActionRequest } from "../lib/trade/gaslessAction";
import {
  checkWalletLaunch, launchParamsHash, parseWalletLaunchRequest, walletLaunchTypedData, type LaunchParams,
} from "../lib/trade/gaslessWalletLaunch";
import { PERMIT2 } from "../lib/trade/gaslessPermit2";

const d = deployment();
const user = privateKeyToAccount(generatePrivateKey());
const coin = "0x00000000000000000000000000000000000000c1" as Address;
const other = "0x00000000000000000000000000000000000000ab" as Address;
const NOW = 1_000_000;
const abi = parseAbi([
  "function claimCreatorFees(address token)",
  "function claimCreatorTokenFees(address token)",
  "function claimReferrerFeesFor_2143(address referrer, address quote)",
  "function claimReferrerFeesFor(address referrer, address quote, address[] settleTokens)",
  "function claimFor(address token, address holder)",
  "function transferCreatorBySig(address token, address newCreator, uint256 deadline, bytes sig)",
  "function updateMetadataBySig(address token, string imageURI, string description, string socialsURI, uint256 deadline, bytes sig)",
  "function setCreatorFeeRecipientBySig(address token, address recipient, uint256 deadline, bytes sig)",
]);
const call = (to: Address, data: Hex) => ({ to, data });

describe("public claims relay as anonClaim, only to the known contracts", () => {
  it("FeeRouter / vault / hook / Launchpad claims are relayable on their own contract only", () => {
    const cc = encodeFunctionData({ abi, functionName: "claimCreatorFees", args: [coin] });
    expect(isRelayableCall("anonClaim", call(d.feeRouter, cc))).toBe(true);
    expect(isRelayableCall("anonClaim", call(d.hook, cc))).toBe(true);
    expect(isRelayableCall("anonClaim", call(other, cc))).toBe(false);
    expect(isRelayableCall("anonClaim", call(other, cc), new Set([other.toLowerCase()]))).toBe(true);
    expect(isRelayableCall("anonClaim", call(d.feeRouter, encodeFunctionData({ abi, functionName: "claimCreatorTokenFees", args: [coin] })))).toBe(true);
    expect(isRelayableCall("anonClaim", call(d.feeRouter, encodeFunctionData({ abi, functionName: "claimReferrerFeesFor_2143", args: [user.address, coin] })))).toBe(true);
    const crew = encodeFunctionData({ abi, functionName: "claimFor", args: [coin, user.address] });
    expect(isRelayableCall("anonClaim", call(d.launchpad, crew))).toBe(true);
    expect(isRelayableCall("anonClaim", call(d.feeRouter, crew))).toBe(false);
    expect(claimTokenArg(call(d.feeRouter, cc))?.toLowerCase()).toBe(coin.toLowerCase());
  });
  it("public claims skip the payout-is-signer rule (the contract decides who is paid)", () => {
    const q = parseGaslessActionRequest({ kind: "anonClaim", signer: user.address, fee: 0n, feeTo: other,
      calls: [call(d.launchpad, encodeFunctionData({ abi, functionName: "claimFor", args: [coin, user.address] }))] });
    expect(() => checkGaslessActionRequest(q, { usdg: d.usdg, usdgDecimals: 6, nowSec: NOW, feeTo: other })).not.toThrow();
  });
});

describe("creatorEdit: signed edits on Launchpad and CreatorFeeHarvest only", () => {
  it("allows the three BySig calls on their contracts and nothing else", () => {
    const t = encodeFunctionData({ abi, functionName: "transferCreatorBySig", args: [coin, other, 1n, "0x11"] });
    const m = encodeFunctionData({ abi, functionName: "updateMetadataBySig", args: [coin, "ipfs://x", "", "", 1n, "0x11"] });
    const p = encodeFunctionData({ abi, functionName: "setCreatorFeeRecipientBySig", args: [coin, other, 1n, "0x11"] });
    expect(isRelayableCall("creatorEdit", call(d.launchpad, t))).toBe(true);
    expect(isRelayableCall("creatorEdit", call(d.launchpad, m))).toBe(true);
    expect(isRelayableCall("creatorEdit", call(d.creatorFeeHarvest, p))).toBe(true);
    expect(isRelayableCall("creatorEdit", call(other, t))).toBe(false);
    expect(isRelayableCall("creatorEdit", call(d.launchpad, p))).toBe(false);
  });
});

describe("Permit2 wallet launch witness matches CreatorFeeHarvest", () => {
  const params: LaunchParams = {
    name: "Moon", ticker: "MOON", imageURI: "ipfs://img", description: "", socialsURI: "", quote: d.usdg,
    creatorTaxBps: 100n, creatorBuyQuoteIn: 0n, creatorBuyMinTokensOut: 5n, deadline: BigInt(NOW + 300),
  };
  const harvest = "0x00000000000000000000000000000000000000f1" as Address;
  const w = { paramsHash: launchParamsHash(params), mode: 1, usdgIn: 10_000_000n, minQuoteIn: 9_900_000n, creatorFeeDestination: 0, gasFee: 200_000n };
  const permit = { permitted: { token: d.usdg, amount: w.usdgIn + w.gasFee }, nonce: 7n, deadline: BigInt(NOW + 120) };

  it("hashes the way the contract's GaslessWalletLaunch test signs it", () => {
    const witnessType = "GaslessLaunch witness)GaslessLaunch(bytes32 paramsHash,uint8 mode,uint256 usdgIn,uint256 minQuoteIn,uint8 creatorFeeDestination,uint256 gasFee)TokenPermissions(address token,uint256 amount)";
    const typeHash = keccak256(stringToHex(`PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,${witnessType}`));
    const launchTypeHash = keccak256(stringToHex("GaslessLaunch(bytes32 paramsHash,uint8 mode,uint256 usdgIn,uint256 minQuoteIn,uint8 creatorFeeDestination,uint256 gasFee)"));
    const witness = keccak256(encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "uint8" }, { type: "uint256" }],
      [launchTypeHash, w.paramsHash, w.mode, w.usdgIn, w.minQuoteIn, w.creatorFeeDestination, w.gasFee]));
    const tp = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [keccak256(stringToHex("TokenPermissions(address token,uint256 amount)")), permit.permitted.token, permit.permitted.amount]));
    const sh = keccak256(encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
      [typeHash, tp, harvest, permit.nonce, permit.deadline, witness]));
    const dom = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [keccak256(stringToHex("EIP712Domain(string name,uint256 chainId,address verifyingContract)")), keccak256(stringToHex("Permit2")), 46630n, PERMIT2]));
    const digest = keccak256(concatHex(["0x1901", dom, sh]));
    expect(hashTypedData(walletLaunchTypedData(46630, harvest, permit, w))).toBe(digest);
  });

  it("checks amount, params hash, $1 cap and deadlines before sending", async () => {
    const sig = await user.signTypedData(walletLaunchTypedData(46630, harvest, permit, w));
    expect(await recoverTypedDataAddress({ ...walletLaunchTypedData(46630, harvest, permit, w), signature: sig })).toBe(user.address);
    const raw = JSON.parse(JSON.stringify({ signer: user.address, permit, params, w, signature: sig }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    const q = parseWalletLaunchRequest(raw);
    const o = { usdg: d.usdg, usdgDecimals: 6, nowSec: NOW };
    expect(() => checkWalletLaunch(q, o)).not.toThrow();
    expect(() => checkWalletLaunch({ ...q, params: { ...q.params, name: "Other" } }, o)).toThrow(/don't match/);
    expect(() => checkWalletLaunch({ ...q, w: { ...q.w, gasFee: 4_000_000n }, permit: { ...q.permit, permitted: { ...q.permit.permitted, amount: q.w.usdgIn + 4_000_000n } } }, o)).toThrow(/over \$3/);
    expect(() => checkWalletLaunch({ ...q, permit: { ...q.permit, permitted: { ...q.permit.permitted, amount: 1n } } }, o)).toThrow(/amount/);
    expect(() => checkWalletLaunch(q, { ...o, nowSec: NOW + 10_000 })).toThrow(/expired/);
  });
});
