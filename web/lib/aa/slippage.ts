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
