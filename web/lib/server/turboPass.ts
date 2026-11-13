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
