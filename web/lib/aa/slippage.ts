/**
 * Client-side slippage clamp for on-chain one-tap sessions. DiscipleSessionPolicy rejects any trade whose
 * minOut is below quote × (1 − maxSlippageBps), so a trade asking for more slippage than the session allows
 * would revert on-chain. We cap it to the session max before building minOut. Pure: no chain, no storage.
 */
export const AUTO_SLIPPAGE_BPS = 100; // = protocol-viem DEFAULT_SLIPPAGE_BPS (Swap settings "Auto")
export const SESSION_SLIPPAGE_LIMIT_BPS = 5000; // policy MAX (50%)
/**
 * Headroom under the session max. The policy re-quotes at EXECUTION and requires minOut ≥ liveQuote × (1 − max);
 * our minOut comes from a warm (≤1.5 s) or safely down-scaled quote, so asking for exactly the max fails with
 * MinOutTooLow whenever the live quote is a hair better (seen on-chain: tx 0xe5fca508…). 50 bps covers that.
 */
export const SESSION_QUOTE_HEADROOM_BPS = 50;
export const sessionCapBps = (max: number) => Math.max(Math.min(10, max), max - SESSION_QUOTE_HEADROOM_BPS);

export type SlippageClamp = {
  /** bps to pass as TradeParams.slippageBps (undefined = protocol default, only when no cap applies) */
  bps: number | undefined;
  capped: boolean;
  /** what the user asked for, resolved (auto ⇒ AUTO_SLIPPAGE_BPS) */
  requestedBps: number;
  sessionMaxBps: number | null;
};

/** requested: Swap settings bps (undefined = auto). sessionMaxBps: active session's max, or null when no session. */
export function clampSlippage(requested: number | undefined, sessionMaxBps: number | null | undefined): SlippageClamp {
  const valid = requested !== undefined && Number.isFinite(requested) && requested > 0;
  const requestedBps = valid ? Math.round(requested!) : AUTO_SLIPPAGE_BPS;
  if (sessionMaxBps == null || !(sessionMaxBps > 0)) return { bps: valid ? requestedBps : undefined, capped: false, requestedBps, sessionMaxBps: null };
  const cap = sessionCapBps(sessionMaxBps);
  if (requestedBps > cap) return { bps: cap, capped: requestedBps > sessionMaxBps, requestedBps, sessionMaxBps };
  return { bps: valid ? requestedBps : undefined, capped: false, requestedBps, sessionMaxBps };
}

/** New session max to offer when capped: the user's request, bounded to the policy limit. */
export const suggestedSessionMax = (c: SlippageClamp) => Math.min(SESSION_SLIPPAGE_LIMIT_BPS, c.requestedBps);
export const pct = (bps: number) => `${+(bps / 100).toFixed(2)}%`;

/**
 * DiscipleSessionPolicy 1.4.1 floor (contracts/src/session/DiscipleSessionPolicy.sol, _checkMinOut): at execution the
 * policy re-quotes (router.quoteUsdgRouteFor for USDG-router trades, curve quoteBuyFor/quoteSellFor direct) and reverts
 * MinOutTooLow(minOut, required) when minOut < quoted × (BPS − maxSlippageBps) / BPS. Pure mirror (integer math).
 */
export const policyMinOutFloor = (quoted: bigint, maxSlippageBps: number) =>
  (quoted * BigInt(10_000 - maxSlippageBps)) / BigInt(10_000);
export const meetsPolicyFloor = (minOut: bigint, quoted: bigint, maxSlippageBps: number) =>
  minOut >= policyMinOutFloor(quoted, maxSlippageBps);

/** floor(√n) for bigint (Newton from the float estimate; exact). */
export function isqrt(n: bigint): bigint {
  const Z = BigInt(0), O = BigInt(1);
  if (n < BigInt(2)) return n < Z ? Z : n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n)))) + O;
  for (;;) { const y = (x + n / x) >> O; if (y >= x) break; x = y; }
  while (x * x > n) x -= O;
  while ((x + O) * (x + O) <= n) x += O;
  return x;
}
/**
 * minOut for a one-tap SESSION trade. The policy re-quotes at execution and needs minOut ≥ live × (1 − max); the
 * router needs live ≥ minOut. So one minOut passes exactly for live ∈ [minOut, minOut / (1 − max)] — a window of fixed
 * width 1 / (1 − max) that a quote taken BEFORE execution can only place, not widen. Old: minOut = quote × (1 − max +
 * 0.5%) ⇒ the whole window sat below the quote: any move ≥ ~0.5 % in the player's FAVOR was refused.
 * Now: centered (geometric) on the expected live range [lo, hi]: minOut = √(lo · hi · (1 − max)). With lo = hi = q:
 * adverse tolerance 1 − √(1 − max), favorable 1/√(1 − max) − 1 (5 %: −2.53 % / +2.60 %; 15 %: −7.80 % / +8.47 %;
 * 30 %: −16.33 % / +19.52 %; 50 %: −29.29 % / +41.42 %).
 */
export function sessionWindowMinOut(lo: bigint, hi: bigint, maxSlippageBps: number): bigint {
  const m = Math.min(SESSION_SLIPPAGE_LIMIT_BPS, Math.max(0, Math.round(maxSlippageBps)));
  return isqrt((lo * hi * BigInt(10_000 - m)) / BigInt(10_000));
}
