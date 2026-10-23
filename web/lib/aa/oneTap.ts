/**
 * Pure helpers for on-chain one-tap sessions (DiscipleSessionPolicy 1.3.0, v4 stack). Shared by session.ts (browser),
 * WalletButton, and scripts/test-session-e2e.mts (node), so tests exercise the exact logic the app uses.
 */
import { toFunctionSelector, type Address, type Hex } from "viem";
import type { Call } from "./core";

/**
 * Expected DiscipleSessionPolicy.moduleId(); enableOneTap refuses a policy that reports anything else.
 * Config, so the redeploy swaps it with the address: NEXT_PUBLIC_SESSION_POLICY (address) +
 * NEXT_PUBLIC_SESSION_POLICY_VERSION (default 1.3.0 = the v4 testnet policy, contracts/deployments/rh-testnet-46630.json
 * addons.DiscipleSessionPolicy; moduleId() "disciple.session-policy.1.3.0", USDG routing).
 */
export const SESSION_POLICY_VERSION = process.env.NEXT_PUBLIC_SESSION_POLICY_VERSION || "1.3.0";
/**
 * Deployed DiscipleSessionPolicy per chain — source of truth: contracts/deployments/rh-testnet-46630.json
 * (addons.DiscipleSessionPolicy.address, v4, constructor referralRegistry 0x0aa4…9a9c). NEXT_PUBLIC_SESSION_POLICY overrides.
 * (v3's 0x0399…2be2 / 1.1.1 is superseded: its sessions were installed against the v3 router/launchpad.)
 */
export const DEFAULT_SESSION_POLICY: Record<number, Address> = {
  46630: "0x3d3667e8880c6b633b424d645b8004788b1d6e27",
};
export const sessionPolicyFor = (chainId: number, env = process.env.NEXT_PUBLIC_SESSION_POLICY): Address | "" =>
  (/^0x[0-9a-fA-F]{40}$/.test(env || "") ? (env as Address) : DEFAULT_SESSION_POLICY[chainId] ?? "");
export const SESSION_POLICY_MODULE_ID = `disciple.session-policy.${SESSION_POLICY_VERSION}`;
const verAtLeast = (v: string, min: string) => { const a = v.split(".").map(Number), b = min.split(".").map(Number); for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); } return true; };
/** Policy 1.3.0+ lets the session key sign buyWithUsdg / sellToUsdg; before that those go to the owner signer. */
export const policyHasUsdg = (v = SESSION_POLICY_VERSION) => verAtLeast(v, "1.3.0");
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
const USDG_SIGS = ["buyWithUsdg(address,uint256,uint256,uint256)", "sellToUsdg(address,uint256,uint256,uint256)"];
/** Session-signable selectors for the configured policy version (USDG router calls only on ≥ 1.3.0). */
export const tradeSelectors = (v = SESSION_POLICY_VERSION) => new Set([...SIGS, ...(policyHasUsdg(v) ? USDG_SIGS : [])].map((s) => toFunctionSelector(s).toLowerCase()));
export const TRADE_SELECTORS = tradeSelectors();
const APPROVE = toFunctionSelector("approve(address,uint256)").toLowerCase();
export const TRY_ATTRIBUTE = toFunctionSelector("tryAttribute(address,address)").toLowerCase() as Hex;

/**
 * Should this call list be signed by the session key? Only if every call is a policy-allowed selector with no ETH.
 * tryAttribute counts only with referral on AND to the registry. Anything else ⇒ owner signer (policy would reject).
 */
export function sessionEligible(calls: Call[], o: { referral: boolean; registry?: Address; usdg?: Address; router?: Address }): boolean {
  return calls.length > 0 && calls.every((c) => {
    if (c.value) return false;
    const sel = c.data.slice(0, 10).toLowerCase();
    // policy ≥ 1.3.0: USDG may only be approved to the router (exact amount, paired with buyWithUsdg) — a USDG
    // approve to a curve / tramp manager would be rejected on-chain ⇒ owner signer instead
    if (o.usdg && sel === APPROVE && c.to.toLowerCase() === o.usdg.toLowerCase() && `0x${c.data.slice(34, 74)}`.toLowerCase() !== o.router?.toLowerCase()) return false;
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

/**
 * A one-tap session key cached in the browser. `policy` = the DiscipleSessionPolicy it was installed against.
 * caps / spent (raw units, decimal strings, keyed by lowercase quote token) mirror the on-chain SessionConfig cap0/cap1 and
 * Session.spent0/spent1, so the client knows BEFORE signing whether the session key can still pay for a buy.
 */
export type CachedSession = {
  account: Address; entityId: number; key: Hex; validUntil: number; maxSlippageBps: number; policy?: Address;
  caps?: Record<string, string>; spent?: Record<string, string>;
};

/**
 * Session spend cap in the quote token's RAW units for a $ budget. The on-chain caps (cap0/cap1) are raw token amounts,
 * NOT dollars: the old fixed 1e24 ("1M tokens") meant $1M of USDG but only ~$2.5K of test STRATEGY (~$0.0025) — the
 * "Spend limit reached" bug. quotePriceUsdWad = QuotePricer.quotePriceUsd(token) (USD WAD per 1e18 raw); USDG = 1e18.
 */
/** uint128 max = "no session spend cap" (Maker: no cap by default). A ZERO cap or zero quote slot BLOCKS spending on-chain
 *  (DiscipleSessionPolicy L270/276/519), so both slots are always set and uncapped slots get this value, never 0. */
export const SESSION_NO_CAP = (BigInt(1) << BigInt(128)) - BigInt(1);
/** Opt-in one-tap spend limit in $ (Advanced). Blank / 0 / invalid ⇒ null = no cap. */
export const parseSpendLimitUsd = (v: string | number | null | undefined): number | null => {
  const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};
export function usdCapRaw(usd: number, quotePriceUsdWad: bigint, decimals = 18): bigint {
  if (!(usd > 0) || quotePriceUsdWad <= BigInt(0)) return BigInt(0);
  const usdWad = BigInt(Math.round(usd * 1e6)) * BigInt(1e12);
  const cap = (usdWad * BigInt(10) ** BigInt(decimals)) / quotePriceUsdWad;
  const MAX128 = (BigInt(1) << BigInt(128)) - BigInt(1);
  return cap > MAX128 ? MAX128 : cap;
}

/**
 * Can the session key pay for this batch? Every quote the batch spends must be a session-capped quote with headroom
 * left (spent + delta ≤ cap). Unknown caps (older cache) ⇒ false ⇒ the owner signs (Privy, silently) instead of the
 * policy reverting with SpendCapExceeded / the client refusing with "spend limit reached".
 */
export function sessionHasHeadroom(s: Pick<CachedSession, "caps" | "spent"> | null | undefined, delta: Record<string, bigint>): boolean {
  const entries = Object.entries(delta).filter(([, d]) => d > BigInt(0));
  if (!entries.length) return true;
  if (!s?.caps) return false;
  return entries.every(([t, d]) => {
    const cap = s.caps![t.toLowerCase()];
    if (cap === undefined) return false;
    return BigInt(s.spent?.[t.toLowerCase()] ?? "0") + d <= BigInt(cap);
  });
}
export function addSpent(s: CachedSession, delta: Record<string, bigint>): CachedSession {
  const spent = { ...(s.spent ?? {}) };
  for (const [t, d] of Object.entries(delta)) if (d > BigInt(0)) spent[t.toLowerCase()] = (BigInt(spent[t.toLowerCase()] ?? "0") + d).toString();
  return { ...s, spent };
}
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
