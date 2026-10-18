/**
 * Session policy for one-tap trading. Every userOp the session signs is checked here first:
 *  - targets: Launchpad, DiscipleRouter, TrampWallManager, Launchpad-registered bonding curves, test-token mint,
 *    and ERC-20 approve() — approve only to those spenders.
 *  - spend limit: per-token cap on approved amounts for the session (we approve the exact trade size, batched).
 *  - expiry: default 24h, then the owner must sign again.
 * NOTE: LightAccount v2 has no on-chain permission modules, so this policy is enforced by the client that holds
 * the session key; see PR notes (Modular Account v2 + allowlist/limit modules for on-chain enforcement).
 */
import { decodeFunctionData, parseAbi, type Address, type PublicClient } from "viem";
import { bondingCurveAbi, launchpadAbi } from "../abi";
import type { Call } from "./core";

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const erc20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)", "function mint(address to, uint256 amount)"]);
/** Claim entry points (msg.sender receives the funds; no args that redirect them). */
const claimAbi = parseAbi([
  "function claimCreatorFees(address token) returns (uint256)",
  "function claimReferrerFees(address quote) returns (uint256)",
  "function claimCreatorTokenFees(address token) returns (uint256)",
]);
const notifierAbi = parseAbi(["function deposit(address wallet, uint256 amount) returns (uint256)", "function withdraw(uint256[] ids) returns (uint256)"]);
/** Σ amount of the batch's notifier.deposit calls (the only approve amount to the notifier this policy accepts). */
export function depositTotal(calls: Call[], notifier?: Address): bigint {
  let n = BigInt(0);
  if (!notifier) return n;
  for (const c of calls) {
    if (c.to.toLowerCase() !== notifier.toLowerCase()) continue;
    try { const d = decodeFunctionData({ abi: notifierAbi, data: c.data }); if (d.functionName === "deposit") n += d.args[1] as bigint; } catch { /* other */ }
  }
  return n;
}

export type PolicyCfg = {
  launchpad: Address; router: Address; trampWallManager: Address;
  mintable: Address[];
  /** per-token cap in raw units for spend (quote) tokens; tokens not listed use defaultLimit */
  limits?: Record<string, bigint>;
  defaultLimit: bigint;
  /** Tokens whose approvals count toward the spend limit (quote assets). Rocket-token approvals (sells) are uncapped. */
  spendTokens?: Address[];
  /**
   * USDG (policy 1.3.0 rule, mirrored): a USDG approve is allowed ONLY to the router and ONLY for exactly the batch's
   * buyWithUsdg total (0 = revoke ok). No standalone USDG approves to curves / tramps.
   */
  usdg?: Address;
  /** FeeRouter: only the claim selectors (creator / referrer / redeploy creator-token) — they move funds TO the caller. */
  feeRouter?: Address;
  /** REDEPLOY: UsdgDepositNotifier — deposit(account, amt) with an exact paired approve, and withdraw(ids). */
  depositNotifier?: Address;
};
export type SessionState = { expiresAt: number; spent: Record<string, string> };

export class PolicyError extends Error { code = "SessionPolicy"; }

const lc = (a: string) => a.toLowerCase();

/** Curve-address verdicts survive across trades (a curve stays a curve): no 2 reads per pre-grad trade. */
const curveOk = new Map<string, boolean>();
export async function checkCalls(pc: PublicClient, cfg: PolicyCfg, s: SessionState, calls: Call[], account: Address): Promise<Record<string, bigint>> {
  if (Date.now() > s.expiresAt) throw new PolicyError("Session expired — sign in again to keep one-tap trading.");
  const fixed = new Set([cfg.launchpad, cfg.router, cfg.trampWallManager].map(lc));
  const usdgNeed = cfg.usdg ? usdgBuyTotal(calls, cfg.router) : BigInt(0);
  async function isCurve(a: Address) {
    if (curveOk.has(lc(a))) return curveOk.get(lc(a))!;
    let ok = false;
    try {
      const token = await pc.readContract({ address: a, abi: bondingCurveAbi, functionName: "token" }) as Address;
      const c = await pc.readContract({ address: cfg.launchpad, abi: launchpadAbi, functionName: "curveOf", args: [token] }) as Address;
      ok = lc(c) === lc(a);
    } catch { ok = false; }
    curveOk.set(lc(a), ok);
    return ok;
  }
  const delta: Record<string, bigint> = {};
  for (const c of calls) {
    if (c.value && c.value > BigInt(0)) throw new PolicyError("Session can't send ETH.");
    const to = lc(c.to);
    if (fixed.has(to)) continue;
    if (cfg.feeRouter && to === lc(cfg.feeRouter)) {
      try { decodeFunctionData({ abi: claimAbi, data: c.data }); continue; } catch { throw new PolicyError(`Session can't call ${c.to}.`); }
    }
    if (cfg.usdgDepositNotifier && to === lc(cfg.usdgDepositNotifier)) {
      let d: { functionName: string; args?: readonly unknown[] };
      try { d = decodeFunctionData({ abi: notifierAbi, data: c.data }); } catch { throw new PolicyError(`Session can't call ${c.to}.`); }
      if (d.functionName === "deposit" && lc(d.args![0] as string) !== lc(account)) throw new PolicyError("Deposits must be for this account.");
      continue;
    }
    let fn: { functionName: string; args?: readonly unknown[] } | null = null;
    try { fn = decodeFunctionData({ abi: erc20, data: c.data }); } catch { fn = null; }
    if (fn?.functionName === "approve") {
      const [spender, amt] = fn.args as [Address, bigint];
      // USDG → router must be exact (policy 1.3.0); USDG → anything else is owner-only (sessionEligible routes it)
      if (cfg.usdg && to === lc(cfg.usdg) && lc(spender) === lc(cfg.router) && usdgNeed > BigInt(0) && amt !== BigInt(0) && amt !== usdgNeed)
        throw new PolicyError("USDG approve must equal this trade's USDG amount.");
      if (cfg.usdgDepositNotifier && lc(spender) === lc(cfg.usdgDepositNotifier)) {
        const need = depositTotal(calls, cfg.usdgDepositNotifier);
        if (amt !== BigInt(0) && amt !== need) throw new PolicyError("Deposit approve must equal the deposit amount.");
      } else if (!fixed.has(lc(spender)) && !(await isCurve(spender))) throw new PolicyError(`Session can't approve ${spender}.`);
      delta[to] = (delta[to] ?? BigInt(0)) + amt;
      continue;
    }
    if (fn?.functionName === "mint" && cfg.mintable.map(lc).includes(to) && lc((fn.args as [Address])[0]) === lc(account)) continue;
    if (await isCurve(c.to)) continue;
    throw new PolicyError(`Session can't call ${c.to}.`);
  }
  const capped = cfg.spendTokens?.map(lc);
  for (const [t, d] of Object.entries(delta)) {
    if (capped && !capped.includes(t)) continue;
    const lim = cfg.limits?.[t] ?? cfg.defaultLimit;
    const used = BigInt(s.spent[t] ?? "0") + d;
    if (used > lim) throw new PolicyError("Session spend limit reached — sign in again to raise it.");
  }
  return delta;
}

const buyWithUsdgAbi = parseAbi(["function buyWithUsdg(address token, uint256 usdgIn, uint256 minTokensOut, uint256 deadline)"]);
/** Σ usdgIn of the batch's router.buyWithUsdg calls (= the only USDG approve amount policy 1.3.0 accepts). */
export function usdgBuyTotal(calls: Call[], router: Address): bigint {
  let n = BigInt(0);
  for (const c of calls) {
    if (lc(c.to) !== lc(router)) continue;
    try { const d = decodeFunctionData({ abi: buyWithUsdgAbi, data: c.data }); n += d.args[1]; } catch { /* other router call */ }
  }
  return n;
}

export function recordSpend(s: SessionState, delta: Record<string, bigint>): SessionState {
  const spent = { ...s.spent };
  for (const [t, d] of Object.entries(delta)) spent[t] = (BigInt(spent[t] ?? "0") + d).toString();
  return { ...s, spent };
}
