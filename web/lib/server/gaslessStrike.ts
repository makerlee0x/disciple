/**
 * When a gasless relayer tx is included and reverts, decide whether the *trader* should take a strike.
 *
 * Pattern: ERC-7562 / bundler reputation (and 0x / Flashbots-style sender reputation) only penalize
 * sender-caused validation failures — an invalid signature, a nonce replay, or a malformed permit —
 * not relayer, network, or market-movement faults. A passing exact simulation already proved the
 * signed trade was executable at send-time; a later included revert is usually the market or the
 * relayer (gas cap, slippage, price impact, RPC), not abuse.
 *
 * Keep strikes ONLY for trader-caused selectors. Unknown revert data, out-of-gas, stale quotes, and
 * relayer faults do not strike. Admission fail-closed checks (revoke marker, ban, blocklist) are
 * unchanged.
 */
import { keccak256, slice, toBytes } from "viem";

const selector = (sig: string) => slice(keccak256(toBytes(sig)), 0, 4).toLowerCase();

/** Trader-caused included reverts that still take a strike. */
export const TRADER_FAULT_SELECTORS: ReadonlySet<string> = new Set([
  selector("BadSigner()"),
  selector("BadPermit()"),
  selector("InvalidNonce()"),
  selector("InvalidSigner()"),
  selector("InvalidSignature()"),
]);

export function revertSelector(data: string | null | undefined): string | null {
  if (!data || !/^0x[0-9a-fA-F]{8,}$/i.test(data)) return null;
  return data.slice(0, 10).toLowerCase();
}

/** True only for a known trader-caused revert selector. OOG / slippage / unknown / missing data ⇒ false. */
export function shouldStrikeIncludedRevert(o: { revertData?: string | null; gasUsed?: bigint; gasLimit?: bigint } = {}): boolean {
  const sel = revertSelector(o.revertData);
  return !!sel && TRADER_FAULT_SELECTORS.has(sel);
}

/**
 * Included reverts caused by the market moving between the exact simulation and inclusion (rapid taps on a thin
 * curve, another pilot's buy landing first). Not the trader's fault and not a relayer fault: they still cost the
 * relayer gas (counted by the breaker's loss threshold) but do not count as a breaker "revert", so a couple of
 * fast taps can no longer pause every player's trades for 15 minutes (maker play-test Nov 14 8:18 PM CT).
 */
export const MARKET_MOVE_SELECTORS: ReadonlySet<string> = new Set([
  selector("Slippage()"),
  selector("Expired()"),
  selector("PriceImpactTooHigh(uint256,uint256)"),
  selector("V4TooLittleReceived(uint256,uint256)"),
  selector("V4TooMuchRequested(uint256,uint256)"),
]);
export const isMarketMoveRevert = (data: string | null | undefined): boolean => {
  const sel = revertSelector(data);
  return !!sel && MARKET_MOVE_SELECTORS.has(sel);
};
