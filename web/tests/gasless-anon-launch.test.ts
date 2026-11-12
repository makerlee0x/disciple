/** Private launch: Permit2 witness, request rules, GaslessForwarder calldata, leftover refundTo. */
import { describe, expect, it } from "vitest";
import { decodeFunctionData, hashTypedData, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { GaslessReject, jsonSafe } from "../lib/trade/gaslessPermit2";
import {
  ANON_LAUNCH_TX_GAS_LIMIT, anonLaunchTypedData, anonLaunchWitnessHash,
  checkGaslessAnonLaunchRequest, encodeAnonLaunchCall, parseGaslessAnonLaunchRequest, permitAmount,
  type AnonLaunch, type GaslessAnonLaunchRequest,
} from "../lib/trade/gaslessAnonLaunch";
import { gaslessForwarderAbi } from "../lib/trade/gaslessForwarder";
import { GASLESS_GAS_LIMIT } from "../lib/trade/gaslessPermit2";

const usdg = "0x9dC7A988a8707dC4AB7ac08fC2CB4D5bf906158D" as Address;
const launcher = "0x73a2a6e049aa21A5C440F3bc358dE37FE3f7C509" as Address;
const quote = "0x1111111111111111111111111111111111111111" as Address;
const stealth = "0x2222222222222222222222222222222222222222" as Address;
const fwd = "0x111111111111111111111111111111111111F0D1" as Address;
const NOW = 1_000_000;
const user = privateKeyToAccount(generatePrivateKey());

function launch(over: Partial<AnonLaunch> = {}): AnonLaunch {
  return {
    name: "Anon", ticker: "ANON", imageURI: "ipfs://x", description: "", socialsURI: "",
    quote, creatorTaxBps: 0n, creatorBuyQuoteIn: 0n, creatorBuyMinTokensOut: 1n,
    deadline: BigInt(NOW + 240), stealthOwner: stealth, buyRecipient: stealth,
    ephemeralPubKey: "0x", viewTag: "0x00", maxFee: 500_000n, usdgIn: 10_000_000n, minQuoteIn: 1n,
    refundTo: user.address, launcher, ...over,
  };
}

async function signed(over: Partial<AnonLaunch> = {}, approval?: GaslessAnonLaunchRequest["approval"]): Promise<GaslessAnonLaunchRequest> {
  const l = launch(over);
  const permit = { permitted: { token: usdg, amount: permitAmount(l) }, nonce: 1n, deadline: BigInt(NOW + 240) };
  const signature = await user.signTypedData(jsonSafe(anonLaunchTypedData(46630, permit, l, fwd)));
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
    const who = await recoverTypedDataAddress({ ...anonLaunchTypedData(46630, q.permit, q.launch, fwd), signature: q.signature });
    expect(who.toLowerCase()).toBe(user.address.toLowerCase());
    const digest = hashTypedData(anonLaunchTypedData(46630, q.permit, q.launch, fwd));
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(anonLaunchWitnessHash(q.launch)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("recovers a different address if any launch field or the refund recipient changes", async () => {
    const q = await signed();
    const tweaked = await recoverTypedDataAddress({ ...anonLaunchTypedData(46630, q.permit, { ...q.launch, usdgIn: q.launch.usdgIn + 1n }, fwd), signature: q.signature });
    expect(tweaked.toLowerCase()).not.toBe(user.address.toLowerCase());
    const other = await recoverTypedDataAddress({ ...anonLaunchTypedData(46630, q.permit, { ...q.launch, refundTo: stealth }, fwd), signature: q.signature });
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

describe("anon launch GaslessForwarder calldata", () => {
  it("encodes GaslessForwarder.launchAnon with the signed refundTo and the forwarder as Permit2 spender", async () => {
    const q = await signed();
    const data = encodeAnonLaunchCall(q, fwd);
    const decoded = decodeFunctionData({ abi: gaslessForwarderAbi, data });
    expect(decoded.functionName).toBe("launchAnon");
    const args = decoded.args as unknown as readonly unknown[];
    expect((args[0] as Address).toLowerCase()).toBe(user.address.toLowerCase());
    expect((args[2] as { refundTo: Address; usdgIn: bigint; maxFee: bigint; stealthOwner: Address }).refundTo.toLowerCase()).toBe(user.address.toLowerCase());
    expect((args[2] as { usdgIn: bigint }).usdgIn).toBe(q.launch.usdgIn);
    expect((args[2] as { maxFee: bigint }).maxFee).toBe(q.launch.maxFee);
    expect((args[2] as { stealthOwner: Address }).stealthOwner.toLowerCase()).toBe(stealth.toLowerCase());
    expect(anonLaunchWitnessHash(q.launch)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(anonLaunchTypedData(46630, q.permit, q.launch, fwd).message.spender.toLowerCase()).toBe(fwd.toLowerCase());
  });

  it("bundles a one-time EIP-2612 permit in the same launchAnon call", async () => {
    const approval = { value: 2n ** 256n - 1n, deadline: BigInt(NOW + 240), v: 27, r: ("0x" + "11".repeat(32)) as Hex, s: ("0x" + "22".repeat(32)) as Hex };
    const q = await signed({}, approval);
    const decoded = decodeFunctionData({ abi: gaslessForwarderAbi, data: encodeAnonLaunchCall(q, fwd) });
    const a = decoded.args[4] as { value: bigint; v: number };
    expect(a.value).toBe(2n ** 256n - 1n);
    expect(a.v).toBe(27);
  });

  it("matches the on-chain AnonLaunch witness hash", () => {
    const l = {
      name: "Anon", ticker: "ANON", imageURI: "ipfs://x", description: "d", socialsURI: "s",
      quote: "0x1111111111111111111111111111111111111111" as Address,
      creatorTaxBps: 0n, creatorBuyQuoteIn: 0n, creatorBuyMinTokensOut: 1n, deadline: 1000n,
      stealthOwner: "0x2222222222222222222222222222222222222222" as Address,
      buyRecipient: "0x3333333333333333333333333333333333333333" as Address,
      ephemeralPubKey: "0xabcd" as Hex, viewTag: "0x07" as Hex,
      maxFee: 500000n, usdgIn: 10000000n, minQuoteIn: 1n,
      refundTo: "0x4444444444444444444444444444444444444444" as Address,
      launcher: "0x5555555555555555555555555555555555555555" as Address,
    };
    expect(anonLaunchWitnessHash(l)).toBe("0xb39ca315179d97e94ecc2bb9e6743423ae8fa489745006d311f29a5f78be47f8");
  });
});
