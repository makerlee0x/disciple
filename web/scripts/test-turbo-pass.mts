/** Turbo gate (app audit 2026-11-15): who gets past without the password. Run: pnpm test:turbo-pass */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasTurboInvite, isAppUa, turboInviteToken, turboOpen, turboOpenReq, turboPassToken, TURBO_INVITE_COOKIE } from "../lib/server/turboPass.ts";

const APP = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 DiscipleApp/1";
const WEB = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

test("the iPhone app is let in, a plain browser is not", () => {
  assert.equal(isAppUa(APP), true);
  assert.equal(isAppUa(WEB), false);
  assert.equal(turboOpen({ ua: APP }), true);
  assert.equal(turboOpen({ ua: WEB }), false);
});
test("the password cookie still works", () => {
  assert.equal(turboOpen({ ua: WEB, pass: turboPassToken("nova") }), true);
  assert.equal(turboOpen({ ua: WEB, pass: "nope" }), false);
});
test("an invite cookie works until it expires and can't be forged", () => {
  const now = Date.now(), t = turboInviteToken(now);
  assert.equal(hasTurboInvite(t, now + 1000), true);
  assert.equal(hasTurboInvite(t, now + 7 * 3600_000), false);
  const [exp] = t.split(".");
  assert.equal(hasTurboInvite(`${Number(exp) + 999999}.${t.split(".")[1]}`, now), false);
  assert.equal(hasTurboInvite("garbage", now), false);
  assert.equal(hasTurboInvite(undefined, now), false);
});
test("API requests read the same three ways in", () => {
  const req = (h: Record<string, string>) => new Request("http://x/api/duel/me", { headers: h });
  assert.equal(turboOpenReq(req({ "user-agent": APP })), true);
  assert.equal(turboOpenReq(req({ "user-agent": WEB })), false);
  assert.equal(turboOpenReq(req({ "user-agent": WEB, cookie: `${TURBO_INVITE_COOKIE}=${encodeURIComponent(turboInviteToken())}` })), true);
});
