/**
 * GaslessForwarder (contracts/src/addons/GaslessForwarder.sol) ⇄ app parity. Permit2 hashes
 * "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline," + witnessTypeString
 * itself; wallets (viem signTypedData) hash the EIP-712 encodeType with referenced types sorted. If the two differ, every
 * signature fails on-chain, so each witness type string is checked against viem's digest here. The vectors also appear
 * in contracts/test/addons/GaslessForwarder.t.sol.
 */
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, getAddress, hashTypedData, keccak256, toBytes, type Address, type Hex } from "viem";
import { PERMIT2, type Permit } from "../lib/trade/gaslessPermit2";
import {
  ACTION_FEE_WITNESS_TYPE, WITHDRAW_WITNESS_TYPE, actionFeeTypedData, hashCalls, requireForwarder, withdrawTypedData,
} from "../lib/trade/gaslessForwarder";
import { ANON_LAUNCH_WITNESS_TYPE, anonLaunchTypedData, anonLaunchWitnessHash, type AnonLaunch } from "../lib/trade/gaslessAnonLaunch";

const FWD = getAddress("0x00000000000000000000000000000000000000f0");
const token = getAddress("0x9dC7A988a8707dC4AB7ac08fC2CB4D5bf906158D");
const permit: Permit = { permitted: { token, amount: 1_005_000n }, nonce: 7n, deadline: 1_800_000_000n };
const k = (s: string) => keccak256(toBytes(s));

/** What Permit2.permitWitnessTransferFrom hashes on-chain for this witness type string + witness hash. */
function permit2Digest(chainId: number, spender: Address, p: Permit, witnessType: string, witness: Hex): Hex {
  const domain = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [k("EIP712Domain(string name,uint256 chainId,address verifyingContract)"), k("Permit2"), BigInt(chainId), PERMIT2]));
  const typeHash = k(`PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,${witnessType}`);
  const tp = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
    [k("TokenPermissions(address token,uint256 amount)"), p.permitted.token, p.permitted.amount]));
  const struct = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
    [typeHash, tp, spender, p.nonce, p.deadline, witness]));
  return keccak256(`0x1901${domain.slice(2)}${struct.slice(2)}`);
}

describe("witness type strings match what wallets sign (Permit2 on-chain digest == viem digest)", () => {
  it("Withdraw", () => {
    const w = { to: getAddress("0x00000000000000000000000000000000000000dd"), amount: 1_000_000n, fee: 5_000n, feeTo: getAddress("0x00000000000000000000000000000000000000ee") };
    const witness = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }],
      [k("Withdraw(address to,uint256 amount,uint256 fee,address feeTo)"), w.to, w.amount, w.fee, w.feeTo]));
    expect(hashTypedData(withdrawTypedData(46630, FWD, permit, w))).toBe(permit2Digest(46630, FWD, permit, WITHDRAW_WITNESS_TYPE, witness));
  });

  it("ActionFee", () => {
    const f = { fee: 5_000n, feeTo: getAddress("0x00000000000000000000000000000000000000ee"), callsHash: k("calls") };
    const witness = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }],
      [k("ActionFee(uint256 fee,address feeTo,bytes32 callsHash)"), f.fee, f.feeTo, f.callsHash]));
    const p = { ...permit, permitted: { token, amount: 5_000n } };
    expect(hashTypedData(actionFeeTypedData(46630, FWD, p, f))).toBe(permit2Digest(46630, FWD, p, ACTION_FEE_WITNESS_TYPE, witness));
  });

  it("AnonLaunch (and its witness hash equals the Solidity vector)", () => {
    const l: AnonLaunch = {
      name: "Halo Runner", ticker: "HALO", imageURI: "ipfs://img", description: "to the moon", socialsURI: "",
      quote: "0x1111111111111111111111111111111111111111", creatorTaxBps: 100n, creatorBuyQuoteIn: 10_000_000n, creatorBuyMinTokensOut: 1n,
      deadline: 1_800_000_000n, stealthOwner: "0x2222222222222222222222222222222222222222", buyRecipient: "0x3333333333333333333333333333333333333333",
      ephemeralPubKey: "0x02aabbcc", viewTag: "0x5a", maxFee: 5_000_000n, usdgIn: 10_000_000n, minQuoteIn: 1n,
      refundTo: "0x4444444444444444444444444444444444444444", launcher: "0x5555555555555555555555555555555555555555", creatorFeeDestination: 1,
    };
    const witness = anonLaunchWitnessHash(l);
    expect(witness).toBe("0xc2b015644abfc80c1f8e371463b2a85316074d72eb8b710ac8f9f8e44a4da7b2"); // GaslessForwarder.t.sol test_anon_witnessVector
    const p = { ...permit, permitted: { token, amount: 15_000_000n } };
    expect(hashTypedData(anonLaunchTypedData(46630, FWD, p, l))).toBe(permit2Digest(46630, FWD, p, ANON_LAUNCH_WITNESS_TYPE, witness));
  });
});

describe("calls hash + the mainnet lock", () => {
  it("hashCalls = keccak256(abi.encode(Call[])) (Solidity vector)", () => {
    const h = hashCalls([{ to: "0x6666666666666666666666666666666666666666", data: "0xdeadbeef" }, { to: "0x7777777777777777777777777777777777777777", data: "0x" }]);
    expect(h).toBe(CALLS_VECTOR);
  });
  it("no forwarder configured ⇒ the relays refuse (no fallback to a public spender)", () => {
    expect(() => requireForwarder({ gaslessForwarder: "0x0000000000000000000000000000000000000000" })).toThrow(/aren't available on this chain yet/);
    expect(requireForwarder({ gaslessForwarder: FWD })).toBe(FWD);
  });
});

const CALLS_VECTOR = "0x07802ca57152fb6f0eee85843f0cf19f36dc4973e7086db14ab50fad49fd57d0";
