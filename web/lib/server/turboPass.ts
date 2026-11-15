/**
 * Password gate for /turbo while Turbo is pre-launch (maker, Nov 13 2026: a password link for the Nova team instead of
 * a Vercel login). The password is TURBO_PASSWORD when set in the environment, otherwise "nova". Entering it sets an
 * httpOnly cookie holding a hash of the password, so changing the password signs everyone out.
 * This is a soft gate for sharing a preview, not account security.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const TURBO_PASS_COOKIE = "disciple_turbo_pass";
export const TURBO_PASS_MAX_AGE = 60 * 60 * 24 * 30;

const password = () => process.env.TURBO_PASSWORD || "nova";
export const turboPassToken = (pw = password()) => createHash("sha256").update(`disciple-turbo:${pw}`).digest("hex");

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export const checkTurboPassword = (pw: string) => same(turboPassToken(pw.trim().toLowerCase()), turboPassToken(password().toLowerCase()));
export const hasTurboPass = (cookie: string | undefined) => !!cookie && same(cookie, turboPassToken(password().toLowerCase()));

/* ---- Who gets past the gate without the password (maker, 2026-11-15, app audit: "Open in app + invite links") ----
 * 1. The DISCIPLE iPhone app (user agent tail "DiscipleApp/"). The app only ever plays with practice money
 *    (lib/turbo realTurboAllowed), so the gate has nothing to protect there. A user agent can be faked; this stays a soft gate.
 * 2. Someone who opened a friend's live duel link (/turbo/duel?c=CODE). /api/turbo/invite checks the code is open and sets
 *    a short invite cookie (expiry + hash, signed with the password), so they can join that duel without the password. */
export const TURBO_INVITE_COOKIE = "disciple_turbo_invite";
export const TURBO_INVITE_MAX_AGE = 60 * 60 * 6;
const NATIVE_UA = "DiscipleApp/";
export const isAppUa = (ua: string | null | undefined) => !!ua && ua.includes(NATIVE_UA);

const inviteSig = (exp: number) => createHash("sha256").update(`disciple-turbo-invite:${exp}:${password().toLowerCase()}`).digest("hex");
export const turboInviteToken = (now = Date.now()) => { const exp = now + TURBO_INVITE_MAX_AGE * 1000; return `${exp}.${inviteSig(exp)}`; };
export const hasTurboInvite = (cookie: string | undefined, now = Date.now()) => {
  if (!cookie) return false;
  const [e, sig] = cookie.split(".");
  const exp = Number(e);
  return Number.isFinite(exp) && exp > now && !!sig && same(sig, inviteSig(exp));
};

/** One check for pages and APIs: the password cookie, the app, or a live invite. */
export function turboOpen(o: { ua?: string | null; pass?: string; invite?: string }): boolean {
  return isAppUa(o.ua) || hasTurboPass(o.pass) || hasTurboInvite(o.invite);
}
/** turboOpen from a raw Request (API routes). */
export function turboOpenReq(req: Request): boolean {
  const jar = (req.headers.get("cookie") || "").split(/;\s*/);
  const read = (k: string) => { const c = jar.find((x) => x.startsWith(k + "=")); return c ? decodeURIComponent(c.slice(k.length + 1)) : undefined; };
  return turboOpen({ ua: req.headers.get("user-agent"), pass: read(TURBO_PASS_COOKIE), invite: read(TURBO_INVITE_COOKIE) });
}
