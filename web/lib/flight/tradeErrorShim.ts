/**
 * SHIM (GAME graduation fix, item 3): classify a failed trade into a stable code so the UI can show plain copy.
 * TODO(SITE grad/gas PR, branch site/grad-any-pair): SITE will export a stable code
 *   'PRICE_IMPACT' | 'MIN_OUT' | 'OUT_OF_GAS' | 'OTHER' from protocol-viem / friendlyError. When it lands, replace the body of
 *   classifyTradeError with a pass-through of SITE's code and delete the string / shape matching below.
 * Until then this is best-effort from what the current client returns (ProtocolError.code = the decoded revert name, or a
 * transport code; .message = friendlyError's copy). SITE's existing strings are left untouched; GAME maps the code to its
 * own plain copy (lib/flight/tradeGate GAME_COPY).
 * Pure (no viem import) so scripts/test-grad-fix.mjs can load it.
 */
import type { TradeErrorCode } from "./tradeGate";

type ErrLike = { code?: unknown; message?: unknown; name?: unknown; extra?: { revertData?: unknown } } | string | null | undefined;
export type ClassifyCtx = { /** a buy that is expected to graduate the curve (GRADUATE button / amount ≥ the exact graduating buy) */ graduating?: boolean };

const IMPACT = /PriceImpactTooHigh|price impact too high|router cap/i;
const MINOUT_CODE = /^(MinOutTooLow|Slippage|V4TooLittleReceived|V4TooMuchRequested|PreExecHookReverted)$/;
const MINOUT_MSG = /MinOutTooLow|PreExecHookReverted|price moved|slippage|too little received/i;
const GAS_MSG = /out of gas|outofgas|AA95|AA40|AA41|gas limit|intrinsic gas|gas too low|exceeds block gas/i;

/** PLAIN codes from today's errors. Order matters: impact > min-out > gas > other. */
export function classifyTradeError(e: unknown, ctx: ClassifyCtx = {}): TradeErrorCode {
  const x = e as ErrLike;
  const code = typeof x === "object" && x && typeof x.code === "string" ? x.code : "";
  const msg = typeof x === "string" ? x : typeof x === "object" && x ? String(x.message ?? "") : "";
  if (code === "PriceImpactTooHigh" || IMPACT.test(msg)) return "PRICE_IMPACT";
  if (MINOUT_CODE.test(code) || MINOUT_MSG.test(msg)) return "MIN_OUT";
  if (/^(OutOfGas|OUT_OF_GAS)$/.test(code) || GAS_MSG.test(msg)) return "OUT_OF_GAS";
  // out-of-gas comes back as an EMPTY revert today (SITE): friendlyError → code "Reverted" with no decodable reason
  const rd = typeof x === "object" && x ? x.extra?.revertData : undefined;
  if (code === "Reverted" && (rd === undefined || rd === "0x" || rd === "")) return "OUT_OF_GAS";
  // a graduating buy that failed its pre-send check / bundle (the 1.8M vs ~2.7M gas case) ⇒ the gas line
  if (ctx.graduating && /^(Estimate|Bundler|Reverted|FailedOp)$/.test(code)) return "OUT_OF_GAS";
  return "OTHER";
}
