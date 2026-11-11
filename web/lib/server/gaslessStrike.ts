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
