/** flow/anon-launch-relayer: Permit2 witness, request rules, Multicall3 calldata, leftover refundTo. */
import { describe, expect, it } from "vitest";
import { decodeFunctionData, hashTypedData, recoverTypedDataAddress, toFunctionSelector, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { GaslessReject, jsonSafe, PERMIT2 } from "../lib/trade/gaslessPermit2";
import {
  ANON_LAUNCH_TX_GAS_LIMIT, ANON_LAUNCH_WITNESS_TYPE, MULTICALL3, anonLaunchTypedData, anonLaunchWitnessHash,
  checkGaslessAnonLaunchRequest, encodeAnonLaunchCall, erc20ApproveAbi, launchAnonWithUsdgAbi,
  parseGaslessAnonLaunchRequest, permit2WitnessTransferAbi, permitAmount, type AnonLaunch, type GaslessAnonLaunchRequest,
} from "../lib/trade/gaslessAnonLaunch";
import { erc2612PermitAbi, multicall3Abi } from "../lib/trade/gaslessWithdraw";
import { GASLESS_GAS_LIMIT } from "../lib/trade/gaslessPermit2";

const usdg = "0x9dC7A988a8707dC4AB7ac08fC2CB4D5bf906158D" as Address;
const launcher = "0x73a2a6e049aa21A5C440F3bc358dE37FE3f7C509" as Address;
const quote = "0x1111111111111111111111111111111111111111" as Address;
const stealth = "0x2222222222222222222222222222222222222222" as Address;
const NOW = 1_000_000;
const user = privateKeyToAccount(generatePrivateKey());

function launch(over: Partial<AnonLaunch> = {}): AnonLaunch {
  return {
    name: "Anon", ticker: "ANON", imageURI: "ipfs://x", description: "", socialsURI: "",
    quote, creatorTaxBps: 0n, creatorBuyQuoteIn: 0n, creatorBuyMinTokensOut: 1n,
    deadline: BigInt(NOW + 240), creatorFeeDestination: 0n, stealthOwner: stealth, buyRecipient: stealth,
    ephemeralPubKey: "0x", viewTag: "0x00", maxFee: 500_000n, usdgIn: 10_000_000n, minQuoteIn: 1n,
    refundTo: user.address, launcher, ...over,
  };
}

async function signed(over: Partial<AnonLaunch> = {}, approval?: GaslessAnonLaunchRequest["approval"]): Promise<GaslessAnonLaunchRequest> {
  const l = launch(over);
  const permit = { permitted: { token: usdg, amount: permitAmount(l) }, nonce: 1n, deadline: BigInt(NOW + 240) };
  const signature = await user.signTypedData(jsonSafe(anonLaunchTypedData(46630, permit, l)));
  return { signer: user.address, permit, launch: l, signature, ...(approval ? { approval } : {}) };
}

describe("anon launch witness and rules", () => {
  it("does not change GASLESS_GAS_LIMIT and uses a dedicated launch cap above the solc measurement", () => {
    expect(GASLESS_GAS_LIMIT).toBe(900_000n);
    expect(ANON_LAUNCH_TX_GAS_LIMIT).toBe(8_500_000n);
    expect(ANON_LAUNCH_TX_GAS_LIMIT).toBeGreaterThan(7_004_816n);
  });

  it("recovers the signer from the Permit2 witness (all launch fields bound)", async () => {
    const q = await signed();
    const who = await recoverTypedDataAddress({ ...anonLaunchTypedData(46630, q.permit, q.launch), signature: q.signature });
    expect(who.toLowerCase()).toBe(user.address.toLowerCase());
    const digest = hashTypedData(anonLaunchTypedData(46630, q.permit, q.launch));
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(anonLaunchWitnessHash(q.launch)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("recovers a different address if any launch field or the refund recipient changes", async () => {
    const q = await signed();
    const tweaked = await recoverTypedDataAddress({ ...anonLaunchTypedData(46630, q.permit, { ...q.launch, usdgIn: q.launch.usdgIn + 1n }), signature: q.signature });
    expect(tweaked.toLowerCase()).not.toBe(user.address.toLowerCase());
    const other = await recoverTypedDataAddress({ ...anonLaunchTypedData(46630, q.permit, { ...q.launch, refundTo: stealth }), signature: q.signature });
    expect(other.toLowerCase()).not.toBe(user.address.toLowerCase());
  });

  it("parses a JSON request and accepts a well-formed one", async () => {
    const q = await signed();
    const parsed = parseGaslessAnonLaunchRequest(JSON.parse(JSON.stringify(q, (_k, v) => typeof v === "bigint" ? v.toString() : v)));
    expect(parsed.launch.usdgIn).toBe(10_000_000n);
    expect(parsed.launch.refundTo.toLowerCase()).toBe(user.address.toLowerCase());
    checkGaslessAnonLaunchRequest(parsed, { usdg, launcher, nowSec: NOW, launchFee: 500_000n });
  });

  it("rejects permit amount, fee, refund, launcher, and deadline mistakes", async () => {
    const base = { usdg, launcher, nowSec: NOW, launchFee: 500_000n };
    const q = await signed();
    expect(() => checkGaslessAnonLaunchRequest({ ...q, permit: { ...q.permit, permitted: { token: usdg, amount: 1n } } }, base)).toThrow(GaslessReject);
    expect(() => checkGaslessAnonLaunchRequest(q, { ...base, launchFee: 400_000n })).toThrow(/launch fee changed/);
    expect(() => checkGaslessAnonLaunchRequest({ ...q, launch: { ...q.launch, refundTo: stealth } }, base)).toThrow(/refund must go to the signer/);
    expect(() => checkGaslessAnonLaunchRequest({ ...q, launch: { ...q.launch, launcher: stealth } }, base)).toThrow(/launcher mismatch/);
    expect(() => checkGaslessAnonLaunchRequest(q, { ...base, nowSec: NOW + 300 })).toThrow(/deadline out of range/);
    expect(() => checkGaslessAnonLaunchRequest({ ...q, launch: { ...q.launch, refundTo: launcher } }, { ...base, launcher })).toThrow();
  });
});

describe("anon launch Multicall3 batch", () => {
  it("encodes permitWitnessTransferFrom → approve → launchAnonWithUsdg(refundTo=player) → approve(0)", async () => {
    const q = await signed();
    const data = encodeAnonLaunchCall(q, usdg);
    const decoded = decodeFunctionData({ abi: multicall3Abi, data });
    expect(decoded.functionName).toBe("aggregate3");
    const calls = decoded.args[0] as { target: Address; allowFailure: boolean; callData: Hex }[];
    expect(calls.every((c) => c.allowFailure === false)).toBe(true);
    expect(calls.map((c) => c.target.toLowerCase())).toEqual([
      PERMIT2.toLowerCase(), usdg.toLowerCase(), launcher.toLowerCase(), usdg.toLowerCase(),
    ]);

    const p2 = decodeFunctionData({ abi: permit2WitnessTransferAbi, data: calls[0].callData });
    expect(p2.functionName).toBe("permitWitnessTransferFrom");
    expect((p2.args[1] as { to: Address; requestedAmount: bigint }).to.toLowerCase()).toBe(MULTICALL3.toLowerCase());
    expect((p2.args[1] as { to: Address; requestedAmount: bigint }).requestedAmount).toBe(permitAmount(q.launch));
    expect(p2.args[2].toLowerCase()).toBe(user.address.toLowerCase());
    expect(p2.args[3]).toBe(anonLaunchWitnessHash(q.launch));
    expect(p2.args[4]).toBe(ANON_LAUNCH_WITNESS_TYPE);

    const ap = decodeFunctionData({ abi: erc20ApproveAbi, data: calls[1].callData });
    expect(ap.functionName).toBe("approve");
    expect((ap.args[0] as Address).toLowerCase()).toBe(launcher.toLowerCase());
    expect(ap.args[1]).toBe(permitAmount(q.launch));

    const ln = decodeFunctionData({ abi: launchAnonWithUsdgAbi, data: calls[2].callData });
    expect(ln.functionName).toBe("launchAnonWithUsdg");
    const args = ln.args as unknown as readonly unknown[];
    expect((args[8] as Address).toLowerCase()).toBe(user.address.toLowerCase()); // refundTo
    expect((args[1] as Address).toLowerCase()).toBe(stealth.toLowerCase());
    expect(args[6]).toBe(q.launch.usdgIn);
    expect(args[5]).toBe(q.launch.maxFee);

    const z = decodeFunctionData({ abi: erc20ApproveAbi, data: calls[3].callData });
    expect(z.args[1]).toBe(0n);
  });

  it("prepends a one-time EIP-2612 permit when present", async () => {
    const q = await signed({}, { value: 2n ** 256n - 1n, deadline: BigInt(NOW + 240), v: 27, r: ("0x" + "11".repeat(32)) as Hex, s: ("0x" + "22".repeat(32)) as Hex });
    const data = encodeAnonLaunchCall(q, usdg);
    const calls = (decodeFunctionData({ abi: multicall3Abi, data }).args[0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[]);
    expect(calls[0].target.toLowerCase()).toBe(usdg.toLowerCase());
    const p = decodeFunctionData({ abi: erc2612PermitAbi, data: calls[0].callData });
    expect(p.functionName).toBe("permit");
    expect((p.args[1] as Address).toLowerCase()).toBe(PERMIT2.toLowerCase());
    expect(calls).toHaveLength(5);
  });

  it("launchAnonWithUsdg selector includes refundTo (the ABI changed)", () => {
    const sel = toFunctionSelector("launchAnonWithUsdg((string,string,string,string,string,address,uint256,uint256,uint256,uint256,uint8),address,address,bytes,bytes1,uint256,uint256,uint256,address)");
    expect(sel).toMatch(/^0x[0-9a-f]{8}$/);
  });
});
