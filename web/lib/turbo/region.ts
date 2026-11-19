/**
 * Where real-money Turbo can't run (maker 2026-11-19). Lighter refuses US connections (prices and orders), and a player
 * who hits that has no way to know why, so the site turns real-money Turbo off there and says so. Play money still runs.
 * The country is Vercel's edge read of the visitor's IP (x-vercel-ip-country, via /api/geo); a VPN reads as the VPN's
 * country, which is also what Lighter sees. The iPhone app never runs real Turbo (lib/lighter/duel lighterWanted).
 */
import { withBase } from "@/lib/base-path";

export const TURBO_BLOCKED = new Set(["US"]);
export const TURBO_BLOCKED_NOTE = "Real-money Turbo isn't available in your region. You're on play money.";
const KEY = "disciple.geo";

/** the last answer this tab got, so sync callers (lighterWanted) can use it */
export function turboBlockedCached(): boolean {
  try { const c = sessionStorage.getItem(KEY); return !!c && TURBO_BLOCKED.has(c); } catch { return false; }
}

let p: Promise<{ country: string | null; blocked: boolean }> | null = null;
/** the visitor's country, once per tab (unknown = not blocked: local dev, or /api/geo down) */
export function turboRegion(): Promise<{ country: string | null; blocked: boolean }> {
  p ??= fetch(withBase("/api/geo"), { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { country?: string | null } | null) => {
      const country = j && typeof j.country === "string" && /^[A-Z]{2}$/.test(j.country) ? j.country : null;
      try { if (country) sessionStorage.setItem(KEY, country); } catch { /* private mode */ }
      return { country, blocked: !!country && TURBO_BLOCKED.has(country) };
    })
    .catch(() => ({ country: null, blocked: false }));
  return p;
}

/** server side: is this request from a blocked country */
export function turboBlockedReq(req: Request): boolean {
  const c = (req.headers.get("x-vercel-ip-country") || "").toUpperCase();
  return !!c && TURBO_BLOCKED.has(c);
}
