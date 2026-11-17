/**
 * One account per person, whichever of email / Google / Apple they sign in with (maker 2026-11-17).
 * Privy makes a new user (and wallet) for a second login method even when it carries the same email, and has no setting
 * that merges them. So when /api/xp/account says this login duplicates an earlier one (lib/server/xpAccount):
 *   1. sign the duplicate out, before its wallet is used;
 *   2. sign in to the first account with its own method (email prefilled, sign-up blocked);
 *   3. link the duplicate's method onto it. Privy's "Login method transfer" (dashboard setting) moves that login over and
 *      deletes the empty duplicate account. From then on every method lands on the same account and wallet.
 * The pending join is kept in localStorage (15 min) because Google / Apple sign-in can reload the page.
 */
export type JoinMethod = "email" | "google" | "apple";
export type PendingJoin = { method: JoinMethod; join: JoinMethod; email: string; at: number };
const KEY = "disciple.joinLogin.v1";
const TTL_MS = 15 * 60_000;
const METHODS: JoinMethod[] = ["email", "google", "apple"];
export const JOIN_LABEL: Record<JoinMethod, string> = { email: "Email", google: "Google", apple: "Apple" };

export function isPendingJoin(x: unknown): x is Omit<PendingJoin, "at"> {
  const p = x as PendingJoin | null;
  return !!p && METHODS.includes(p.method) && METHODS.includes(p.join) && p.method !== p.join && typeof p.email === "string" && p.email.includes("@");
}
export function savePendingJoin(p: Omit<PendingJoin, "at">, now = Date.now()) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...p, at: now })); } catch { /* private mode: the button still says which method */ }
}
export function pendingJoin(now = Date.now()): PendingJoin | null {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || "null") as PendingJoin | null;
    if (isPendingJoin(p) && typeof p.at === "number" && now - p.at < TTL_MS) return p;
    if (p) localStorage.removeItem(KEY);
  } catch { /* ignore */ }
  return null;
}
export function clearPendingJoin() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }

/** Privy login() options for step 2: only the first account's method, email prefilled, no new account. */
export function joinLoginOptions(p: Pick<PendingJoin, "method" | "email">) {
  return {
    loginMethods: [p.method] as JoinMethod[],
    ...(p.method === "email" ? { prefill: { type: "email" as const, value: p.email } } : {}),
    disableSignup: true,
  };
}
/** The blocker line under Sign in (CLAUDE.md: a blocker the player has to act on). */
export const joinLine = (p: Pick<PendingJoin, "method" | "join">) =>
  `This email already has a DISCIPLE account. Sign in with ${JOIN_LABEL[p.method]} to add ${JOIN_LABEL[p.join]} to it.`;
