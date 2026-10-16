/**
 * Pure helpers for on-chain one-tap sessions (DiscipleSessionPolicy v1.1.1, PR #60). Shared by session.ts (browser),
 * WalletButton, and scripts/test-session-e2e.mts (node), so tests exercise the exact logic the app uses.
 */
import { toFunctionSelector, type Address, type Hex } from "viem";
import type { Call } from "./core";

/** Expected DiscipleSessionPolicy.moduleId(); enableOneTap refuses a policy that reports anything else. */
export const SESSION_POLICY_MODULE_ID = "disciple.session-policy.1.1.1";
export const moduleIdAbi = [{ type: "function", name: "moduleId", stateMutability: "pure", inputs: [], outputs: [{ type: "string" }] }] as const;
/** P_REFERRAL (1<<10): ReferralRegistry.tryAttribute(wallet == account, referrer). Not in the SDK's TRADE_PERMS. */
export const P_REFERRAL = BigInt(1) << BigInt(10);
export const referralAttributionOn = () => process.env.NEXT_PUBLIC_REFERRAL_ATTRIBUTE === "1";

/** Session permission bits: SDK TRADE_PERMS (no launches), plus P_REFERRAL when referral attribution is on. */
export function sessionPermissions(tradePerms: bigint, referral = referralAttributionOn()): bigint {
  return referral ? tradePerms | P_REFERRAL : tradePerms;
}

const SIGS = [
  "approve(address,uint256)",
  "buyExactIn(address,uint256,uint256,address,uint256)", "sellExactIn(address,uint256,uint256,address,uint256)",
  "buy(uint256,uint256,uint256)", "sell(uint256,uint256,uint256)", "buy(uint256,uint256,uint256,address)", "sell(uint256,uint256,uint256,address)",
  "placeTramp(address,int24,int24,uint256,uint128,uint256)", "placeWall(address,int24,int24,uint256,uint128,uint256)", "cancel(uint256)",
];
const TRADE_SELECTORS = new Set(SIGS.map((s) => toFunctionSelector(s).toLowerCase()));
export const TRY_ATTRIBUTE = toFunctionSelector("tryAttribute(address,address)").toLowerCase() as Hex;

/**
 * Should this call list be signed by the session key? Only if every call is a policy-allowed selector with no ETH.
 * tryAttribute counts only with referral on AND to the registry. Anything else ⇒ owner signer (policy would reject).
 */
export function sessionEligible(calls: Call[], o: { referral: boolean; registry?: Address }): boolean {
  return calls.length > 0 && calls.every((c) => {
    if (c.value) return false;
    const sel = c.data.slice(0, 10).toLowerCase();
    if (TRADE_SELECTORS.has(sel)) return true;
    return o.referral && sel === TRY_ATTRIBUTE && !!o.registry && c.to.toLowerCase() === o.registry.toLowerCase();
  });
}

/**
 * Session expiry label. validUntil is UNIX SECONDS (on-chain). Shows the remaining time AND the date, so a 24h session
 * started at 2:43 PM no longer reads "until 2:43 PM" (looked like it expired immediately).
 */
export function fmtSessionExpiry(validUntilSec: number, nowMs = Date.now(), locale?: string, timeZone?: string): string {
  const leftSec = Math.round(validUntilSec - nowMs / 1000);
  if (leftSec <= 0) return "expired";
  const h = Math.floor(leftSec / 3600), m = Math.floor((leftSec % 3600) / 60);
  const left = h >= 1 ? `${h}h${m ? ` ${m}m` : ""}` : `${Math.max(1, m)}m`;
  const at = new Date(validUntilSec * 1000).toLocaleString(locale, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone });
  return `${left} left (until ${at})`;
}

/** A one-tap session key cached in the browser. `policy` = the DiscipleSessionPolicy it was installed against. */
export type CachedSession = { account: Address; entityId: number; key: Hex; validUntil: number; maxSlippageBps: number; policy?: Address };
/**
 * Is a cached session still usable? Same account, not about to expire, and installed on the CURRENT policy.
 * Sessions from an older policy (e.g. 1.1.0, or cached before the policy was recorded) count as off ⇒ the UI prompts
 * "Enable one-tap" again (the old validation stays on-chain until it expires; harmless, it can't sign for the new hooks).
 */
export function cachedSessionUsable(s: CachedSession | null | undefined, o: { account: Address; policy: Address | ""; nowMs?: number }): boolean {
  if (!s || !o.policy) return false;
  if (s.account.toLowerCase() !== o.account.toLowerCase()) return false;
  if (!s.policy || s.policy.toLowerCase() !== o.policy.toLowerCase()) return false;
  return s.validUntil * 1000 > (o.nowMs ?? Date.now()) + 60_000;
}
