/**
 * Outer gas limit for a single-op EntryPoint v0.7 handleOps tx (fastRelay + selfBundler).
 *
 * Why (AA95, tx 0x0a7f0e5a…): the old `totalGas(op) + 120k` is below what EntryPoint v0.7 needs for big-callGasLimit
 * ops. In EntryPoint.innerHandleOp (contracts/test/vendor/aa-v07/core/EntryPoint.sol, the version we target):
 *     if (gasleft() * 63 / 64 < callGasLimit + paymasterPostOpGasLimit + INNER_GAS_OVERHEAD)  ⇒ "AA95 out of gas"
 * and _executeUserOp reaches innerHandleOp with `call(gas(), address(), …)`, which forwards at most 63/64 of what is
 * left (EIP-150). So the gas left in _executeUserOp must be ≥ (cgl + pmPost + 10_000) × (64/63)², i.e. ≈ 3.2% over
 * the op's execution limits. That margin alone is ≈ 297k for a launch (cgl 9.29M), vs the old fixed 120k.
 *
 * outer = verificationGasLimit + paymasterVerificationGasLimit       (validation: the EntryPoint enforces these caps)
 *       + preVerificationGas
 *       + ceil((callGasLimit + paymasterPostOpGasLimit + 10_000) × 64² / 63²)
 *       + 21_000 + calldataGas(handleOps data)                   (intrinsic tx cost: EIP-2028 4 / 16 gas per byte)
 *       + 100_000                                                (ENTRYPOINT_OVERHEAD, below)
 *
 * ENTRYPOINT_OVERHEAD (outside the per-op limits above): handleOps loop + calldata→memory copies of the op and the
 * innerHandleOp re-encoding (~size of the op), nonce validateAndUpdate (cold SSTORE ≤ 22.1k), deposit / paymaster
 * deposit updates (≤ 2 × 5k warm–20k), BeforeExecution + UserOperationEvent logs (~3–5k), _compensate value call to
 * the beneficiary (cold account + value ≤ 34k incl. new-account), plus ~1–2k pre-check gas used inside innerHandleOp.
 * ≈ 60–80k total ⇒ 100k with headroom. pvg is NOT relied on for the intrinsic/calldata cost (clients send a fixed 60k,
 * and a launch carries a data: image in calldata).
 *
 * + l1Gas (Robinhood Chain is Arbitrum Orbit): ArbOS charges the L1 calldata cost as GAS UNITS taken from the tx gas
 *   limit before execution (receipt.gasUsedForL1). It floats with the L1 price / L2 base fee: setup 0x605823b2…
 *   (2026-10-30 07:33 CDT) had 598k L1 gas vs 174k at 07:28 for the same 2.7 KB, so `outer` without it hit AA95.
 *   Callers pass l1Reserve(NodeInterface.gasEstimateL1Component(handleOps data)).
 *
 * Applied to EVERY op. Over-sizing the limit costs nothing: the relayer pays for gas USED, and the EntryPoint prefund
 * is computed from the op's own limits, not the outer tx limit.
 */
import type { Hex } from "viem";

export const EP07_INNER_GAS_OVERHEAD = BigInt(10_000);   // EntryPoint v0.7 INNER_GAS_OVERHEAD
export const TX_BASE_GAS = BigInt(21_000);
export const ENTRYPOINT_OVERHEAD = BigInt(100_000);
/** ArbOS per-tx gas limit (Robinhood Chain is Arbitrum Orbit; the block header gasLimit 0x4000000000000 is not a tx cap). */
export const MAX_RELAY_TX_GAS = BigInt(32_000_000);

type Lim = { callGasLimit?: string | bigint; verificationGasLimit?: string | bigint; preVerificationGas?: string | bigint; paymaster?: string; paymasterVerificationGasLimit?: string | bigint; paymasterPostOpGasLimit?: string | bigint };
const big = (v: string | bigint | undefined) => (v === undefined || v === "" ? BigInt(0) : BigInt(v));

export function calldataGas(data: Hex): bigint {
  let g = BigInt(0);
  for (let i = 2; i < data.length; i += 2) g += data.slice(i, i + 2) === "00" ? BigInt(4) : BigInt(16);
  return g;
}

export class BundleGasError extends Error {
  constructor(public needed: bigint, public cap: bigint) { super(`op too large to relay: needs ${needed} gas, relay max ${cap}`); }
}

/** L1 gas when NodeInterface can't be read: above the 07:33 CDT 2026-10-30 spike (598k) for a ~2.7 KB setup bundle. */
export const L1_GAS_FALLBACK = BigInt(1_000_000);
/** Headroom on the L1 estimate (the L1 price can step between estimate and inclusion): 2× + 20k. */
export const l1Reserve = (estimate: bigint) => estimate * BigInt(2) + BigInt(20_000);

/** Gas for handleOps([op]) so innerHandleOp never hits AA95. Throws BundleGasError above `cap`. */
export function bundleGas(op: Lim, data: Hex, cap: bigint = MAX_RELAY_TX_GAS, l1Gas: bigint = BigInt(0)): bigint {
  const pm = !!op.paymaster;
  const exec = big(op.callGasLimit) + (pm ? big(op.paymasterPostOpGasLimit) : BigInt(0)) + EP07_INNER_GAS_OVERHEAD;
  const den = BigInt(63 * 63);
  const inner = (exec * BigInt(64 * 64) + den - BigInt(1)) / den;   // ceil(exec × (64/63)²)
  const g = big(op.verificationGasLimit) + (pm ? big(op.paymasterVerificationGasLimit) : BigInt(0)) + big(op.preVerificationGas)
    + inner + TX_BASE_GAS + calldataGas(data) + ENTRYPOINT_OVERHEAD + l1Gas;
  if (g > cap) throw new BundleGasError(g, cap);
  return g;
}
