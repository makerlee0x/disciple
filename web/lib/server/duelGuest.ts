import "server-only";
/**
 * Guest pilots for the duel-only demo page (/duel, maker 2026-11-16: "share just the turbo duel with the Nova team").
 * Behind the Turbo password (or a friend's live invite), a visitor gets a signed guest id in an httpOnly cookie instead of
 * signing in. Guests can play bots and friend duels only: no ranked queue, so they never touch ratings or the board.
 * Duel fuel is the duel-only play book either way (no real money anywhere in a duel today).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { kv, type Kv } from "@/lib/server/kv";

export const DUEL_GUEST_COOKIE = "disciple_duel_guest";
export const DUEL_GUEST_MAX_AGE = 60 * 60 * 24 * 30;
const GUEST_RE = /^g_[0-9a-f]{12}$/;

/** HMAC key: DUEL_GUEST_SECRET when set (16+ chars), else a random one made once and kept in KV (like lib/server/dailySeed),
 *  so a guest cookie can't be forged from anything in the code or the Turbo password. */
let secretP: Promise<string> | null = null;
async function secret(s: Kv): Promise<string> {
  const env = process.env.DUEL_GUEST_SECRET; if (env && env.length >= 16) return env;
  // a server secret that's already set in every deployment, so guests don't depend on a KV round trip
  for (const k of ["PRIVY_APP_SECRET", "CRON_SECRET"]) { const v = (process.env[k] || "").trim(); if (v.length >= 16) return `duel-guest:${k}:${v}`; }
  if (!secretP) secretP = (async () => {
    const have = await s.get("duel:guest:secret"); if (have) return have;
    const fresh = randomBytes(32).toString("hex"); await s.setNX("duel:guest:secret", fresh);
    return (await s.get("duel:guest:secret")) || fresh;
  })().catch((e) => { secretP = null; throw e; });
  return secretP;
}
const sig = async (id: string, s: Kv) => createHmac("sha256", await secret(s)).update(`duel-guest:${id}`).digest("hex");
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export const isGuestPid = (pid: string) => GUEST_RE.test(pid);
export const newGuestId = () => `g_${randomBytes(6).toString("hex")}`;
export const guestToken = async (id: string, s: Kv = kv()) => `${id}.${await sig(id, s)}`;
/** cookie value → guest pid, or null when missing or forged */
export async function guestOf(cookie: string | undefined | null, s: Kv = kv()): Promise<string | null> {
  if (!cookie) return null;
  const [id, mac] = cookie.split(".");
  return id && mac && GUEST_RE.test(id) && same(mac, await sig(id, s)) ? id : null;
}
export const guestName = (pid: string) => `@guest-${pid.slice(2, 6)}`;
export async function guestFromReq(req: Request): Promise<string | null> {
  const c = (req.headers.get("cookie") || "").split(/;\s*/).find((x) => x.startsWith(DUEL_GUEST_COOKIE + "="));
  return guestOf(c ? decodeURIComponent(c.slice(DUEL_GUEST_COOKIE.length + 1)) : null);
}
