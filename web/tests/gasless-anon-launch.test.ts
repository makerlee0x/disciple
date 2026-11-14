/** flow/anon-launch-relayer: Permit2 witness (spender GaslessForwarder), request rules, forwarder calldata. */
import { describe, expect, it } from "vitest";
import { decodeFunctionData, hashTypedData, recoverTypedDataAddress, toFunctionSelector, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { GaslessReject, jsonSafe, PERMIT2 } from "../lib/trade/gaslessPermit2";
import {
  ANON_LAUNCH_TX_GAS_LIMIT, ANON_LAUNCH_WITNESS_TYPE, anonLaunchTypedData, anonLaunchWitnessHash,
  checkGaslessAnonLaunchRequest, encodeAnonLaunchCall,
  parseGaslessAnonLaunchRequest, permitAmount, type AnonLaunch, type GaslessAnonLaunchRequest,
} from "../lib/trade/gaslessAnonLaunch";
import { erc2612PermitAbi, multicall3Abi } from "../lib/trade/gaslessWithdraw";
import { GASLESS_GAS_LIMIT } from "../lib/trade/gaslessPermit2";
import { forwarderAbi } from "../lib/trade/gaslessForwarder";

const usdg = "0x9dC7A988a8707dC4AB7ac08fC2CB4D5bf906158D" as Address;
const launcher = "0x526784706e5ef369412abe65213ed65256182c6b" as Address; // v6 AnonLauncher
const quote = "0x1111111111111111111111111111111111111111" as Address;
const harvest = "0x4e94a3e9900b435b7c91d0a7cd53a22c8a9f8a03" as Address; // CreatorFeeHarvest
const stealth = "0x2222222222222222222222222222222222222222" as Address;
const NOW = 1_000_000;
const FWD = "0x00000000000000000000000000000000000000F0" as Address;
const user = privateKeyToAccount(generatePrivateKey());

function launch(over: Partial<AnonLaunch> = {}): AnonLaunch {
  return {
    name: "Anon", ticker: "ANON", imageURI: "ipfs://x", description: "", socialsURI: "",
    quote, creatorTaxBps: 0n, creatorBuyQuoteIn: 0n, creatorBuyMinTokensOut: 1n,
    deadline: BigInt(NOW + 240), stealthOwner: stealth, buyRecipient: stealth,
    ephemeralPubKey: "0x", viewTag: "0x00", maxFee: 500_000n, usdgIn: 10_000_000n, minQuoteIn: 1n,
    refundTo: user.address, launcher, creatorFeeDestination: 0, ...over,
  };
}

async function signed(over: Partial<AnonLaunch> = {}, approval?: GaslessAnonLaunchRequest["approval"]): Promise<GaslessAnonLaunchRequest> {
  const l = launch(over);
  const permit = { permitted: { token: usdg, amount: permitAmount(l) }, nonce: 1n, deadline: BigInt(NOW + 240) };
  const signature = await user.signTypedData(jsonSafe(anonLaunchTypedData(46630, FWD, permit, l)));
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
    const who = await recoverTypedDataAddress({ ...anonLaunchTypedData(46630, FWD, q.permit, q.launch), signature: q.signature });
    expect(who.toLowerCase()).toBe(user.address.toLowerCase());
    const digest = hashTypedData(anonLaunchTypedData(46630, FWD, q.permit, q.launch));
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(anonLaunchWitnessHash(q.launch)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("recovers a different address if any launch field or the refund recipient changes", async () => {
    const q = await signed();
    const tweaked = await recoverTypedDataAddress({ ...anonLaunchTypedData(46630, FWD, q.permit, { ...q.launch, usdgIn: q.launch.usdgIn + 1n }), signature: q.signature });
    expect(tweaked.toLowerCase()).not.toBe(user.address.toLowerCase());
    const other = await recoverTypedDataAddress({ ...anonLaunchTypedData(46630, FWD, q.permit, { ...q.launch, refundTo: stealth }), signature: q.signature });
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

type FwdLaunch = { p: { name: string }; stealthOwner: Address; usdgIn: bigint; maxFee: bigint; refundTo: Address; launcher: Address; creatorFeeDestination: number };
function decodeLaunch(data: Hex) {
  const calls = decodeFunctionData({ abi: multicall3Abi, data }).args[0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[];
  const last = calls[calls.length - 1];
  const f = decodeFunctionData({ abi: forwarderAbi, data: last.callData });
  const [permit, owner, l, sig] = f.args as unknown as [{ permitted: { amount: bigint } }, Address, FwdLaunch, Hex];
  return { calls, last, fn: f.functionName, permit, owner, l, sig };
}

describe("anon launch batch (Multicall3 → forwarder.launchAnon)", () => {
  it("encodes one forwarder.launchAnon with the signed launch, permit and signature; Multicall3 never calls Permit2", async () => {
    const q = await signed();
    const d = decodeLaunch(encodeAnonLaunchCall(q, usdg, FWD));
    expect(d.calls).toHaveLength(1);
    expect(d.last.target.toLowerCase()).toBe(FWD.toLowerCase());
    expect(d.last.allowFailure).toBe(false);
    expect(d.fn).toBe("launchAnon");
    expect(d.permit.permitted.amount).toBe(permitAmount(q.launch));
    expect(d.owner.toLowerCase()).toBe(user.address.toLowerCase());
    expect(d.sig).toBe(q.signature);
    expect(d.l.refundTo.toLowerCase()).toBe(user.address.toLowerCase());
    expect(d.l.stealthOwner.toLowerCase()).toBe(stealth.toLowerCase());
    expect(d.l.launcher.toLowerCase()).toBe(launcher.toLowerCase());
    expect(d.l.usdgIn).toBe(q.launch.usdgIn);
    expect(d.l.maxFee).toBe(q.launch.maxFee);
    expect(d.l.p.name).toBe("Anon");
    expect(d.calls.some((c) => c.target.toLowerCase() === PERMIT2.toLowerCase())).toBe(false);
  });

  it("prepends a one-time EIP-2612 permit when present (allowed to fail if already applied)", async () => {
    const q = await signed({}, { value: 2n ** 256n - 1n, deadline: BigInt(NOW + 240), v: 27, r: ("0x" + "11".repeat(32)) as Hex, s: ("0x" + "22".repeat(32)) as Hex });
    const { calls } = decodeLaunch(encodeAnonLaunchCall(q, usdg, FWD));
    expect(calls[0].target.toLowerCase()).toBe(usdg.toLowerCase());
    expect(calls[0].allowFailure).toBe(true);
    const p = decodeFunctionData({ abi: erc2612PermitAbi, data: calls[0].callData });
    expect(p.functionName).toBe("permit");
    expect((p.args[1] as Address).toLowerCase()).toBe(PERMIT2.toLowerCase());
    expect(calls).toHaveLength(2);
  });

  it("witness type lists AnonLaunch before TokenPermissions (EIP-712 order) and matches viem's digest", async () => {
    expect(ANON_LAUNCH_WITNESS_TYPE.indexOf("AnonLaunch(")).toBeLessThan(ANON_LAUNCH_WITNESS_TYPE.indexOf("TokenPermissions("));
  });

  it("launchAnonWithUsdg selector includes refundTo (the ABI changed)", () => {
    const sel = toFunctionSelector("launchAnonWithUsdg((string,string,string,string,string,address,uint256,uint256,uint256,uint256),address,address,bytes,bytes1,uint256,uint256,uint256,address)");
    expect(sel).toMatch(/^0x[0-9a-f]{8}$/);
  });
});

describe("private launch with creator fees sent to the pool or the burn", () => {
  it("binds the destination in the signed witness, so the relayer cannot change it", async () => {
    const q = await signed({ launcher: harvest, creatorFeeDestination: 2 });
    const who = await recoverTypedDataAddress({ ...anonLaunchTypedData(46630, FWD, q.permit, q.launch), signature: q.signature });
    expect(who.toLowerCase()).toBe(user.address.toLowerCase());
    for (const d of [0, 1]) {
      const other = await recoverTypedDataAddress({ ...anonLaunchTypedData(46630, FWD, q.permit, { ...q.launch, creatorFeeDestination: d }), signature: q.signature });
      expect(other.toLowerCase()).not.toBe(user.address.toLowerCase());
    }
    expect(ANON_LAUNCH_WITNESS_TYPE).toContain("address launcher,uint8 creatorFeeDestination)");
  });

  it("passes the harvest launcher and the destination through to the forwarder", async () => {
    const q = await signed({ launcher: harvest, creatorFeeDestination: 1 });
    const d = decodeLaunch(encodeAnonLaunchCall(q, usdg, FWD));
    expect(d.l.launcher.toLowerCase()).toBe(harvest.toLowerCase());
    expect(d.l.creatorFeeDestination).toBe(1);
    expect(d.l.refundTo.toLowerCase()).toBe(user.address.toLowerCase());
  });

  it("server rules: keep must use AnonLauncher, pool/burn must use the harvest, and only when it is enabled", async () => {
    const base = { usdg, launcher, nowSec: NOW, launchFee: 500_000n };
    const routed = await signed({ launcher: harvest, creatorFeeDestination: 2 });
    expect(() => checkGaslessAnonLaunchRequest(routed, base)).toThrow(/isn't available yet/);
    expect(() => checkGaslessAnonLaunchRequest(routed, { ...base, harvest: "0x0000000000000000000000000000000000000000" })).toThrow(/isn't available yet/);
    checkGaslessAnonLaunchRequest(routed, { ...base, harvest });
    const wrong = await signed({ launcher, creatorFeeDestination: 1 });
    expect(() => checkGaslessAnonLaunchRequest(wrong, { ...base, harvest })).toThrow(/launcher mismatch/);
    const keepAtHarvest = await signed({ launcher: harvest, creatorFeeDestination: 0 });
    expect(() => checkGaslessAnonLaunchRequest(keepAtHarvest, { ...base, harvest })).toThrow(/launcher mismatch/);
  });

  it("parses the destination (missing = keep) and rejects anything other than 0, 1 or 2", async () => {
    const q = await signed();
    const json = JSON.parse(JSON.stringify(q, (_k, v) => typeof v === "bigint" ? v.toString() : v));
    delete json.launch.creatorFeeDestination;
    expect(parseGaslessAnonLaunchRequest(json).launch.creatorFeeDestination).toBe(0);
    json.launch.creatorFeeDestination = "2";
    expect(parseGaslessAnonLaunchRequest(json).launch.creatorFeeDestination).toBe(2);
    json.launch.creatorFeeDestination = 3;
    expect(() => parseGaslessAnonLaunchRequest(json)).toThrow(/creatorFeeDestination/);
  });
});
