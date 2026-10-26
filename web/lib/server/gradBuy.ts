/**
 * Graduating-buy detection for the relay / paymaster (#106 + steep-curve floor): a buy whose quote reaches the
 * remaining quote to graduation runs Migration + 16 floor bands (≈ 2.76M execution gas at 6-dec USDG) and gets
 * GRAD_GAS_CAPS (5M call / 6M total) instead of GAS_CAPS. Checked ON-CHAIN, and only for ops that are above GAS_CAPS
 * (normal ops pay no extra RPC). Rules (audit r106 Lows, gradBuy.ts:28/:40, gasPolicy.ts:132):
 *  - exact op shape only (audit r106 round 2/3): [usdg.approve(paymaster)?, LoginGate.attest?,
 *    ReferralRegistry.tryAttribute(sender, ·)?, approve(quoteToken, curve|router)*, buy] with the buy as the literal
 *    last call (gasPolicy.gradBuyCandidate); prefix calls only on OUR configured LoginGate / ReferralRegistry
 *    (DEPLOYMENTS[chainId], value 0, exact selector, canonical encoding); every approve must be on the curve's quote
 *    token (checked here) with the buy's spender; ops with more than MAX_GRAD_BUY_INTENTS buys are rejected before
 *    any read ⇒ bounded work per op;
 *  - the buy targets a real curve: Launchpad.curveOf(curve.token()) == target (a fake contract can't claim it), or
 *    our DiscipleRouter (buyWithUsdg / buyExactIn) with Launchpad.curveOf(token) != 0;
 *  - units: router buyWithUsdg's amount is USDG. USDG-quoted curve ⇒ compared with curve.quoteBuy directly. Any other
 *    quote (STRATEGY …) ⇒ converted ON-CHAIN exactly as the router executes it (router.quoteUsdgQuoteSwap(quote, true,
 *    usdgIn), lib/trade/gradNeed) and the curve's quoteBuy(converted ⊕ GRAD_QUOTE_MARGIN_BPS).graduates decides; the
 *    in-op approves must then be on USDG (to the router) and the funding check is on USDG. Never a client flag;
 *  - the curve is not graduated, curve.quoteBuy(quoteIn).graduates, and the sender can actually pay:
 *    balanceOf(sender) ≥ quoteIn and allowance(sender → curve/router) ≥ quoteIn, both in the POST-APPROVE state the
 *    buy sees: only approves run before it, so balance = the pre-op balance and allowance = the last in-op approve's
 *    amount (the pre-op allowance only when the op has no approve) — so an op can't claim the wide caps for a buy
 *    that would revert.
 * Reads are batched (one multicall per step, ≤ 3 steps; 4 for buyWithUsdg on a non-USDG curve: + the swap quote) and injected (GradReads) so the rule is unit-tested without
 * RPC (scripts/test-relay-policy.mts).
 */
import type { Address, PublicClient } from "viem";
import { erc20Abi } from "viem";
import { bondingCurveAbi as curveAbi } from "../abi/BondingCurve";
import { launchpadAbi } from "../abi/Launchpad";
import { capsForOp, exceedsCaps, GAS_CAPS, gradBuyCandidate, type GasCaps, type GasFields } from "../aa/gasPolicy";
import { DEPLOYMENTS, ZERO } from "../chains";
import { usdgToQuote, withGradMargin } from "../trade/gradNeed";

export type CurveInfo = { token: string; quote: string; graduated: boolean };
export type GradCheck = { curveOf: string; graduates: boolean; balance: bigint; allowance: bigint };
export type GradReads = {
  router?: string;
  usdg?: string;
  /** DisciplePaymaster: a USDG-gas op's leading usdg.approve(paymaster) is allowed only when the op names it. */
  paymaster?: string;
  /** Optional grad-buy prefix targets (protocol-viem referralCall / pve ensurePveLogin): only these addresses count. */
  referralRegistry?: string;
  loginGate?: string;
  /** Launchpad.curveOf(token) (router path, step 1). */
  curveOf(token: string): Promise<string>;
  /** One batch: curve.token(), curve.quote(), curve.graduated(). */
  curveInfo(curve: string): Promise<CurveInfo>;
  /** One batch: Launchpad.curveOf(token), curve.quoteBuy(quoteIn).graduates, payToken.balanceOf(owner), payToken.allowance(owner, spender). */
  check(a: { token: string; curve: string; quoteIn: bigint; payToken: string; owner: string; spender: string }): Promise<GradCheck>;
  /** router.quoteUsdgQuoteSwap(quote, true, usdgIn).amountOut — the quote a pre-grad buyWithUsdg delivers to a non-USDG
   *  curve. Absent ⇒ buyWithUsdg on a non-USDG curve is never upgraded. */
  usdgToQuote?(quote: string, usdgIn: bigint): Promise<bigint>;
};
const isZero = (a: string | undefined) => !a || /^0x0{40}$/i.test(a);
const eq = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** `opPaymaster`: the op's paymaster field (USDG-gas ops); its leading approve is skipped only if it is r.paymaster. */
export async function isGradBuyOp(callData: string, sender: string | undefined, r: GradReads, opPaymaster?: string): Promise<boolean> {
  const pm = opPaymaster && eq(opPaymaster, r.paymaster) ? { usdg: r.usdg, paymaster: r.paymaster } : {};
  const cand = gradBuyCandidate(callData, { ...pm, referralRegistry: r.referralRegistry, loginGate: r.loginGate, sender });
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
    if (b.unit === "usdg" && !r.usdg) return false;
    // USDG amount on a non-USDG curve (STRATEGY …): the router swaps USDG → quote first; convert on-chain the same way
    const viaSwap = b.unit === "usdg" && !eq(info.quote, r.usdg);
    if (viaSwap && !r.usdgToQuote) return false;
    const payToken = viaSwap ? r.usdg! : info.quote;   // what the buy actually spends (balance + allowance checked on it)
    if (cand.quoteToken && !eq(cand.quoteToken, payToken)) return false;   // in-op approves must be on the spent token
    let curveIn = b.quoteIn;
    if (viaSwap) {
      const q = await r.usdgToQuote!(info.quote, b.quoteIn);
      if (q <= BigInt(0)) return false;
      curveIn = withGradMargin(q);
    }
    const spender = b.kind === "router" ? b.to.toLowerCase() : curve;      // == every in-op approve's spender (candidate)
    const c = await r.check({ token: info.token, curve, quoteIn: curveIn, payToken, owner: sender, spender });
    if (!eq(c.curveOf, curve) || !c.graduates) return false;
    // post-approve state: approves don't move the balance; the last in-op approve SETS the allowance
    const allowance = cand.approvals.length ? cand.approvals[cand.approvals.length - 1].amount : c.allowance;
    return c.balance >= b.quoteIn && allowance >= b.quoteIn;
  } catch { return false; /* unreadable ⇒ not a graduating buy (normal caps) */ }
}

/** Caps the relay applies: launch ⇒ LAUNCH_GAS_CAPS; above GAS_CAPS and a verified graduating buy ⇒ GRAD_GAS_CAPS; else GAS_CAPS. */
export async function relayCaps(op: GasFields & { callData?: string; sender?: string }, launchers: string[], reads: GradReads): Promise<GasCaps> {
  const caps = capsForOp(op, launchers);
  if (caps !== GAS_CAPS || !op.callData || !exceedsCaps(op, GAS_CAPS)) return caps;
  return capsForOp(op, launchers, { gradBuy: await isGradBuyOp(op.callData, op.sender, reads, op.paymaster) });
}

/** Multicall3 (canonical address; deployed on Robinhood Chain testnet 46630). */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/**
 * GradReads against a chain's Launchpad + DiscipleRouter (each step = one Multicall3 eth_call). `over`: the caller's
 * own paymaster / USDG (relay: allowedPaymaster(); paymaster quote: its cfg) — else DEPLOYMENTS[chainId].
 */
export function chainGradReads(pc: PublicClient, chainId: number, over: { paymaster?: string; usdg?: string } = {}): GradReads {
  const d = DEPLOYMENTS[chainId];
  const lp = d?.launchpad && d.launchpad !== ZERO ? (d.launchpad as Address) : undefined;
  const mc = <T extends readonly unknown[]>(contracts: readonly unknown[]) =>
    pc.multicall({ contracts: contracts as never, allowFailure: false, multicallAddress: MULTICALL3 }) as unknown as Promise<T>;
  return {
    router: d?.router && d.router !== ZERO ? d.router : undefined,
    usdg: over.usdg ?? (d?.usdg && d.usdg !== ZERO ? d.usdg : undefined),
    paymaster: over.paymaster ?? (d?.paymaster && d.paymaster !== ZERO ? d.paymaster : undefined),
    referralRegistry: d?.referralRegistry && d.referralRegistry !== ZERO ? d.referralRegistry : undefined,
    loginGate: d?.loginGate && d.loginGate !== ZERO ? d.loginGate : undefined,
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
    async usdgToQuote(quote, usdgIn) {
      if (!d?.router || d.router === ZERO) return BigInt(0);
      return usdgToQuote(pc, d.router as Address, quote as Address, usdgIn);
    },
  };
}
