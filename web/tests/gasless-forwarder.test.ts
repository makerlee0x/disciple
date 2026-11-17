/**
 * DisciplePermitForwarder, site side (lib/trade/permitForwarder): the witness hashes and type strings match the contract
 * (contracts/test/security/PermitForwarder.t.sol pins the same vectors), the EIP-712 type strings are in the order viem signs,
 * and the mainnet lock: no forwarder ⇒ Multicall3 only on testnet, and mainnet refuses.
 */
import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => { process.env.NEXT_PUBLIC_RHT_PERMIT_FORWARDER = "0x0000000000000000000000000000000000000000"; }); // "not deployed" for the lock tests
import { concat, decodeFunctionData, encodeAbiParameters, hashStruct, hashTypedData, keccak256, toBytes, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ACTION_WITNESS_TYPE, MULTICALL3_ADDR, WITHDRAW_WITNESS_TYPE, actionTypedData, callsHash, encodeForwarderLaunch, forwarderAbi,
  hashAction, hashWithdraw, relaySpender, withdrawTypedData,
} from "../lib/trade/permitForwarder";
import { ANON_LAUNCH_LIMITS, ANON_LAUNCH_TYPE_MODES, ANON_LAUNCH_WITNESS_TYPE, anonLaunchModesTypes, anonLaunchTooLong, anonLaunchTypedData, anonLaunchTypes, anonLaunchWitnessHash, type AnonLaunch } from "../lib/trade/gaslessAnonLaunch";
import { actionWitness } from "../lib/trade/gaslessAction";
import { PERMIT2, type Permit } from "../lib/trade/gaslessPermit2";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const FWD = a(0xf0);
const permit: Permit = { permitted: { token: a(0xbeef), amount: 13n }, nonce: 5n, deadline: 99n };
const launch: AnonLaunch = {
  name: "Halo Runner", ticker: "HALO", imageURI: "ipfs://img", description: "d", socialsURI: "", quote: a(0xbeef), creatorTaxBps: 0n,
  creatorBuyQuoteIn: 0n, creatorBuyMinTokensOut: 0n, deadline: 1_800_000_000n, stealthOwner: a(0x5ea1), buyRecipient: a(0x5ea1),
  ephemeralPubKey: "0x02aabbcc", viewTag: "0x7f", maxFee: 3n * 10n ** 18n, usdgIn: 10n * 10n ** 18n, minQuoteIn: 0n, refundTo: a(0xa11ce),
  launcher: a(0x1a), creatorFeeDestination: 1,
};

/** What Permit2 computes on chain from the witness type string the contract passes (permitWitnessTransferFrom). */
function permit2Digest(chainId: number, spender: Address, p: Permit, witness: Hex, witnessType: string): Hex {
  const typeHash = keccak256(toBytes(`PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,${witnessType}`));
  const tp = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "uint256" }], [keccak256(toBytes("TokenPermissions(address token,uint256 amount)")), p.permitted.token, p.permitted.amount]));
  const sh = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
    [typeHash, tp, spender, p.nonce, p.deadline, witness]));
  const dom = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [keccak256(toBytes("EIP712Domain(string name,uint256 chainId,address verifyingContract)")), keccak256(toBytes("Permit2")), BigInt(chainId), PERMIT2]));
  return keccak256(concat(["0x1901", dom, sh]));
}

describe("witness hashes = the contract's (pinned in PermitForwarder.t.sol test_vectors)", () => {
  it("withdraw / action / launch vectors", () => {
    expect(hashWithdraw({ to: a(0xb0b), fee: 1234n, feeTo: a(0xfee) })).toBe("0x829688fa6c53b8799d518d5fa5a010a449c5d40c270731786c9476b5c2db51b9");
    expect(hashAction({ feeTo: a(0xfee), callsHash: keccak256(toBytes("calls")) })).toBe("0x42fa0f62b3b00c3cd402c82344fbc9743ba26d6af606d9e6903eb14e61b42af7");
    expect(hashStruct({ data: launch, types: anonLaunchTypes, primaryType: "AnonLaunch" })).toBe("0x25405878d7714c648e45726cd0ce0c377ef27708c8fa3609d5cb3ac37028ce23");
    expect(anonLaunchWitnessHash(launch, false)).toBe("0x25405878d7714c648e45726cd0ce0c377ef27708c8fa3609d5cb3ac37028ce23");
  });
  it("launch vector with the difficulty (modes forwarder, mode = 1 Easy)", () => {
    const l = { ...launch, mode: 1 };
    expect(hashStruct({ data: l, types: anonLaunchModesTypes, primaryType: "AnonLaunch" })).toBe("0xc0d223b21e6726536f1f19479bb7acc0f732b1834a01a1762ff456486a9b9cd2");
    expect(anonLaunchWitnessHash(l, true)).toBe("0xc0d223b21e6726536f1f19479bb7acc0f732b1834a01a1762ff456486a9b9cd2");
    expect(ANON_LAUNCH_TYPE_MODES.endsWith("uint8 creatorFeeDestination,uint8 mode)")).toBe(true);
  });
});

describe("type strings are in the order players sign (viem sorts referenced structs)", () => {
  it("withdraw", () => {
    const w = { to: a(0xb0b), fee: 1n, feeTo: a(0xfee) };
    expect(hashTypedData(withdrawTypedData(46630, FWD, permit, w))).toBe(permit2Digest(46630, FWD, permit, hashWithdraw(w), WITHDRAW_WITNESS_TYPE));
  });
  it("action", () => {
    const x = { feeTo: a(0xfee), callsHash: keccak256(toBytes("c")) };
    expect(hashTypedData(actionTypedData(46630, FWD, permit, x))).toBe(permit2Digest(46630, FWD, permit, hashAction(x), ACTION_WITNESS_TYPE));
  });
  it("private launch (the old string had TokenPermissions first, which Permit2 rejected)", () => {
    expect(hashTypedData(anonLaunchTypedData(46630, permit, launch, FWD) as never)).toBe(permit2Digest(46630, FWD, permit, anonLaunchWitnessHash(launch), ANON_LAUNCH_WITNESS_TYPE));
    expect(ANON_LAUNCH_WITNESS_TYPE.startsWith("AnonLaunch witness)AnonLaunch(")).toBe(true);
  });
});

describe("mainnet lock (relaySpender)", () => {
  it("testnet without a forwarder keeps Multicall3", () => {
    expect(relaySpender(46630)).toEqual({ kind: "multicall3", address: MULTICALL3_ADDR });
  });
  it("mainnet without a forwarder refuses: nothing is signed or sent", () => {
    expect(() => relaySpender(4663)).toThrow(/aren't available on this network/);
  });
  it("private launches never fall back to Multicall3, not even on testnet", () => {
    expect(() => relaySpender(46630, { legacy: false })).toThrow(/private launches aren't available/);
    expect(() => relaySpender(4663, { legacy: false })).toThrow();
  });
  it("an unknown chain refuses too", () => {
    expect(() => relaySpender(1)).toThrow();
  });
});

describe("action witness binds the calls", () => {
  it("different calls ⇒ different hash; same calls ⇒ same", () => {
    const c1 = [{ to: a(1), data: "0x12345678" as Hex }], c2 = [{ to: a(1), data: "0x12345679" as Hex }];
    expect(actionWitness({ feeTo: a(9), calls: c1 }).callsHash).toBe(actionWitness({ feeTo: a(9), calls: [...c1] }).callsHash);
    expect(actionWitness({ feeTo: a(9), calls: c1 }).callsHash).not.toBe(actionWitness({ feeTo: a(9), calls: c2 }).callsHash);
    expect(callsHash([{ target: a(1), data: "0x12345678" }])).toBe(actionWitness({ feeTo: a(9), calls: c1 }).callsHash);
  });
});

describe("signatures recover through the forwarder typed data", () => {
  it("a viem account's withdraw signature verifies against the same digest Permit2 builds", async () => {
    const acct = privateKeyToAccount(generatePrivateKey());
    const w = { to: a(0xb0b), fee: 3n, feeTo: a(0xfee) };
    const sig = await acct.signTypedData(withdrawTypedData(46630, FWD, permit, w));
    const { recoverAddress } = await import("viem");
    expect(await recoverAddress({ hash: permit2Digest(46630, FWD, permit, hashWithdraw(w), WITHDRAW_WITNESS_TYPE), signature: sig })).toBe(acct.address);
  });
  it("launch calldata carries the signed launch unchanged", () => {
    const data = encodeForwarderLaunch({ permit, l: launch, owner: a(0xa11ce), signature: "0x" });
    const dec = decodeFunctionData({ abi: forwarderAbi, data });
    expect(dec.functionName).toBe("launchAnon");
    expect((dec.args[1] as AnonLaunch).name).toBe("Halo Runner");
    expect((dec.args[1] as AnonLaunch).creatorFeeDestination).toBe(1);
  });
});

describe("private-launch metadata caps (keep a signed launch under the 8.5M gas limit)", () => {
  it("normal metadata passes; each oversized field is refused with a plain message", () => {
    expect(anonLaunchTooLong(launch)).toBeNull();
    expect(anonLaunchTooLong({ ...launch, description: "x".repeat(ANON_LAUNCH_LIMITS.description) })).toBeNull();
    expect(anonLaunchTooLong({ ...launch, description: "x".repeat(ANON_LAUNCH_LIMITS.description + 1) })).toMatch(/description is too long/);
    expect(anonLaunchTooLong({ ...launch, name: "n".repeat(65) })).toMatch(/name is too long/);
    expect(anonLaunchTooLong({ ...launch, imageURI: "i".repeat(513) })).toMatch(/image link is too long/);
    expect(anonLaunchTooLong({ ...launch, socialsURI: "s".repeat(501) })).toMatch(/socials is too long/);
    // bytes, not characters: 3-byte characters count three times
    expect(anonLaunchTooLong({ ...launch, ticker: "€".repeat(6) })).toMatch(/ticker is too long/);
  });
});
