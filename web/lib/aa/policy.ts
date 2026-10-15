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

export type PolicyCfg = {
  launchpad: Address; router: Address; trampWallManager: Address;
  mintable: Address[];
  /** per-token cap in raw units for spend (quote) tokens; tokens not listed use defaultLimit */
  limits?: Record<string, bigint>;
  defaultLimit: bigint;
  /** Tokens whose approvals count toward the spend limit (quote assets). Rocket-token approvals (sells) are uncapped. */
  spendTokens?: Address[];
};
export type SessionState = { expiresAt: number; spent: Record<string, string> };

export class PolicyError extends Error { code = "SessionPolicy"; }

const lc = (a: string) => a.toLowerCase();

export async function checkCalls(pc: PublicClient, cfg: PolicyCfg, s: SessionState, calls: Call[], account: Address): Promise<Record<string, bigint>> {
  if (Date.now() > s.expiresAt) throw new PolicyError("Session expired — sign in again to keep one-tap trading.");
  const fixed = new Set([cfg.launchpad, cfg.router, cfg.trampWallManager].map(lc));
  const curveOk = new Map<string, boolean>();
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
    let fn: { functionName: string; args?: readonly unknown[] } | null = null;
    try { fn = decodeFunctionData({ abi: erc20, data: c.data }); } catch { fn = null; }
    if (fn?.functionName === "approve") {
      const [spender, amt] = fn.args as [Address, bigint];
      if (!fixed.has(lc(spender)) && !(await isCurve(spender))) throw new PolicyError(`Session can't approve ${spender}.`);
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

export function recordSpend(s: SessionState, delta: Record<string, bigint>): SessionState {
  const spent = { ...s.spent };
  for (const [t, d] of Object.entries(delta)) spent[t] = (BigInt(spent[t] ?? "0") + d).toString();
  return { ...s, spent };
}
