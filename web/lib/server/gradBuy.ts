/**
 * Graduating-buy detection for the relay / paymaster (#106 + steep-curve floor): a buy whose quote reaches the
 * remaining quote to graduation runs Migration + 16 floor bands (≈ 2.56M execution gas) and gets GRAD_GAS_CAPS
 * (5M call / 6M total) instead of GAS_CAPS. Checked ON-CHAIN, and only for ops that are above GAS_CAPS (normal ops
 * pay no extra RPC):
 *  - the buy targets a real curve: Launchpad.curveOf(curve.token()) == target (a fake contract can't claim it), or
 *    our DiscipleRouter (buyWithUsdg / buyExactIn) with Launchpad.curveOf(token) != 0;
 *  - the curve is not graduated and curve.quoteBuy(quoteIn).graduates (quoteIn ≥ remaining to graduation, fee-aware).
 * Reads are injected (GradReads) so the rule is unit-tested without RPC (scripts/test-relay-policy.mts).
 */
import type { Address, PublicClient } from "viem";
import { bondingCurveAbi as curveAbi } from "../abi/BondingCurve";
import { launchpadAbi } from "../abi/Launchpad";
import { buyIntents, capsForOp, exceedsCaps, GAS_CAPS, type GasCaps, type GasFields } from "../aa/gasPolicy";
import { DEPLOYMENTS, ZERO } from "../chains";

export type GradReads = {
  router?: string;
  curveOf(token: string): Promise<string>;
  tokenOf(curve: string): Promise<string>;
  graduated(curve: string): Promise<boolean>;
  /** curve.quoteBuy(quoteIn).graduates */
  graduates(curve: string, quoteIn: bigint): Promise<boolean>;
};
const isZero = (a: string | undefined) => !a || /^0x0{40}$/i.test(a);

export async function isGradBuyOp(callData: string, r: GradReads): Promise<boolean> {
  for (const b of buyIntents(callData)) {
    try {
      let curve: string;
      if (b.kind === "router") {
        if (!r.router || b.to !== r.router.toLowerCase() || !b.token) continue;
        curve = (await r.curveOf(b.token)).toLowerCase();
      } else {
        const tok = await r.tokenOf(b.to);
        if (isZero(tok) || (await r.curveOf(tok)).toLowerCase() !== b.to) continue;
        curve = b.to;
      }
      if (isZero(curve) || (await r.graduated(curve))) continue;
      if (await r.graduates(curve, b.quoteIn)) return true;
    } catch { /* unreadable ⇒ not a graduating buy (normal caps) */ }
  }
  return false;
}

/** Caps the relay applies: launch ⇒ LAUNCH_GAS_CAPS; above GAS_CAPS and a verified graduating buy ⇒ GRAD_GAS_CAPS; else GAS_CAPS. */
export async function relayCaps(op: GasFields & { callData?: string }, launchers: string[], reads: GradReads): Promise<GasCaps> {
  const caps = capsForOp(op, launchers);
  if (caps !== GAS_CAPS || !op.callData || !exceedsCaps(op, GAS_CAPS)) return caps;
  return capsForOp(op, launchers, { gradBuy: await isGradBuyOp(op.callData, reads) });
}

/** GradReads against a chain's Launchpad + DiscipleRouter. */
export function chainGradReads(pc: PublicClient, chainId: number): GradReads {
  const d = DEPLOYMENTS[chainId];
  const lp = d?.launchpad && d.launchpad !== ZERO ? (d.launchpad as Address) : undefined;
  return {
    router: d?.router && d.router !== ZERO ? d.router : undefined,
    async curveOf(token) { if (!lp) return ZERO; return pc.readContract({ address: lp, abi: launchpadAbi, functionName: "curveOf", args: [token as Address] }); },
    tokenOf: (curve) => pc.readContract({ address: curve as Address, abi: curveAbi, functionName: "token" }),
    graduated: (curve) => pc.readContract({ address: curve as Address, abi: curveAbi, functionName: "graduated" }),
    async graduates(curve, quoteIn) { return (await pc.readContract({ address: curve as Address, abi: curveAbi, functionName: "quoteBuy", args: [quoteIn] })).graduates; },
  };
}
