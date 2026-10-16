/**
 * Client profile identity: unique username (referral handle) + X/Twitter handle.
 * Username uniqueness is enforced by /api/profile/username (testnet: in-memory/file store).
 * Static preview (no API) falls back to browser-only storage and says so.
 */
import { IS_STATIC_PREVIEW } from "./base-path";
import { refLink } from "./referral";

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
export const RESERVED = new Set(["admin", "disciple", "support", "root", "api", "you", "settings", "profile"]);
const K = { username: "disciple.username", x: "disciple.xHandle", ref: "disciple.ref" };

export function normalizeUsername(u: string) { return u.trim().toLowerCase().replace(/^@/, ""); }
export function validateUsername(u: string): string | null {
  const n = normalizeUsername(u);
  if (!USERNAME_RE.test(n)) return "3–20 chars: a–z, 0–9, underscore.";
  if (RESERVED.has(n)) return "That name is reserved.";
  return null;
}

const get = (k: string) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const set = (k: string, v: string) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* ignore */ } };

export const localUsername = () => get(K.username);
export const localXHandle = () => get(K.x);
export const setLocalXHandle = (h: string) => set(K.x, h.replace(/^@/, "").trim());
export const rememberReferrer = (u: string) => { if (!get(K.ref)) set(K.ref, normalizeUsername(u)); };
export const referrer = () => get(K.ref);

export function profileUrl(username: string) { return `/u/${encodeURIComponent(normalizeUsername(username))}`; }
/** Ref link: /r/<username> (wallet fallback). Legacy /u/<name>?ref=1 links still record the referrer. */
export function referralUrl(username: string | null, wallet?: string | null) {
  return refLink(username ? normalizeUsername(username) : null, wallet);
}

export async function checkUsername(u: string): Promise<{ available: boolean; reason?: string }> {
  const bad = validateUsername(u);
  if (bad) return { available: false, reason: bad };
  if (IS_STATIC_PREVIEW) return { available: true, reason: "preview: not checked server-side" };
  try {
    const r = await fetch(`/api/profile/username?u=${encodeURIComponent(normalizeUsername(u))}`);
    return await r.json();
  } catch { return { available: false, reason: "Could not reach username service." }; }
}

export async function claimUsername(u: string, address: string | null): Promise<{ ok: boolean; reason?: string }> {
  const n = normalizeUsername(u);
  const bad = validateUsername(n);
  if (bad) return { ok: false, reason: bad };
  if (!address) return { ok: false, reason: "Sign in first — usernames are bound to your wallet." };
  if (!IS_STATIC_PREVIEW) {
    try {
      const r = await fetch("/api/profile/username", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: n, address, previous: localUsername() || undefined }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) return { ok: false, reason: j.reason || "Username taken." };
    } catch { return { ok: false, reason: "Could not reach username service." }; }
  }
  set(K.username, n);
  return { ok: true };
}
