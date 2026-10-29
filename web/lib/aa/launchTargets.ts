/**
 * Contracts whose launch calls get the launch gas caps (lib/aa/gasPolicy LAUNCH_GAS_CAPS): the Launchpad, the
 * AnonLauncher(s) and (v5) the DiscipleRouter, for launchWithUsdg. Only the launch selectors (gasPolicy
 * LAUNCH_SELECTORS) count on these targets; any other router call (trades, swaps, claims) keeps GAS_CAPS.
 * v2 is listed explicitly so private launches keep working whichever AnonLauncher lib/anon defaults to.
 */
import { ANON_ADDONS } from "../anon";
import { ACTIVE_CHAIN, DEPLOYMENTS, ZERO } from "../chains";

const ANON_V2: Record<number, string> = { 46630: "0x06f31a8877c8e025cc55faffb20cba8486cca527" };
export function launchTargets(chainId: number = ACTIVE_CHAIN.id): string[] {
  const d = DEPLOYMENTS[chainId];
  return [d?.launchpad, d?.router, ANON_ADDONS[chainId]?.anonLauncher, ANON_V2[chainId]].filter((a): a is string => !!a && a !== ZERO).map((a) => a.toLowerCase());
}
