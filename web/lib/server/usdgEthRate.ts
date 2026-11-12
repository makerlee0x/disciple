/**
 * USDG-per-ETH rate helpers. These are the same rateFromEnv / unmarkedRate functions that lived in
 * paymasterCore.ts (deleted with the 4337 path). Gasless withdrawals reuse this exact source: PAYMASTER_RATE
 * (USDG base units per 1 ETH, integer) wins; else PAYMASTER_USD_PER_ETH (decimal string) scaled by the token's
 * on-chain decimals. unmarkedRate is 1.0x (no markup).
 */
export function rateFromEnv(env: { PAYMASTER_RATE?: string; PAYMASTER_USD_PER_ETH?: string }, usdgDecimals: number): bigint {
  if (env.PAYMASTER_RATE) {
    if (!/^\d+$/.test(env.PAYMASTER_RATE)) throw new Error("PAYMASTER_RATE must be an integer (USDG base units per 1 ETH)");
    return BigInt(env.PAYMASTER_RATE);
  }
  const usd = env.PAYMASTER_USD_PER_ETH || "";
  const m = /^(\d+)(?:\.(\d+))?$/.exec(usd);
  if (!m) throw new Error("set PAYMASTER_RATE or PAYMASTER_USD_PER_ETH");
  const frac = (m[2] || "").slice(0, usdgDecimals).padEnd(usdgDecimals, "0");
  return BigInt(m[1]) * BigInt(10) ** BigInt(usdgDecimals) + (usdgDecimals ? BigInt(frac || "0") : BigInt(0));
}

/** No gas markup: use the price-source rate unchanged (1.0x). */
export function unmarkedRate(baseRate: bigint): bigint { return baseRate; }
