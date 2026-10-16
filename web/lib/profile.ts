/**
 * Client profile identity: unique username (referral handle) + X/Twitter handle.
 * Username uniqueness is enforced by /api/profile/username (Upstash; claims are signed by the wallet).
 * Static preview (no API) falls back to browser-only storage and says so.
 */
import { IS_STATIC_PREVIEW } from "./base-path";
import { refLink } from "./referral";
import { claimMessage } from "./usernameClaim";

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
      const a = address.toLowerCase();
      const nr = await fetch(`/api/profile/username?nonce=1&address=${a}`, { cache: "no-store" });
      const { nonce } = (await nr.json()) as { nonce?: string };
      if (!nonce) return { ok: false, reason: "Could not start the claim." };
      const signed = await signClaim(n, a, nonce);
      if (!signed) return { ok: false, reason: "Signature declined. Your wallet has to sign to claim a name." };
      const r = await fetch("/api/profile/username", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: n, address: a, nonce, ...signed }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) return { ok: false, reason: j.reason || "Username taken." };
    } catch { return { ok: false, reason: "Could not reach username service." }; }
  }
  set(K.username, n);
  return { ok: true };
}

/** Sign the claim with the connected wallet: DISCIPLE smart account → owner signs keccak(msg) raw; else signMessage. */
async function signClaim(username: string, address: string, nonce: string): Promise<{ signature: string; owner?: string } | null> {
  const msg = claimMessage(username, address, nonce);
  try {
    const s = await import("./aa/session");
    const smart = await s.aaAddress().catch(() => null);
    if (smart && smart.toLowerCase() === address) {
      const { keccak256, stringToBytes } = await import("viem");
      const o = await s.aaOwnerSign(keccak256(stringToBytes(msg)));
      return o ? { signature: o.sig, owner: o.owner } : null;
    }
    const w = await import("./wallet");
    const signer = await w.getSigner();
    if (signer.account.address.toLowerCase() !== address) return null;
    return { signature: await signer.signMessage({ account: signer.account.address, message: msg }) };
  } catch { return null; }
}
