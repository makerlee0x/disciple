/**
 * Referral attribution (first touch, 30 days).
 *   /r/<username|0xwallet>  → server sets cookie `disciple_ref` = {u,a,t} (only if absent) and redirects to /
 *   <RefCapture/> (AppShell) copies the cookie into localStorage `disciple.refv2` (only if absent/expired).
 * Trade calls read `referrerWallet()`; see protocol-viem trade() for how it reaches the chain.
 */
export const REF_COOKIE = "disciple_ref";
export const REF_LS = "disciple.refv2";
export const REF_TTL_MS = 30 * 24 * 3600 * 1000;

export interface RefTouch { u: string | null; a: string | null; t: number }

const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function parseRef(raw: string | null | undefined, now = Date.now()): RefTouch | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<RefTouch>;
    const t = Number(j.t) || 0;
    if (!t || now - t > REF_TTL_MS) return null;
    const a = isAddr(j.a) ? j.a.toLowerCase() : null;
    const u = typeof j.u === "string" && /^[a-z0-9_]{3,20}$/.test(j.u) ? j.u : null;
    return a || u ? { u, a, t } : null;
  } catch { return null; }
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.split(/;\s*/).find((c) => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

/** Copy the server cookie into localStorage (first touch wins; expired entries are replaced). */
export function captureRefFromCookie(): RefTouch | null {
  try {
    const have = parseRef(localStorage.getItem(REF_LS));
    if (have) return have;
    const c = parseRef(readCookie(REF_COOKIE));
    if (c) localStorage.setItem(REF_LS, JSON.stringify(c));
    return c;
  } catch { return null; }
}

/** Client-side first touch (legacy /u/<name>?ref=1 links). */
export function rememberRefTouch(touch: Omit<RefTouch, "t">) {
  try {
    if (parseRef(localStorage.getItem(REF_LS))) return;
    localStorage.setItem(REF_LS, JSON.stringify({ ...touch, t: Date.now() }));
  } catch { /* ignore */ }
}

export function currentRef(): RefTouch | null {
  try { return parseRef(localStorage.getItem(REF_LS)) ?? parseRef(readCookie(REF_COOKIE)); } catch { return null; }
}

/** Referrer wallet for trade calls (never the trader themself). */
export function referrerWallet(self?: string | null): `0x${string}` | null {
  const a = currentRef()?.a;
  if (!a || (self && a === self.toLowerCase())) return null;
  return a as `0x${string}`;
}

/** Ref link: /r/<username>, or /r/<wallet> when no username yet. */
export function refLink(username: string | null | undefined, wallet?: string | null, origin?: string) {
  const o = origin ?? (typeof window !== "undefined" ? window.location.origin : "https://disciple.vip");
  const slug = username ? encodeURIComponent(username.toLowerCase()) : wallet ? wallet.toLowerCase() : "";
  return `${o}/r/${slug}`;
}
/** Short human label for a ref link (display only). */
export function refLabel(username: string | null | undefined, wallet?: string | null, host = "disciple.vip") {
  return username ? `${host}/r/${username}` : wallet ? `${host}/r/${shortAddr(wallet)}` : host;
}
