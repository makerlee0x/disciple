/**
 * Hidden USDG gas credit (DisciplePaymaster v5). Players see one USDG balance. These helpers
 * fund the $2 credit inside the existing setup prompt, top it back up inside a trade, and
 * pull it back into the account when a normal send needs more than the wallet holds.
 * No permit, no deferred token approval, no account-validation token write.
 */
import { encodeFunctionData, parseAbi, toFunctionSelector, type Address } from "viem";
import type { Call } from "./core";
import { SETUP_DEPOSIT } from "./paymaster";

export { SETUP_DEPOSIT };
/** Room a send leaves so this op's gas reservation can still settle. 6-decimal USDG, $0.10. */
export const SEND_CREDIT_LOCK = 100_000n;
const erc20 = parseAbi(["function approve(address,uint256)", "function transfer(address,uint256)"]);
const pm = parseAbi(["function deposit(address,uint256)", "function release(uint256)", "function withdraw()"]);
const USDG_IN = new Set([
  toFunctionSelector("buyWithUsdg(address,uint256,uint256,uint256)").toLowerCase(),
  toFunctionSelector("swapUsdgToQuote(address,uint256,uint256,address,uint256)").toLowerCase(),
]);

export function creditApproveCall(usdg: Address, paymaster: Address, amount: bigint): Call {
  return { to: usdg, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [paymaster, amount] }) };
}
export function creditDepositCall(paymaster: Address, account: Address, amount: bigint): Call {
  return { to: paymaster, value: 0n, data: encodeFunctionData({ abi: pm, functionName: "deposit", args: [account, amount] }) };
}
export function creditReleaseCall(paymaster: Address, amount: bigint): Call {
  return { to: paymaster, value: 0n, data: encodeFunctionData({ abi: pm, functionName: "release", args: [amount] }) };
}
export function creditWithdrawCall(paymaster: Address): Call {
  return { to: paymaster, value: 0n, data: encodeFunctionData({ abi: pm, functionName: "withdraw" }) };
}
/** Exact approve + deposit(self). An optional installValidation call may follow in the same owner op. */
export function setupCreditCalls(usdg: Address, paymaster: Address, account: Address, amount = SETUP_DEPOSIT): Call[] {
  return [creditApproveCall(usdg, paymaster, amount), creditDepositCall(paymaster, account, amount)];
}

export type CreditSnapshot = { wallet: bigint; credit: bigint; reserved: bigint; withdrawPending?: boolean; hold?: bigint };

/** Unreserved credit still held by the paymaster. Reserved gas is excluded. Not yet in the wallet. */
export function availableCreditOf(s: Pick<CreditSnapshot, "credit" | "reserved">): bigint {
  return s.credit > s.reserved ? s.credit - s.reserved : 0n;
}

/**
 * The one USDG balance: wallet USDG plus hidden credit.
 * Reserved amounts are excluded. A pending withdraw is counted once (it has not reached the wallet yet).
 * `hold` subtracts this operation's own gas lock; a plain read passes 0.
 */
export function spendableUsdg(s: CreditSnapshot): bigint {
  const available = availableCreditOf(s);
  const hold = s.hold ?? 0n;
  const free = available > hold ? available - hold : 0n;
  return s.wallet + free;
}

/** USDG a trade batch will pull from the wallet (buy / swap input, or a USDG transfer). */
export function usdgInOf(calls: Call[], usdg: Address): bigint {
  let n = 0n;
  for (const c of calls) {
    const sel = (c.data || "0x").slice(0, 10).toLowerCase();
    if (c.data.length < 138) continue;
    if (c.to.toLowerCase() === usdg.toLowerCase() && sel === "0xa9059cbb") n += BigInt(`0x${c.data.slice(74, 138)}`);
    else if (USDG_IN.has(sel)) n += BigInt(`0x${c.data.slice(74, 138)}`);
  }
  return n;
}

/**
 * Keep the hidden credit at $2. Appends an exact approve+deposit when the wallet can spare it
 * after the trade's own USDG input. A zero-credit account is left alone (that is the setup op).
 * The deposit cannot pay for this same operation.
 */
export function withAutoTopUp(calls: Call[], o: {
  usdg: Address; paymaster: Address; account: Address; available: bigint; wallet: bigint; tradeSpend?: bigint; target?: bigint;
}): Call[] {
  const target = o.target ?? SETUP_DEPOSIT;
  if (o.available === 0n || o.available >= target) return calls;
  const need = target - o.available;
  const spent = o.tradeSpend ?? usdgInOf(calls, o.usdg);
  const spare = o.wallet > spent ? o.wallet - spent : 0n;
  if (spare < need) return calls;
  return [...calls, ...setupCreditCalls(o.usdg, o.paymaster, o.account, need)];
}

/**
 * Normal USDG send. When `amount` is larger than the wallet, the batch first pulls the shortfall
 * out of hidden credit (`release`) and then transfers. No separate action.
 */
export function usdgSendCalls(o: {
  usdg: Address; paymaster: Address; to: Address; amount: bigint; wallet: bigint; available: bigint; gasReserve?: bigint; withdrawPending?: boolean;
}): Call[] {
  const transfer: Call = { to: o.usdg, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [o.to, o.amount] }) };
  if (o.amount <= o.wallet) return [transfer];
  if (o.withdrawPending) throw new Error("not enough USDG");
  const pull = o.amount - o.wallet;
  const lock = o.gasReserve ?? SEND_CREDIT_LOCK;
  const room = o.available > lock ? o.available - lock : 0n;
  if (pull > room) throw new Error("not enough USDG");
  return [creditReleaseCall(o.paymaster, pull), transfer];
}
