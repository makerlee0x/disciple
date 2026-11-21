/**
 * Signed-in state without the wallet stack (mobile plan 2026-11-13, speed fix 1).
 * The lobby top bar and the game sidebar only need "who is signed in" and change events, but importing lib/aa/session
 * pulled viem + @noble (~74 KB gzipped) into every page's first-load JS. This module holds that state with no viem import;
 * lib/aa/session.ts owns the keys and writes the summary here, and re-exports everything below, so existing imports keep working.
 */
export type OwnerKind = "privy" | "eoa" | "local";
export type SessionSummary = {
  kind: OwnerKind; owner: `0x${string}`; expiresAt: number; gasMode: "gasless";
  oneTap: null | { entityId: number; validUntil: number; maxSlippageBps: number };
};

let summary: SessionSummary | null = null;
const sessListeners = new Set<() => void>();
export function onSessionChange(f: () => void) { sessListeners.add(f); return () => { sessListeners.delete(f); }; }
/** lib/aa/session.ts only: publish the current owner session (null = signed out) and notify listeners. */
export function _publishSession(s: { kind: OwnerKind; owner: `0x${string}`; expiresAt: number } | null) {
  summary = s ? { ...s, gasMode: "gasless", oneTap: null } : null;
  sessListeners.forEach((f) => f());
}
export function aaSession(): SessionSummary | null { return summary; }

/** Read-only facts about the signed-in Privy user (profile Settings "Signed in with", Edit profile X row). Never a token. */
export type PrivyAccountInfo = { method: "Email" | "Google" | "X" | "a wallet" | null; email: string | null; xUsername: string | null };
/** Privy MFA (2FA) methods the app offers: authenticator app (TOTP) and passkey. Privy has no PIN method. */
export type PrivyMfaMethod = "totp" | "passkey";
/** Privy's own account-security actions (Settings): export the embedded wallet key, enroll in / remove MFA. */
export type PrivySecurity = {
  /** Opens Privy's export modal for the owner embedded wallet (the key loads in Privy's iframe; the app never sees it). */
  exportWallet: (() => Promise<void>) | null;
  /** MFA methods this user has enrolled (Privy user.mfaMethods). */
  mfaEnrolled: string[];
  /** Opens Privy's MFA enrollment modal (methods offered = the ones enabled for the app in the Privy dashboard). */
  enrollMfa: () => void;
  unenrollMfa: (m: PrivyMfaMethod) => Promise<void>;
};
export type PrivyHooks = { /** Privy finished loading (usePrivy().ready) */ ready?: boolean; login: () => void; logout: () => Promise<void>; getAccessToken?: () => Promise<string | null>; getIdentityToken?: () => Promise<string | null>; authenticated?: boolean; account?: PrivyAccountInfo | null; security?: PrivySecurity | null;
  /** Link an X account to the signed-in Privy user (usePrivy().linkTwitter). In the app this runs in the system sign-in sheet and reloads the page. */
  linkX?: () => void };
let privyHooks: PrivyHooks | null = null;
const privySubs = new Set<() => void>();
let idTok: { tok: string; exp: number } | undefined;   // privyIdentityToken cache
export function registerPrivy(h: PrivyHooks | null) { if (!h?.authenticated) idTok = undefined; privyHooks = h; privySubs.forEach((f) => f()); }
// dev only (screenshots of signed-in screens, like window.__walletDev): a stand-in session whose token the page sends to /api.
// Also in the local-signer e2e build (NEXT_PUBLIC_AA_SIGNER=local is inlined at build time, so real builds drop this),
// where e2e/turbo-cash.spec.ts uses it to reach the Turbo popup's /api/lighter calls, which it answers itself.
if ((process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_AA_SIGNER === "local") && typeof window !== "undefined") (window as unknown as { __privyDev?: (t: string) => void }).__privyDev = (t: string) => registerPrivy({ ready: true, authenticated: true, getAccessToken: async () => t, getIdentityToken: async () => t } as unknown as PrivyHooks);
export function privyHooksNow(): PrivyHooks | null { return privyHooks; }
export function privyReady() { return !!privyHooks; }
/** Privy has loaded and knows whether this visitor is signed in. */
export const privyLoaded = () => !!privyHooks?.ready;
export function onPrivy(f: () => void) { privySubs.add(f); return () => { privySubs.delete(f); }; }
export const privyAuthenticated = () => !!privyHooks?.authenticated;
/** The signed-in Privy user's login method / email / linked X username, or null (signed out, or not a Privy login). */
export const privyAccount = (): PrivyAccountInfo | null => (privyHooks?.authenticated ? privyHooks.account ?? null : null);
/** Export key / 2FA actions for the signed-in Privy user, or null (signed out, or not a Privy login). */
export const privySecurity = (): PrivySecurity | null => (privyHooks?.authenticated ? privyHooks.security ?? null : null);
export async function privyAccessToken(): Promise<string | null> {
  try { return (await privyHooks?.getAccessToken?.()) ?? null; } catch { return null; }
}
/** The identity token, reused until 2 min before its exp (maker 2026-11-21: Privy's getIdentityToken took 150-225 ms on
 *  every trade). The relay checks exp itself, so a reused token is never accepted past its life. */
const jwtExpMs = (t: string): number => {
  try { const p = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number }; return typeof p.exp === "number" ? p.exp * 1000 : 0; } catch { return 0; }
};
export async function privyIdentityToken(): Promise<string | null> {
  if (idTok && idTok.exp - Date.now() > 120_000) return idTok.tok;
  try {
    const tok = (await privyHooks?.getIdentityToken?.()) ?? null;
    idTok = tok ? { tok, exp: jwtExpMs(tok) } : undefined;
    return tok;
  } catch { return null; }
}
/** Drop the cached identity token (sign-out, or the relay refused it). */
export function forgetIdentityToken() { idTok = undefined; }
export function privyLogin() {
  if (!privyHooks) throw new Error("Login is still loading — try again in a second.");
  privyHooks.login();
}

/** localStorage key of the saved session (lib/aa/session.ts reads and writes it). */
export const SESSION_LS = "disciple.aa.session.v2";
/** A saved, unexpired session in this browser (before restore runs): the best guess at "signed in" for the first paint. */
export function hasSavedSession(): boolean {
  try {
    const v = JSON.parse(localStorage.getItem(SESSION_LS) || "null") as { owner?: string; expiresAt?: number } | null;
    return !!v?.owner && (!v.expiresAt || v.expiresAt > Date.now());
  } catch { return false; }
}
/** Privy loaded and says signed out: drop a stale saved session so the next refresh doesn't paint the old pill. */
export function forgetSavedSession() { try { localStorage.removeItem(SESSION_LS); } catch { /* private mode */ } }
