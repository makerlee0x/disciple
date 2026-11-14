/** flow/gasless-withdraw: fee math (round up to 0.000001 USDG, 1.0x paymaster rate), request rules, typed-data + forwarder calldata. */
import { describe, expect, it } from "vitest";
import { decodeFunctionData, getAddress, hashTypedData, recoverTypedDataAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { rateFromEnv, unmarkedRate } from "../lib/server/usdgEthRate";
import { GaslessReject, jsonSafe, PERMIT2 } from "../lib/trade/gaslessPermit2";
import {
  checkGaslessWithdrawRequest, encodeWithdrawCall, erc2612PermitAbi, minWithdrawAmount, microUsdg,
  MULTICALL3, multicall3Abi, parseGaslessWithdrawRequest, withdrawTypedDataOf,
  withdrawFeeRaw, withdrawGas, WITHDRAW_GAS, WITHDRAW_GAS_PAD, WITHDRAW_GAS_PERMIT, type GaslessWithdrawRequest,
} from "../lib/trade/gaslessWithdraw";
import { formatUsdgFee, parseWithdrawQuote, signGaslessWithdraw } from "../lib/trade/gaslessWithdrawClient";
import { forwarderAbi } from "../lib/trade/gaslessForwarder";
import type { LocalAccount, PublicClient } from "viem";

const usdg = getAddress("0x9dC7A988a8707dC4AB7ac08fC2CB4D5bf906158D");
const dest = getAddress("0x00000000000000000000000000000000000000dd");
const feeTo = getAddress("0x00000000000000000000000000000000000000ee");
const FWD = getAddress("0x00000000000000000000000000000000000000f0");
const mallory = "0x0000000000000000000000000000000000000bad" as Address;
const NOW = 1_000_000;
const user = privateKeyToAccount(generatePrivateKey());

describe("withdraw fee math (round up to 0.000001 USDG, 1.0x paymaster rate)", () => {
  it("reuses rateFromEnv + unmarkedRate (no markup)", () => {
    const rate = rateFromEnv({ PAYMASTER_USD_PER_ETH: "2300" }, 6);
    expect(rate).toBe(2_300_000_000n);
    expect(unmarkedRate(rate)).toBe(rate);
    expect(unmarkedRate(rateFromEnv({ PAYMASTER_RATE: "2300000000" }, 6))).toBe(2_300_000_000n);
  });
  it("rounds up to the next 0.000001 USDG, and an exact micro stays exact", () => {
    expect(microUsdg(6)).toBe(1n);
    expect(microUsdg(18)).toBe(10n ** 12n);
    // 1 wei of ETH-value at rate 1 and 6 decimals still becomes 1 micro
    expect(withdrawFeeRaw(1n, 1n, 1n, 6)).toBe(1n);
    // exact: 1e18 wei-value * rate 1 / 1e18 = 1, already a micro
    expect(withdrawFeeRaw(10n ** 18n, 1n, 1n, 6)).toBe(1n);
    // just under 2 micros (1.000...1) rounds up to 2
    // num = gas * price * rate; choose values so raw = 1e18 + 1 wei-equivalent → 2 micros at 6 dec
    // raw = ceil(gas*price*rate / 1e18). 2 * 1e18 / 2 = 1e18 exactly → 1; bump gas to produce a remainder:
    expect(withdrawFeeRaw(1n, 10n ** 18n + 1n, 1n, 6)).toBe(2n); // ceil(1 + 1e-18) = 2
    // 18-decimal USDG: 0.000001 = 1e12
    expect(withdrawFeeRaw(1n, 1n, 1n, 18)).toBe(10n ** 12n);
    expect(withdrawFeeRaw(1n, 10n ** 18n, 10n ** 12n, 18)).toBe(10n ** 12n);
    expect(withdrawFeeRaw(1n, 10n ** 18n, 10n ** 12n + 1n, 18)).toBe(2n * 10n ** 12n);
  });
  it("uses the 1.0x $2300 rate and live 0.0111 gwei style numbers without a 1.5x cap", () => {
    const rate = unmarkedRate(rateFromEnv({ PAYMASTER_USD_PER_ETH: "2300" }, 6));
    const gas = withdrawGas(false); // 200_000
    const fee = withdrawFeeRaw(gas, 11_100_000n, rate, 6); // 0.0111 gwei
    // 200000 * 11100000 * 2300000000 / 1e18 = 5106 exactly
    expect(fee).toBe(5_106n);
    expect(minWithdrawAmount(fee, 6)).toBe(5_107n);
    expect(withdrawGas(false)).toBe(WITHDRAW_GAS + WITHDRAW_GAS_PAD);
    expect(withdrawGas(true)).toBe(WITHDRAW_GAS + WITHDRAW_GAS_PERMIT + WITHDRAW_GAS_PAD);
  });
});

async function req(o: Partial<{ amount: bigint; fee: bigint; dest: Address; feeTo: Address; nonce: bigint; deadline: bigint; token: Address; permitAmount: bigint }> = {}): Promise<GaslessWithdrawRequest> {
  const fee = o.fee ?? 5_106n, amount = o.amount ?? 10_000_000n, deadline = o.deadline ?? BigInt(NOW + 120);
  const token = o.token ?? usdg;
  const permit = { permitted: { token, amount: o.permitAmount ?? amount }, nonce: o.nonce ?? 0n, deadline };
  const base = { destination: o.dest ?? dest, amount, fee, feeTo: o.feeTo ?? feeTo, permit };
  return { signer: user.address, ...base, signature: await user.signTypedData(withdrawTypedDataOf(46630, FWD, base)) };
}
const chk = (q: GaslessWithdrawRequest, extra: Partial<{ minFee: bigint; feeTo: Address }> = {}) =>
  checkGaslessWithdrawRequest(q, { usdg, usdgDecimals: 6, nowSec: NOW, feeTo: extra.feeTo ?? feeTo, minFee: extra.minFee });

describe("request rules (before any RPC)", () => {
  it("amount <= fee is refused; the minimum is fee plus one micro-USDG", async () => {
    await expect(req({ amount: 5_106n, fee: 5_106n }).then(chk)).rejects.toThrow("amount must exceed the network fee");
    await expect(req({ amount: 5_107n, fee: 5_106n }).then(chk)).resolves.toBeUndefined();
    expect(minWithdrawAmount(5_106n, 6)).toBe(5_107n);
  });
  it("permit token / amount / feeTo / deadlines are checked", async () => {
    await expect(req({ token: dest }).then(chk)).rejects.toThrow("permit token mismatch");
    await expect(req({ permitAmount: 10_000_000n - 5_106n }).then(chk)).rejects.toThrow("permit amount mismatch");
    await expect(req({ feeTo: dest }).then(chk)).rejects.toThrow("fee recipient is not the relayer");
    await expect(req({ deadline: BigInt(NOW) }).then(chk)).rejects.toThrow("deadline");
    await expect(req({ deadline: BigInt(NOW + 301) }).then(chk)).rejects.toThrow("deadline");
  });
  it("parse: JSON bigints round-trip; junk is GaslessReject (notSent)", async () => {
    const q = await req();
    const wire = JSON.parse(JSON.stringify(q, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    expect(parseGaslessWithdrawRequest(wire)).toEqual(q);
    for (const bad of [{ ...wire, signer: "0x0" }, { ...wire, signature: "0x12" }, { ...wire, fee: "-1" }]) {
      try { parseGaslessWithdrawRequest(bad); throw new Error("accepted"); } catch (e) { expect(e).toBeInstanceOf(GaslessReject); expect((e as GaslessReject).notSent).toBe(true); }
    }
  });
});

describe("Permit2 witness typed data + forwarder calldata (spender is GaslessForwarder, never Multicall3)", () => {
  it("recovers the signer; changing the destination, fee, fee recipient, amount or spender does not recover", async () => {
    const q = await req();
    expect(await recoverTypedDataAddress({ ...withdrawTypedDataOf(46630, FWD, q), signature: q.signature })).toBe(user.address);
    for (const changed of [{ ...q, destination: mallory }, { ...q, fee: q.fee + 1n }, { ...q, feeTo: mallory }, { ...q, amount: q.amount - 1n }]) {
      expect(await recoverTypedDataAddress({ ...withdrawTypedDataOf(46630, FWD, changed), signature: q.signature })).not.toBe(user.address);
    }
    expect(await recoverTypedDataAddress({ ...withdrawTypedDataOf(46630, MULTICALL3, q), signature: q.signature })).not.toBe(user.address);
    const td = withdrawTypedDataOf(46630, FWD, q);
    expect(td.message.spender).toBe(FWD);
    expect(td.message.witness).toEqual({ to: dest, amount: q.amount - q.fee, fee: q.fee, feeTo });
  });
  it("jsonSafe preserves the EIP-712 digest (Privy JSON.stringify)", async () => {
    const q = await req();
    const td = withdrawTypedDataOf(46630, FWD, q);
    expect(() => JSON.stringify(td)).toThrow(/BigInt/);
    expect(hashTypedData(jsonSafe(td))).toBe(hashTypedData(td));
  });
  it("encodes Multicall3.aggregate3 of [forwarder.withdraw], optional USDG.permit first (allowFailure), no Permit2 call from Multicall3", async () => {
    const q = await req();
    const decoded = decodeFunctionData({ abi: multicall3Abi, data: encodeWithdrawCall(q, usdg, FWD) });
    expect(decoded.functionName).toBe("aggregate3");
    const calls = decoded.args[0] as { target: Address; allowFailure: boolean; callData: `0x${string}` }[];
    expect(calls).toHaveLength(1);
    expect(calls[0].target).toBe(FWD);
    expect(calls[0].allowFailure).toBe(false);
    const w = decodeFunctionData({ abi: forwarderAbi, data: calls[0].callData });
    expect(w.functionName).toBe("withdraw");
    const [permit, owner, wit, sig] = w.args as unknown as [{ permitted: { amount: bigint } }, Address, { to: Address; amount: bigint; fee: bigint; feeTo: Address }, `0x${string}`];
    expect(permit.permitted.amount).toBe(q.amount);
    expect(owner).toBe(user.address);
    expect(wit).toEqual({ to: dest, amount: q.amount - q.fee, fee: q.fee, feeTo });
    expect(sig).toBe(q.signature);
    const a = { value: 2n ** 256n - 1n, deadline: BigInt(NOW + 100), v: 27 as const, r: `0x${"11".repeat(32)}` as const, s: `0x${"22".repeat(32)}` as const };
    const d2 = decodeFunctionData({ abi: multicall3Abi, data: encodeWithdrawCall({ ...q, approval: a }, usdg, FWD) });
    const c2 = d2.args[0] as unknown as { target: Address; allowFailure: boolean; callData: `0x${string}` }[];
    expect(c2).toHaveLength(2);
    expect(c2[0].target.toLowerCase()).toBe(usdg.toLowerCase());
    expect(c2[0].allowFailure).toBe(true);
    const perm = decodeFunctionData({ abi: erc2612PermitAbi, data: c2[0].callData });
    expect(perm.functionName).toBe("permit");
    expect((perm.args[1] as Address).toLowerCase()).toBe(PERMIT2.toLowerCase());
    expect(c2.some((c) => c.target.toLowerCase() === PERMIT2.toLowerCase())).toBe(false);
  });
});

function privyLike(inner: LocalAccount): LocalAccount {
  return new Proxy(inner, {
    get(t, p, r) {
      if (p === "signTypedData") {
        return (td: Parameters<LocalAccount["signTypedData"]>[0]) => { JSON.stringify(td); return inner.signTypedData(td); };
      }
      return Reflect.get(t, p, r);
    },
  }) as LocalAccount;
}
function mockPc(allowance = 0n): PublicClient {
  return { readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === "nonceBitmap") return 0n;
    if (functionName === "allowance") return allowance;
    if (functionName === "nonces") return 0n;
    if (functionName === "name") return "MockUSD";
    if (functionName === "eip712Domain") return ["0x0f", "MockUSD", "1", 46630n, usdg, `0x${"00".repeat(32)}`, []];
    throw new Error(`unexpected read ${functionName}`);
  } } as unknown as PublicClient;
}

describe("client sign (jsonSafe + one witness signature + optional EIP-2612)", () => {
  it("signGaslessWithdraw works when the signer JSON.stringifies the typed data", async () => {
    const owner = privyLike(user);
    const quote = parseWithdrawQuote({
      fee: "5106", feeTo, gas: "200000", gasPrice: "11100000", rate: "2300000000",
      usdg, usdgDecimals: 6, minAmount: "5107", spender: FWD, permit2: PERMIT2,
    });
    const q = await signGaslessWithdraw(mockPc(0n), owner, { amount: 10_000_000n, destination: dest, quote, nowSec: NOW });
    expect(q.fee).toBe(5_106n);
    expect(q.permit.permitted.amount).toBe(10_000_000n);
    expect(q.approval?.value).toBe(2n ** 256n - 1n);
    expect(await recoverTypedDataAddress({ ...withdrawTypedDataOf(46630, FWD, q), signature: q.signature })).toBe(user.address);
    expect(() => chk(q, { feeTo })).not.toThrow();
  });
  it("formatUsdgFee trims zeros", () => {
    expect(formatUsdgFee(5_106n, 6)).toBe("0.005106");
    expect(formatUsdgFee(10_000_000n, 6)).toBe("10");
    expect(formatUsdgFee(1n, 6)).toBe("0.000001");
  });
});
