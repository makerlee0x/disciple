/**
 * Launch pair whitelist, relay side (lib/pairWhitelist). The bundler route refuses an op that launches a rocket paired
 * with a coin outside the whitelist, before anything is relayed or forwarded. This gates launches made through
 * disciple.vip only: the Launchpad itself still accepts any quote, so a direct contract call bypasses it (a contract
 * allowlist is FLOW's call).
 * Pure: decodes the account's execute / executeBatch calldata (lib/aa/gasPolicy accountCalls) and every launch entry
 * point's LaunchParams (launch, launchCoin, launchWithMode, AnonLauncher.launchAnon, DiscipleRouter.launchWithUsdg).
 */
import { decodeFunctionData, type Hex } from "viem";
import { anonLauncherAbi } from "../abi/AnonLauncher";
import { discipleRouterAbi } from "../abi/DiscipleRouter";
import { launchpadAbi } from "../abi/Launchpad";
import { isWhitelistedQuote } from "../pairWhitelist";
import { LAUNCH_SELECTORS, accountCalls } from "./gasPolicy";

const LAUNCH_ABIS = [launchpadAbi, anonLauncherAbi, discipleRouterAbi] as const;

/** Plain refusal for a launch outside the whitelist (no ids, no addresses). */
export const PAIR_NOT_ALLOWED_MSG = "That pair isn't available. Pick one of the listed coins.";

/**
 * Quote of every launch call in an op's callData. [] = no launch call; null = a launch selector whose arguments didn't
 * decode (treated as not allowed: a launch we can't read is never relayed).
 */
export function launchQuotes(callData: string): string[] | null {
  const calls = accountCalls(callData);
  if (!calls) return [];
  const out: string[] = [];
  for (const c of calls) {
    if (!LAUNCH_SELECTORS.has(c.data.slice(0, 10).toLowerCase())) continue;
    let quote: string | undefined;
    for (const abi of LAUNCH_ABIS) {
      try {
        const d = decodeFunctionData({ abi, data: c.data as Hex });
        quote = String((d.args?.[0] as { quote?: unknown } | undefined)?.quote ?? "");
        break;
      } catch { /* another contract's selector */ }
    }
    if (!quote) return null;
    out.push(quote);
  }
  return out;
}

/** null when the op may go; else the plain refusal. */
export function launchPairRefusal(callData: string, chainId: number): string | null {
  const qs = launchQuotes(callData);
  if (qs === null) return PAIR_NOT_ALLOWED_MSG;
  return qs.every((q) => isWhitelistedQuote(q, chainId)) ? null : PAIR_NOT_ALLOWED_MSG;
}
