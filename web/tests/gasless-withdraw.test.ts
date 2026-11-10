/** flow/gasless-withdraw: fee math (round up to 0.000001 USDG, 1.0x paymaster rate), request rules, typed-data + Multicall3 calldata. */
import { describe, expect, it } from "vitest";
import { decodeFunctionData, hashTypedData, recoverTypedDataAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { rateFromEnv, unmarkedRate } from "../lib/server/paymasterCore";
import { GaslessReject, jsonSafe, PERMIT2 } from "../lib/trade/gaslessPermit2";
import {
  checkGaslessWithdrawRequest, encodeWithdrawCall, erc2612PermitAbi, minWithdrawAmount, microUsdg,
  MULTICALL3, multicall3Abi, parseGaslessWithdrawRequest, permit2TransferAbi, transferTypedData,
  withdrawFeeRaw, withdrawGas, WITHDRAW_GAS, WITHDRAW_GAS_PAD, WITHDRAW_GAS_PERMIT, type GaslessWithdrawRequest,
} from "../lib/trade/gaslessWithdraw";
import { formatUsdgFee, parseWithdrawQuote, signGaslessWithdraw } from "../lib/trade/gaslessWithdrawClient";
import type { LocalAccount, PublicClient } from "viem";

const usdg = "0x9dC7A988a8707dC4AB7ac08fC2CB4D5bf906158D" as Address;
const dest = "0x00000000000000000000000000000000000000dd" as Address;
const feeTo = "0x00000000000000000000000000000000000000ee" as Address;
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

async function req(o: Partial<{ amount: bigint; fee: bigint; dest: Address; feeTo: Address; nonce1: bigint; nonce2: bigint; deadline: bigint; token: Address }> = {}): Promise<GaslessWithdrawRequest> {
  const fee = o.fee ?? 5_106n, amount = o.amount ?? 10_000_000n, deadline = o.deadline ?? BigInt(NOW + 120);
  const token = o.token ?? usdg;
  const netPermit = { permitted: { token, amount: amount - fee }, nonce: o.nonce1 ?? 0n, deadline };
  const feePermit = { permitted: { token, amount: fee }, nonce: o.nonce2 ?? 1n, deadline };
  return {
    signer: user.address, destination: o.dest ?? dest, amount, fee, feeTo: o.feeTo ?? feeTo,
    netPermit, feePermit,
    netSignature: await user.signTypedData(transferTypedData(46630, netPermit)),
    feeSignature: await user.signTypedData(transferTypedData(46630, feePermit)),
  };
}
const chk = (q: GaslessWithdrawRequest, extra: Partial<{ minFee: bigint; feeTo: Address }> = {}) =>
  checkGaslessWithdrawRequest(q, { usdg, usdgDecimals: 6, nowSec: NOW, feeTo: extra.feeTo ?? feeTo, minFee: extra.minFee });

describe("request rules (before any RPC)", () => {
  it("amount <= fee is refused; the minimum is fee plus one micro-USDG", async () => {
    await expect(req({ amount: 5_106n, fee: 5_106n }).then(chk)).rejects.toThrow("amount must exceed the network fee");
    await expect(req({ amount: 5_107n, fee: 5_106n }).then(chk)).resolves.toBeUndefined();
    expect(minWithdrawAmount(5_106n, 6)).toBe(5_107n);
  });
  it("permit token / amounts / nonces / feeTo / deadlines are checked", async () => {
    await expect(req({ token: dest }).then(chk)).rejects.toThrow("permit token mismatch");
    const q = await req();
    q.netPermit = { ...q.netPermit, permitted: { ...q.netPermit.permitted, amount: 1n } };
    expect(() => chk(q)).toThrow("net permit amount mismatch");
    const q2 = await req();
    q2.feePermit = { ...q2.feePermit, permitted: { ...q2.feePermit.permitted, amount: 1n } };
    expect(() => chk(q2)).toThrow("fee permit amount mismatch");
    await expect(req({ nonce1: 7n, nonce2: 7n }).then(chk)).rejects.toThrow("permit nonces must differ");
    await expect(req({ feeTo: dest }).then(chk)).rejects.toThrow("fee recipient is not the relayer");
    await expect(req({ deadline: BigInt(NOW) }).then(chk)).rejects.toThrow("deadline");
    await expect(req({ deadline: BigInt(NOW + 301) }).then(chk)).rejects.toThrow("deadline");
  });
  it("parse: JSON bigints round-trip; junk is GaslessReject (notSent)", async () => {
    const q = await req();
    const wire = JSON.parse(JSON.stringify(q, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    expect(parseGaslessWithdrawRequest(wire)).toEqual(q);
    for (const bad of [{ ...wire, signer: "0x0" }, { ...wire, netSignature: "0x12" }, { ...wire, fee: "-1" }]) {
      try { parseGaslessWithdrawRequest(bad); throw new Error("accepted"); } catch (e) { expect(e).toBeInstanceOf(GaslessReject); expect((e as GaslessReject).notSent).toBe(true); }
    }
  });
});

describe("Permit2 typed data + Multicall3 calldata (spender is Multicall3)", () => {
  it("recovers the signer and binds amount / spender / nonce; a changed field does not recover", async () => {
    const q = await req();
    expect(await recoverTypedDataAddress({ ...transferTypedData(46630, q.netPermit), signature: q.netSignature })).toBe(user.address);
    expect(await recoverTypedDataAddress({ ...transferTypedData(46630, q.feePermit), signature: q.feeSignature })).toBe(user.address);
    const changed = { ...q.netPermit, permitted: { ...q.netPermit.permitted, amount: 1n } };
    expect(await recoverTypedDataAddress({ ...transferTypedData(46630, changed), signature: q.netSignature })).not.toBe(user.address);
    const otherSpender = { ...transferTypedData(46630, q.netPermit), message: { ...transferTypedData(46630, q.netPermit).message, spender: feeTo } };
    expect(await recoverTypedDataAddress({ ...otherSpender, signature: q.netSignature })).not.toBe(user.address);
    expect(transferTypedData(46630, q.netPermit).message.spender).toBe(MULTICALL3);
  });
  it("jsonSafe preserves the EIP-712 digest (Privy JSON.stringify)", async () => {
    const q = await req();
    const td = transferTypedData(46630, q.netPermit);
    expect(() => JSON.stringify(td)).toThrow(/BigInt/);
    expect(hashTypedData(jsonSafe(td))).toBe(hashTypedData(td));
  });
  it("encodes Multicall3.aggregate3 of [net transfer, fee transfer], optional USDG.permit first, never to the relayer as spender", async () => {
    const q = await req();
    const data = encodeWithdrawCall(q, usdg);
    const decoded = decodeFunctionData({ abi: multicall3Abi, data });
    expect(decoded.functionName).toBe("aggregate3");
    const calls = decoded.args[0] as { target: Address; allowFailure: boolean; callData: `0x${string}` }[];
    expect(calls).toHaveLength(2);
    expect(calls.every(c => !c.allowFailure)).toBe(true);
    expect(calls[0].target.toLowerCase()).toBe(PERMIT2.toLowerCase());
    expect(calls[1].target.toLowerCase()).toBe(PERMIT2.toLowerCase());
    const net = decodeFunctionData({ abi: permit2TransferAbi, data: calls[0].callData });
    const fee = decodeFunctionData({ abi: permit2TransferAbi, data: calls[1].callData });
    expect(net.functionName).toBe("permitTransferFrom");
    expect((net.args[1] as { to: Address }).to.toLowerCase()).toBe(dest.toLowerCase());
    expect((net.args[1] as { requestedAmount: bigint }).requestedAmount).toBe(q.amount - q.fee);
    expect((net.args[2] as Address).toLowerCase()).toBe(user.address.toLowerCase());
    expect((fee.args[1] as { to: Address }).to.toLowerCase()).toBe(feeTo.toLowerCase());
    expect((fee.args[1] as { requestedAmount: bigint }).requestedAmount).toBe(q.fee);
    const a = { value: 2n ** 256n - 1n, deadline: BigInt(NOW + 100), v: 27 as const, r: `0x${"11".repeat(32)}` as const, s: `0x${"22".repeat(32)}` as const };
    const withPermit = encodeWithdrawCall({ ...q, approval: a }, usdg);
    const d2 = decodeFunctionData({ abi: multicall3Abi, data: withPermit });
    const c2 = d2.args[0] as unknown as { target: Address; callData: `0x${string}` }[];
    expect(c2).toHaveLength(3);
    expect(c2[0].target.toLowerCase()).toBe(usdg.toLowerCase());
    const perm = decodeFunctionData({ abi: erc2612PermitAbi, data: c2[0].callData });
    expect(perm.functionName).toBe("permit");
    expect((perm.args[1] as Address).toLowerCase()).toBe(PERMIT2.toLowerCase());
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

describe("client sign (jsonSafe + two distinct nonces + optional EIP-2612)", () => {
  it("signGaslessWithdraw works when the signer JSON.stringifies the typed data", async () => {
    const owner = privyLike(user);
    const quote = parseWithdrawQuote({
      fee: "5106", feeTo, gas: "200000", gasPrice: "11100000", rate: "2300000000",
      usdg, usdgDecimals: 6, minAmount: "5107", spender: MULTICALL3, permit2: PERMIT2,
    });
    const q = await signGaslessWithdraw(mockPc(0n), owner, { amount: 10_000_000n, destination: dest, quote, nowSec: NOW });
    expect(q.fee).toBe(5_106n);
    expect(q.netPermit.nonce).not.toBe(q.feePermit.nonce);
    expect(q.approval?.value).toBe(2n ** 256n - 1n);
    expect(await recoverTypedDataAddress({ ...transferTypedData(46630, q.netPermit), signature: q.netSignature })).toBe(user.address);
    expect(() => chk(q, { feeTo })).not.toThrow();
  });
  it("formatUsdgFee trims zeros", () => {
    expect(formatUsdgFee(5_106n, 6)).toBe("0.005106");
    expect(formatUsdgFee(10_000_000n, 6)).toBe("10");
    expect(formatUsdgFee(1n, 6)).toBe("0.000001");
  });
});
