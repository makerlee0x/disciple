/** Explicit opt-in only. This policy is testnet-only; Production can never enable it. */
export const browserBso = (chainId: number) => chainId === 46630 && process.env.NEXT_PUBLIC_GAS_SPONSORSHIP_MODE === "bso" && process.env.NEXT_PUBLIC_VERCEL_ENV !== "production";
export const BSO_ZERO = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, preVerificationGas: 0n };
const PM_FIELDS = ["paymaster", "paymasterData", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit", "paymasterAndData"];
/** Apply BEFORE signing; never mutate an already signed operation. */
export function bsoUnsigned<T extends Record<string, unknown>>(op: T): T & typeof BSO_ZERO {
  const clean = { ...op, ...BSO_ZERO };
  for (const k of PM_FIELDS) delete (clean as Record<string, unknown>)[k];
  return clean;
}
export function checkBso(op: Record<string, unknown>) {
  for (const k of PM_FIELDS) if (op[k] !== undefined) throw new Error("BSO forbids paymaster fields");
  for (const k of Object.keys(BSO_ZERO)) if (op[k] === undefined || BigInt(String(op[k])) !== 0n) throw new Error("BSO requires three signed zeros");
  for (const [k, max] of [["callGasLimit", 5_000_000n], ["verificationGasLimit", 1_000_000n]] as const) {
    const n = BigInt(String(op[k])); if (n <= 0n || n > max) throw new Error("BSO gas bounds");
  }
}
