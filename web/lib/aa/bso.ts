import { clientSponsorshipMode } from "./sponsorshipMode";
/** Explicit opt-in only. This policy is testnet-only; Production can never enable it. */
export const browserBso = (chainId: number) => chainId === 46630 && clientSponsorshipMode() === "bso";
export const BSO_ZERO = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, preVerificationGas: 0n };
const PM_FIELDS = ["paymaster", "paymasterData", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit", "paymasterAndData"];
/** Apply BEFORE signing; never mutate an already signed operation. */
export function bsoUnsigned<T extends Record<string, unknown>>(op: T): T & typeof BSO_ZERO {
  const clean = { ...op, ...BSO_ZERO };
  for (const k of PM_FIELDS) delete (clean as Record<string, unknown>)[k];
  return clean;
}
/** 30% measured-gas headroom remains well above the bundler's 0.4 efficiency floor. */
export function bsoGasBounds(measured: { callGasLimit: bigint; verificationGasLimit: bigint }) {
  if (measured.callGasLimit <= 0n || measured.verificationGasLimit <= 0n) throw new Error("BSO estimate did not measure gas");
  const padded = { callGasLimit: (measured.callGasLimit * 130n + 99n) / 100n, verificationGasLimit: (measured.verificationGasLimit * 130n + 99n) / 100n };
  if (padded.callGasLimit > 5_000_000n || padded.verificationGasLimit > 1_000_000n) throw new Error("BSO measured gas exceeds approved bounds");
  return padded;
}
export function checkBso(op: Record<string, unknown>, estimate = false) {
  for (const k of PM_FIELDS) if (op[k] !== undefined) throw new Error("BSO forbids paymaster fields");
  for (const k of Object.keys(BSO_ZERO)) if (op[k] === undefined || BigInt(String(op[k])) !== 0n) throw new Error("BSO requires three signed zeros");
  for (const [k, max] of [["callGasLimit", 5_000_000n], ["verificationGasLimit", 1_000_000n]] as const) {
    const n = BigInt(String(op[k] ?? (estimate ? 0 : "invalid"))); if (n < 0n || (!estimate && n === 0n) || n > max) throw new Error("BSO gas bounds");
  }
}
