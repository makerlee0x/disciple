/**
 * Graduating-buy detection for the relay / paymaster (#106 + steep-curve floor): a buy whose quote reaches the
 * remaining quote to graduation runs Migration + 16 floor bands (≈ 2.76M execution gas at 6-dec USDG) and gets
 * GRAD_GAS_CAPS (5M call / 6M total) instead of GAS_CAPS. Checked ON-CHAIN, and only for ops that are above GAS_CAPS
 * (normal ops pay no extra RPC). Rules (audit r106 Lows, gradBuy.ts:28/:40, gasPolicy.ts:132):
 *  - only ONE buy is considered: the op's last non-approve call (gasPolicy.gradBuyCandidate); ops with more than
 *    MAX_GRAD_BUY_INTENTS buys are never upgraded ⇒ bounded work per op;
 *  - the buy targets a real curve: Launchpad.curveOf(curve.token()) == target (a fake contract can't claim it), or
 *    our DiscipleRouter (buyWithUsdg / buyExactIn) with Launchpad.curveOf(token) != 0;
 *  - units: router buyWithUsdg's amount is USDG; it is only compared with curve.quoteBuy when the curve's quote is
 *    USDG (else no upgrade — no price conversion on the hot path);
 *  - the curve is not graduated, curve.quoteBuy(quoteIn).graduates, and the sender can actually pay:
 *    balanceOf(sender) ≥ quoteIn and allowance(sender → curve/router) ≥ quoteIn (an approve earlier in the same op
 *    counts) — so an op can't claim the wide caps for a buy that would revert.
 * Reads are batched (one multicall per step, ≤ 3 steps) and injected (GradReads) so the rule is unit-tested without
 * RPC (scripts/test-relay-policy.mts).
 */
import type { Address, PublicClient } from "viem";
import { erc20Abi } from "viem";
import { bondingCurveAbi as curveAbi } from "../abi/BondingCurve";
import { launchpadAbi } from "../abi/Launchpad";
import { capsForOp, exceedsCaps, GAS_CAPS, gradBuyCandidate, type GasCaps, type GasFields } from "../aa/gasPolicy";
import { DEPLOYMENTS, ZERO } from "../chains";

export type CurveInfo = { token: string; quote: string; graduated: boolean };
export type GradCheck = { curveOf: string; graduates: boolean; balance: bigint; allowance: bigint };
export type GradReads = {
  router?: string;
  usdg?: string;
  /** Launchpad.curveOf(token) (router path, step 1). */
  curveOf(token: string): Promise<string>;
  /** One batch: curve.token(), curve.quote(), curve.graduated(). */
  curveInfo(curve: string): Promise<CurveInfo>;
  /** One batch: Launchpad.curveOf(token), curve.quoteBuy(quoteIn).graduates, payToken.balanceOf(owner), payToken.allowance(owner, spender). */
  check(a: { token: string; curve: string; quoteIn: bigint; payToken: string; owner: string; spender: string }): Promise<GradCheck>;
};
const isZero = (a: string | undefined) => !a || /^0x0{40}$/i.test(a);
const eq = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export async function isGradBuyOp(callData: string, sender: string | undefined, r: GradReads): Promise<boolean> {
  const cand = gradBuyCandidate(callData);
  if (!cand || !sender || isZero(sender)) return false;
  const b = cand.intent;
  try {
    let curve: string;
    if (b.kind === "router") {
      if (!r.router || !eq(b.to, r.router) || !b.token) return false;
      curve = (await r.curveOf(b.token)).toLowerCase();
      if (isZero(curve)) return false;
    } else curve = b.to.toLowerCase();
    const info = await r.curveInfo(curve);
    if (isZero(info.token) || info.graduated) return false;
    if (b.kind === "router" && !eq(info.token, b.token)) return false;
    if (b.unit === "usdg" && (!r.usdg || !eq(info.quote, r.usdg))) return false;   // USDG amount vs a non-USDG curve: skip
    const spender = b.kind === "router" ? b.to.toLowerCase() : curve;
    const c = await r.check({ token: info.token, curve, quoteIn: b.quoteIn, payToken: info.quote, owner: sender, spender });
    if (!eq(c.curveOf, curve) || !c.graduates) return false;
    if (c.balance < b.quoteIn) return false;
    let allowance = c.allowance;
    for (const a of cand.approvals) if (eq(a.token, info.quote) && eq(a.spender, spender)) allowance = a.amount;   // last approve wins
    return allowance >= b.quoteIn;
  } catch { return false; /* unreadable ⇒ not a graduating buy (normal caps) */ }
}

/** Caps the relay applies: launch ⇒ LAUNCH_GAS_CAPS; above GAS_CAPS and a verified graduating buy ⇒ GRAD_GAS_CAPS; else GAS_CAPS. */
export async function relayCaps(op: GasFields & { callData?: string; sender?: string }, launchers: string[], reads: GradReads): Promise<GasCaps> {
  const caps = capsForOp(op, launchers);
  if (caps !== GAS_CAPS || !op.callData || !exceedsCaps(op, GAS_CAPS)) return caps;
  return capsForOp(op, launchers, { gradBuy: await isGradBuyOp(op.callData, op.sender, reads) });
}

/** Multicall3 (canonical address; deployed on Robinhood Chain testnet 46630). */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/** GradReads against a chain's Launchpad + DiscipleRouter (each step = one Multicall3 eth_call). */
export function chainGradReads(pc: PublicClient, chainId: number): GradReads {
  const d = DEPLOYMENTS[chainId];
  const lp = d?.launchpad && d.launchpad !== ZERO ? (d.launchpad as Address) : undefined;
  const mc = <T extends readonly unknown[]>(contracts: readonly unknown[]) =>
    pc.multicall({ contracts: contracts as never, allowFailure: false, multicallAddress: MULTICALL3 }) as unknown as Promise<T>;
  return {
    router: d?.router && d.router !== ZERO ? d.router : undefined,
    usdg: d?.usdg && d.usdg !== ZERO ? d.usdg : undefined,
    async curveOf(token) { if (!lp) return ZERO; return pc.readContract({ address: lp, abi: launchpadAbi, functionName: "curveOf", args: [token as Address] }); },
    async curveInfo(curve) {
      const c = { address: curve as Address, abi: curveAbi } as const;
      const [token, quote, graduated] = await mc<[string, string, boolean]>([
        { ...c, functionName: "token" }, { ...c, functionName: "quote" }, { ...c, functionName: "graduated" },
      ]);
      return { token, quote, graduated };
    },
    async check({ token, curve, quoteIn, payToken, owner, spender }) {
      if (!lp) return { curveOf: ZERO, graduates: false, balance: BigInt(0), allowance: BigInt(0) };
      const [curveOf, qb, balance, allowance] = await mc<[string, { graduates: boolean }, bigint, bigint]>([
        { address: lp, abi: launchpadAbi, functionName: "curveOf", args: [token as Address] },
        { address: curve as Address, abi: curveAbi, functionName: "quoteBuy", args: [quoteIn] },
        { address: payToken as Address, abi: erc20Abi, functionName: "balanceOf", args: [owner as Address] },
        { address: payToken as Address, abi: erc20Abi, functionName: "allowance", args: [owner as Address, spender as Address] },
      ]);
      return { curveOf, graduates: qb.graduates, balance, allowance };
    },
  };
}
