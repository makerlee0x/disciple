import "server-only";
/**
 * Guest pilots for the duel-only demo page (/duel, maker 2026-11-16: "share just the turbo duel with the Nova team").
 * Behind the Turbo password (or a friend's live invite), a visitor gets a signed guest id in an httpOnly cookie instead of
 * signing in. Guests can play bots and friend duels only: no ranked queue, so they never touch ratings or the board.
 * Duel fuel is the duel-only play book either way (no real money anywhere in a duel today).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const DUEL_GUEST_COOKIE = "disciple_duel_guest";
export const DUEL_GUEST_MAX_AGE = 60 * 60 * 24 * 30;
const GUEST_RE = /^g_[0-9a-f]{12}$/;

const secret = () => process.env.DUEL_GUEST_SECRET || `disciple-duel-guest:${(process.env.TURBO_PASSWORD || "nova").toLowerCase()}`;
const sig = (id: string) => createHash("sha256").update(`${secret()}:${id}`).digest("hex").slice(0, 32);
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export const isGuestPid = (pid: string) => GUEST_RE.test(pid);
export const newGuestId = () => `g_${randomBytes(6).toString("hex")}`;
export const guestToken = (id: string) => `${id}.${sig(id)}`;
/** cookie value → guest pid, or null when missing or forged */
export function guestOf(cookie: string | undefined | null): string | null {
  if (!cookie) return null;
  const [id, s] = cookie.split(".");
  return id && s && GUEST_RE.test(id) && same(s, sig(id)) ? id : null;
}
export const guestName = (pid: string) => `@guest-${pid.slice(2, 6)}`;
export function guestFromReq(req: Request): string | null {
  const c = (req.headers.get("cookie") || "").split(/;\s*/).find((x) => x.startsWith(DUEL_GUEST_COOKIE + "="));
  return guestOf(c ? decodeURIComponent(c.slice(DUEL_GUEST_COOKIE.length + 1)) : null);
}
