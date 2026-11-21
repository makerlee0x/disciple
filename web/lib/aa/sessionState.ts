import { SIGNER_MODE } from "./env";
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
export function registerPrivy(h: PrivyHooks | null) {
  privyHooks = h;
  // a Sign in tap that came before the Privy chunk finished loading opens the window as soon as Privy is ready
  if (h && h.ready !== false && pendingLoginAt && Date.now() - pendingLoginAt < PENDING_LOGIN_MS) { pendingLoginAt = 0; queueMicrotask(() => h.login()); }
  privySubs.forEach((f) => f());
}
/** Privy (~2 MB) mounts after the page has loaded for signed-out visitors (components/PrivyProviders). Anything that needs it
 *  sooner fires this to start it now. */
export const PRIVY_WANTED_EVENT = "disciple:privy-wanted";
let pendingLoginAt = 0;
const PENDING_LOGIN_MS = 15_000;
// dev only (screenshots of signed-in screens, like window.__walletDev): a stand-in session whose token the page sends to /api
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") (window as unknown as { __privyDev?: (t: string) => void }).__privyDev = (t: string) => registerPrivy({ ready: true, authenticated: true, getAccessToken: async () => t, getIdentityToken: async () => t } as unknown as PrivyHooks);
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
export async function privyIdentityToken(): Promise<string | null> {
  try { return (await privyHooks?.getIdentityToken?.()) ?? null; } catch { return null; }
}
export function privyLogin() {
  if (!privyHooks) {
    // Privy is set up but its chunk is still on the way: start it and open the window once it's ready
    if (SIGNER_MODE === "privy" && typeof window !== "undefined") { pendingLoginAt = Date.now(); dispatchEvent(new Event(PRIVY_WANTED_EVENT)); return; }
    throw new Error("Login is still loading — try again in a second.");
  }
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
