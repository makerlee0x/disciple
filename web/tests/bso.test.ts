import { afterEach, describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { BSO_ZERO, browserBso, bsoUnsigned, checkBso, bsoGasBounds } from "../lib/aa/bso";
import { bsoPolicyId, checkSessionManagement, checkSponsoredCalls } from "../lib/server/gasSponsorship";
import { buildCreateSession, buildUninstallSession, TRADE_PERMS } from "@disciple/session-keys";
import { getDefaultSingleSignerValidationModuleAddress, getDefaultTimeRangeModuleAddress } from "@account-kit/smart-contracts/experimental";
import { ANON_ADDONS } from "../lib/anon";
import { DEPLOYMENTS, robinhoodTestnet } from "../lib/chains";
import type { GradReads } from "../lib/server/gradBuy";
const d = DEPLOYMENTS[46630];
const sender = "0x1111111111111111111111111111111111111111" as Address;
const coin = "0x2222222222222222222222222222222222222222" as Address;
const curve = "0x3333333333333333333333333333333333333333" as Address;
const policy = "0xD2cF85dd7cDC3c3e53EA0472BF6Bf006de45E4d2" as Address;
const now = 1_800_000_000;
const abi = parseAbi(["function approve(address,uint256)", "function transfer(address,uint256)", "function buyWithUsdg(address,uint256,uint256,uint256)", "function sellToUsdg(address,uint256,uint256,uint256)", "function buyExactIn(address,uint256,uint256,address,uint256)", "function buy(uint256,uint256,uint256,address)", "function executeBatch((address target,uint256 value,bytes data)[])"]);
type C = { target: Address; value: bigint; data: Hex };
const batch = (calls: C[]) => encodeFunctionData({ abi, functionName: "executeBatch", args: [calls] });
const approve = (token = d.usdg, spender = d.router, amount = 100n): C => ({ target: token, value: 0n, data: encodeFunctionData({ abi, functionName: "approve", args: [spender, amount] }) });
const buy = (): C => ({ target: d.router, value: 0n, data: encodeFunctionData({ abi, functionName: "buyWithUsdg", args: [coin, 100n, 1n, BigInt(now + 60)] }) });
const reads: GradReads = { router: d.router, usdg: d.usdg, curveOf: async () => curve, curveInfo: async () => ({ token: coin, quote: d.usdg, graduated: false }), check: async () => { throw Error("unused"); } };
const modules = { policy, singleSigner: getDefaultSingleSignerValidationModuleAddress(robinhoodTestnet), timeRange: getDefaultTimeRangeModuleAddress(robinhoodTestnet) };
const setup = (permissions = TRADE_PERMS) => buildCreateSession({ modules, targets: { router: d.router, launchpad: d.launchpad, trampWallManager: d.trampWallManager, anonLauncher: ANON_ADDONS[46630].anonLauncher }, sessionSigner: sender, caps: [{ token: d.defaultQuote, cap: 1000n }, { token: d.usdg, cap: 1000n }], entityId: 7, now, ttlSec: 120, permissions });
afterEach(() => { delete process.env.GAS_SPONSORSHIP_MODE; delete process.env.ALCHEMY_BSO_POLICY_ID; delete process.env.NEXT_PUBLIC_GAS_SPONSORSHIP_MODE; delete process.env.NEXT_PUBLIC_VERCEL_ENV; delete process.env.VERCEL_ENV; delete process.env.NEXT_PUBLIC_SESSION_POLICY; });
describe("default-off BSO shape", () => {
  it("opts in only on testnet, never Production", () => {
    expect(browserBso(46630)).toBe(false); expect(bsoPolicyId()).toBeUndefined();
    process.env.NEXT_PUBLIC_GAS_SPONSORSHIP_MODE = "bso";
    expect(browserBso(46630)).toBe(true); expect(browserBso(4663)).toBe(false);
    process.env.NEXT_PUBLIC_VERCEL_ENV = "production"; expect(browserBso(46630)).toBe(false);
    process.env.GAS_SPONSORSHIP_MODE = "bso"; expect(() => bsoPolicyId()).toThrow();
    process.env.ALCHEMY_BSO_POLICY_ID = "d38ec347-5eb0-498f-ba1a-842ea308c332"; expect(bsoPolicyId()).toBe(process.env.ALCHEMY_BSO_POLICY_ID);
    process.env.VERCEL_ENV = "production"; expect(() => bsoPolicyId()).toThrow();
  });
  it("strips stale PM fields and zeros before signing without mutating original", () => {
    const old = { paymaster: coin, paymasterData: "0x1234", paymasterAndData: "0x", paymasterVerificationGasLimit: 5n, paymasterPostOpGasLimit: 5n, maxFeePerGas: 7n, callGasLimit: 10n, verificationGasLimit: 20n };
    const clean = bsoUnsigned(old); expect(old.maxFeePerGas).toBe(7n); expect(clean).toMatchObject(BSO_ZERO); expect(() => checkBso(clean)).not.toThrow();
    for (const k of ["paymaster", "paymasterData", "paymasterAndData", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit"]) expect(clean).not.toHaveProperty(k);
  });
  it("sizes both limits from measured gas at 1.3x, not the old 1M/5M seed", () => {
    const gas = bsoGasBounds({ callGasLimit: 500_000n, verificationGasLimit: 131_910n });
    expect(gas).toEqual({ callGasLimit: 650_000n, verificationGasLimit: 171_483n });
    expect(Number(131_910n * 10_000n / gas.verificationGasLimit) / 10_000).toBeGreaterThanOrEqual(0.4);
    expect(() => bsoGasBounds({ callGasLimit: 0n, verificationGasLimit: 0n })).toThrow();
    const estimate = { ...BSO_ZERO, callGasLimit: 0n, verificationGasLimit: 0n };
    expect(() => checkBso(estimate, true)).not.toThrow();
    expect(() => checkBso(estimate)).toThrow();
  });
  it("rejects PM, nonzero fee/PVG and excessive gas", () => {
    const good = { ...BSO_ZERO, callGasLimit: "0x100", verificationGasLimit: "0x100" };
    for (const k of Object.keys(BSO_ZERO)) expect(() => checkBso({ ...good, [k]: 1n })).toThrow();
    expect(() => checkBso({ ...good, paymasterData: "0x" })).toThrow();
    expect(() => checkBso({ ...good, callGasLimit: 5000001n })).toThrow();
  });
});
describe("canonical sponsor admission", () => {
  it("accepts exact router buy and executeUserOp-prefixed batch", async () => {
    const cd = batch([approve(), buy()]);
    await expect(checkSponsoredCalls(cd, sender, reads, now)).resolves.toBeUndefined();
    await expect(checkSponsoredCalls(`0x8dd7712f${cd.slice(2)}`, sender, reads, now)).resolves.toBeUndefined();
  });
  it("accepts sell and registry-verified direct curve trade", async () => {
    const sell: C = { target: d.router, value: 0n, data: encodeFunctionData({ abi, functionName: "sellToUsdg", args: [coin, 100n, 1n, BigInt(now + 60)] }) };
    await expect(checkSponsoredCalls(batch([approve(coin), sell]), sender, reads, now)).resolves.toBeUndefined();
    const cb: C = { target: curve, value: 0n, data: encodeFunctionData({ abi, functionName: "buy", args: [100n, 1n, BigInt(now + 60), sender] }) };
    await expect(checkSponsoredCalls(batch([approve(d.usdg, curve), cb]), sender, reads, now)).resolves.toBeUndefined();
  });
  it("rejects unregistered curves and tokens", async () => {
    await expect(checkSponsoredCalls(batch([approve(), buy()]), sender, { ...reads, curveOf: async () => "0x0000000000000000000000000000000000000000" }, now)).rejects.toThrow();
  });
  it.each(["wrong spender", "wrong amount", "max approval", "extra transfer", "native value", "trailing bytes", "duplicate approval", "approval after trade", "unknown target"])("rejects %s", async (kind) => {
    let calls = [approve(), buy()];
    if (kind === "wrong spender") calls[0] = approve(d.usdg, sender);
    if (kind === "wrong amount") calls[0] = approve(d.usdg, d.router, 101n);
    if (kind === "max approval") calls[0] = approve(d.usdg, d.router, (1n << 256n) - 1n);
    if (kind === "extra transfer") calls.push({ target: d.usdg, value: 0n, data: encodeFunctionData({ abi, functionName: "transfer", args: [coin, 1n] }) });
    if (kind === "native value") calls[1].value = 1n;
    if (kind === "duplicate approval") calls = [approve(), ...calls];
    if (kind === "approval after trade") calls.reverse();
    if (kind === "unknown target") calls[1].target = sender;
    const cd = batch(calls);
    await expect(checkSponsoredCalls(kind === "trailing bytes" ? `${cd}00` : cd, sender, reads, now)).rejects.toThrow();
  });
  it("rejects redirected recipient and expired deadline", async () => {
    const cb: C = { target: d.router, value: 0n, data: encodeFunctionData({ abi, functionName: "buyExactIn", args: [coin, 100n, 1n, coin, BigInt(now + 60)] }) };
    await expect(checkSponsoredCalls(batch([approve(), cb]), sender, reads, now)).rejects.toThrow();
    await expect(checkSponsoredCalls(batch([approve(), buy()]), sender, reads, now + 61)).rejects.toThrow();
  });
  it("allows only byte-for-byte recognized owner session management", () => {
    process.env.NEXT_PUBLIC_SESSION_POLICY = policy;
    expect(() => checkSessionManagement(setup().data, now)).not.toThrow();
    expect(() => checkSessionManagement(buildUninstallSession(7, modules), now)).not.toThrow();
    expect(() => checkSessionManagement(setup(TRADE_PERMS | (1n << 7n)).data, now)).toThrow();
    expect(() => checkSessionManagement(`${setup().data}00`, now)).toThrow();
    expect(() => checkSessionManagement(setup().data, now + 121)).toThrow();
  });
});
