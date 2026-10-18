/**
 * Referral qualification — REDEPLOY ONLY (FLOW UsdgDepositNotifier + ReferralRegistry, feat/modes-gas).
 *   deposit   USDG.approve(notifier, amount) + notifier.deposit(wallet, amount) → id   (one userOp)
 *   min       read from the contract: deposit(wallet, 0) is simulated and reverts BelowMinimum(min) — the contract has
 *             no public getter, so this is the only on-chain source (never hard-code $10: decimals differ per chain)
 *   escrow    escrowCount(wallet) + escrowOf(wallet, id) → (amount, unlockAt); withdraw(ids) once unlocked
 *   status    ReferralRegistry.referrerOf (≠0 ⇒ locked) / pendingReferrer (≠0 ⇒ pending)
 * Behind caps.referralGate. attest() is intentionally not built.
 */
import { encodeFunctionData, type Address, type PublicClient } from "viem";
import { tokenAbi } from "../abi";
import { depositNotifierAbi, referralRegistryRedeployAbi } from "../abi/redeploy";
import { deployment } from "../chains";
import type { Call } from "../aa/core";
import { execCalls } from "../wallet";
import { assetMeta, revertOf, ZERO_ADDR, type Asset } from "./common";

export type Escrow = { id: number; amount: bigint; unlockAt: number };
export type GateState = {
  status: "none" | "pending" | "locked";
  referrer: Address | null;
  usdg: Asset; min: bigint | null; lockSec: number;
  deposited: bigint;
  escrows: Escrow[];
};

const notifier = () => deployment().usdgDepositNotifier;
let usdgAddr: Promise<Address> | null = null;
export const notifierUsdg = (pc: PublicClient) => (usdgAddr ??= pc.readContract({ address: notifier(), abi: depositNotifierAbi, functionName: "usdg" }) as Promise<Address>);

const minCache = new Map<string, bigint>();
/** Minimum per deposit, from the contract's own BelowMinimum(min) revert. null if it can't be read. */
export async function depositMinimum(pc: PublicClient, wallet: Address): Promise<bigint | null> {
  const k = notifier().toLowerCase();
  if (minCache.has(k)) return minCache.get(k)!;
  try {
    await pc.simulateContract({ address: notifier(), abi: depositNotifierAbi, functionName: "deposit", args: [wallet, BigInt(0)], account: wallet });
    return null; // a 0 deposit should never succeed; treat as unknown
  } catch (e) {
    const r = revertOf(e);
    if (r?.name === "BelowMinimum") { const m = BigInt(r.args[0] as bigint); minCache.set(k, m); return m; }
    return null;
  }
}

export async function escrowsOf(pc: PublicClient, wallet: Address): Promise<Escrow[]> {
  const n = Number(await pc.readContract({ address: notifier(), abi: depositNotifierAbi, functionName: "escrowCount", args: [wallet] }));
  const ids = Array.from({ length: Math.min(n, 100) }, (_, i) => n - 1 - i); // newest first, capped
  const rows = await Promise.all(ids.map(async (id) => {
    const [amount, unlockAt] = (await pc.readContract({ address: notifier(), abi: depositNotifierAbi, functionName: "escrowOf", args: [wallet, BigInt(id)] })) as readonly [bigint, bigint];
    return { id, amount, unlockAt: Number(unlockAt) };
  }));
  return rows.filter((r) => r.amount > BigInt(0)); // withdrawn entries stay with amount 0
}

export async function gateState(pc: PublicClient, wallet: Address): Promise<GateState> {
  const reg = deployment().referralRegistry;
  const [ref, pending, deposited, usdgA, lock, escrows, min] = await Promise.all([
    pc.readContract({ address: reg, abi: referralRegistryRedeployAbi, functionName: "referrerOf", args: [wallet] }) as Promise<Address>,
    pc.readContract({ address: reg, abi: referralRegistryRedeployAbi, functionName: "pendingReferrer", args: [wallet] }) as Promise<Address>,
    pc.readContract({ address: reg, abi: referralRegistryRedeployAbi, functionName: "usdgDeposited", args: [wallet] }).catch(() => BigInt(0)) as Promise<bigint>,
    notifierUsdg(pc),
    pc.readContract({ address: notifier(), abi: depositNotifierAbi, functionName: "LOCK_PERIOD" }).then(Number).catch(() => 7 * 86400),
    escrowsOf(pc, wallet),
    depositMinimum(pc, wallet),
  ]);
  const locked = ref && ref !== ZERO_ADDR, isPending = pending && pending !== ZERO_ADDR;
  return {
    status: locked ? "locked" : isPending ? "pending" : "none", referrer: locked ? ref : isPending ? pending : null,
    usdg: await assetMeta(pc, usdgA), min, lockSec: lock, deposited, escrows,
  };
}

/** approve(notifier, exact amount) + deposit(wallet, amount): one userOp. */
export async function depositCalls(pc: PublicClient, wallet: Address, amount: bigint): Promise<Call[]> {
  const usdg = await notifierUsdg(pc);
  return [
    { to: usdg, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [notifier(), amount] }) },
    { to: notifier(), data: encodeFunctionData({ abi: depositNotifierAbi, functionName: "deposit", args: [wallet, amount] }) },
  ];
}
export async function deposit(pc: PublicClient, wallet: Address, amount: bigint) {
  const min = await depositMinimum(pc, wallet);
  if (min != null && amount < min) throw new Error("Deposit is below the minimum.");
  return execCalls(await depositCalls(pc, wallet, amount));
}

export const unlocked = (e: Escrow, nowSec = Math.floor(Date.now() / 1000)) => nowSec >= e.unlockAt;
/** withdraw(ids) for the unlocked entries only (a locked id would revert Locked(id, unlockAt)). */
export function withdrawCall(ids: number[]): Call {
  return { to: notifier(), data: encodeFunctionData({ abi: depositNotifierAbi, functionName: "withdraw", args: [ids.map(BigInt)] }) };
}
export async function withdraw(escrows: Escrow[]) {
  const ids = escrows.filter((e) => unlocked(e)).map((e) => e.id);
  if (!ids.length) throw new Error("Nothing unlocked yet.");
  return execCalls([withdrawCall(ids)]);
}

/** "unlocks in 3d 4h" / "unlocked" */
export function unlockLabel(unlockAt: number, nowSec = Math.floor(Date.now() / 1000)): string {
  const s = unlockAt - nowSec;
  if (s <= 0) return "Unlocked";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.max(1, Math.floor((s % 3600) / 60));
  return `Unlocks in ${d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`}`;
}
