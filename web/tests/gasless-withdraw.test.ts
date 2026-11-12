/** Gasless withdraw: fee math, request rules, Permit2 witness + GaslessForwarder calldata. */
import { describe, expect, it } from "vitest";
import { decodeFunctionData, hashTypedData, recoverTypedDataAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { rateFromEnv, unmarkedRate } from "../lib/server/usdgEthRate";
import { GaslessReject, jsonSafe, PERMIT2 } from "../lib/trade/gaslessPermit2";
import {
  checkGaslessWithdrawRequest, encodeWithdrawCall, minWithdrawAmount, microUsdg, parseGaslessWithdrawRequest,
  withdrawFeeRaw, withdrawGas, withdrawTypedData, withdrawWitnessHash,
  WITHDRAW_GAS, WITHDRAW_GAS_PAD, WITHDRAW_GAS_PERMIT, type GaslessWithdrawRequest,
} from "../lib/trade/gaslessWithdraw";
import { gaslessForwarderAbi } from "../lib/trade/gaslessForwarder";
import { formatUsdgFee, parseWithdrawQuote, signGaslessWithdraw } from "../lib/trade/gaslessWithdrawClient";
import type { LocalAccount, PublicClient } from "viem";

const usdg = "0x9dC7A988a8707dC4AB7ac08fC2CB4D5bf906158D" as Address;
const dest = "0x00000000000000000000000000000000000000dd" as Address;
const feeTo = "0x00000000000000000000000000000000000000ee" as Address;
const fwd = "0x111111111111111111111111111111111111F0D1" as Address;
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

async function req(o: Partial<{ amount: bigint; fee: bigint; dest: Address; feeTo: Address; nonce: bigint; deadline: bigint; token: Address }> = {}): Promise<GaslessWithdrawRequest> {
  const fee = o.fee ?? 5_106n, amount = o.amount ?? 10_000_000n, deadline = o.deadline ?? BigInt(NOW + 120);
  const token = o.token ?? usdg;
  const permit = { permitted: { token, amount }, nonce: o.nonce ?? 0n, deadline };
  const destination = o.dest ?? dest, f = o.feeTo ?? feeTo;
  return {
    signer: user.address, destination, amount, fee, feeTo: f,
    permit, signature: await user.signTypedData(withdrawTypedData(46630, permit, { to: destination, fee, feeTo: f }, fwd)),
  };
}
const chk = (q: GaslessWithdrawRequest, extra: Partial<{ minFee: bigint; feeTo: Address }> = {}) =>
  checkGaslessWithdrawRequest(q, { usdg, usdgDecimals: 6, nowSec: NOW, feeTo: extra.feeTo ?? feeTo, minFee: extra.minFee, forwarder: fwd });

describe("request rules (before any RPC)", () => {
  it("amount <= fee is refused; the minimum is fee plus one micro-USDG", async () => {
    await expect(req({ amount: 5_106n, fee: 5_106n }).then(chk)).rejects.toThrow("amount must exceed the network fee");
    await expect(req({ amount: 5_107n, fee: 5_106n }).then(chk)).resolves.toBeUndefined();
    expect(minWithdrawAmount(5_106n, 6)).toBe(5_107n);
  });
  it("permit token / amount / feeTo / deadlines are checked", async () => {
    await expect(req({ token: dest }).then(chk)).rejects.toThrow("permit token mismatch");
    const q = await req();
    q.permit = { ...q.permit, permitted: { ...q.permit.permitted, amount: 1n } };
    expect(() => chk(q)).toThrow("permit amount mismatch");
    await expect(req({ feeTo: dest }).then(chk)).rejects.toThrow("fee recipient is not the relayer");
    await expect(req({ dest: fwd }).then(chk)).rejects.toThrow("destination cannot be the forwarder");
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

describe("Permit2 witness typed data + GaslessForwarder calldata", () => {
  const tdOf = (q: GaslessWithdrawRequest) => withdrawTypedData(46630, q.permit, { to: q.destination, fee: q.fee, feeTo: q.feeTo }, fwd);

  it("recovers the signer and binds amount, destination, fee, and spender; a changed field does not recover", async () => {
    const q = await req();
    expect(await recoverTypedDataAddress({ ...tdOf(q), signature: q.signature })).toBe(user.address);
    expect(tdOf(q).message.spender.toLowerCase()).toBe(fwd.toLowerCase());
    const changed = { ...q.permit, permitted: { ...q.permit.permitted, amount: 1n } };
    expect(await recoverTypedDataAddress({ ...withdrawTypedData(46630, changed, { to: q.destination, fee: q.fee, feeTo: q.feeTo }, fwd), signature: q.signature })).not.toBe(user.address);
    const otherTo = { ...tdOf(q), message: { ...tdOf(q).message, witness: { to: feeTo, fee: q.fee, feeTo: q.feeTo } } };
    expect(await recoverTypedDataAddress({ ...otherTo, signature: q.signature })).not.toBe(user.address);
    const otherSpender = { ...tdOf(q), message: { ...tdOf(q).message, spender: feeTo } };
    expect(await recoverTypedDataAddress({ ...otherSpender, signature: q.signature })).not.toBe(user.address);
  });
  it("matches the on-chain Withdraw witness hash", () => {
    expect(withdrawWitnessHash({
      to: "0x6666666666666666666666666666666666666666",
      fee: 123n,
      feeTo: "0x7777777777777777777777777777777777777777",
    })).toBe("0xb1e7b9296d5945f569ac0c347500ad10e9de290b7f1cf395681810e9b1dbf738");
  });
  it("jsonSafe preserves the EIP-712 digest (Privy JSON.stringify)", async () => {
    const q = await req();
    const td = tdOf(q);
    expect(() => JSON.stringify(td)).toThrow(/BigInt/);
    expect(hashTypedData(jsonSafe(td))).toBe(hashTypedData(td));
  });
  it("encodes GaslessForwarder.withdraw with the signed destination and a bundled EIP-2612 when present", async () => {
    const q = await req();
    const decoded = decodeFunctionData({ abi: gaslessForwarderAbi, data: encodeWithdrawCall(q, fwd) });
    expect(decoded.functionName).toBe("withdraw");
    const args = decoded.args as unknown as readonly unknown[];
    expect((args[0] as Address).toLowerCase()).toBe(user.address.toLowerCase());
    expect((args[2] as { to: Address; fee: bigint; feeTo: Address }).to.toLowerCase()).toBe(dest.toLowerCase());
    expect((args[2] as { fee: bigint }).fee).toBe(q.fee);
    expect((args[2] as { feeTo: Address }).feeTo.toLowerCase()).toBe(feeTo.toLowerCase());
    const a = { value: 2n ** 256n - 1n, deadline: BigInt(NOW + 100), v: 27 as const, r: `0x${"11".repeat(32)}` as const, s: `0x${"22".repeat(32)}` as const };
    const withPermit = decodeFunctionData({ abi: gaslessForwarderAbi, data: encodeWithdrawCall({ ...q, approval: a }, fwd) });
    expect((withPermit.args[4] as { value: bigint; v: number }).value).toBe(2n ** 256n - 1n);
    expect((withPermit.args[4] as { v: number }).v).toBe(27);
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

describe("client sign (jsonSafe + one witness + optional EIP-2612)", () => {
  it("signGaslessWithdraw works when the signer JSON.stringifies the typed data", async () => {
    const owner = privyLike(user);
    const quote = parseWithdrawQuote({
      fee: "5106", feeTo, gas: "200000", gasPrice: "11100000", rate: "2300000000",
      usdg, usdgDecimals: 6, minAmount: "5107", spender: fwd, permit2: PERMIT2,
    });
    const q = await signGaslessWithdraw(mockPc(0n), owner, { amount: 10_000_000n, destination: dest, quote, nowSec: NOW });
    expect(q.fee).toBe(5_106n);
    expect(q.permit.permitted.amount).toBe(10_000_000n);
    expect(q.approval?.value).toBe(2n ** 256n - 1n);
    expect(await recoverTypedDataAddress({ ...withdrawTypedData(46630, q.permit, { to: dest, fee: q.fee, feeTo }, fwd), signature: q.signature })).toBe(user.address);
    expect(() => chk(q, { feeTo })).not.toThrow();
  });
  it("formatUsdgFee trims zeros", () => {
    expect(formatUsdgFee(5_106n, 6)).toBe("0.005106");
    expect(formatUsdgFee(10_000_000n, 6)).toBe("10");
    expect(formatUsdgFee(1n, 6)).toBe("0.000001");
  });
});
