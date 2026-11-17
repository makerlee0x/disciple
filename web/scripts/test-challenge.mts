/** Permanent duel challenge links (lib/server/duel/challenge). Run: pnpm test:challenge */
import { test } from "node:test";
import assert from "node:assert/strict";
import { challengePath } from "../lib/server/duel/challenge.ts";

const W = "0x1234567890abcdef1234567890abcdef12345678";

test("named pilots get /vs/<name>, with the live code and their wallet as ref", () => {
  assert.equal(challengePath({ pid: W, name: "@Nova", code: "AB12" }), `/vs/nova?c=AB12&ref=${W}`);
  assert.equal(challengePath({ pid: W, name: "@nova" }), `/vs/nova?ref=${W}`);
});

test("pilots with no username yet fall back to their wallet", () => {
  assert.equal(challengePath({ pid: W, name: "@pilot-1234", code: "AB12" }), `/vs/${W}?c=AB12&ref=${W}`);
  assert.equal(challengePath({ pid: W, name: null }), `/vs/${W}?ref=${W}`);
});

test("guest ids never become a ref", () => {
  assert.equal(challengePath({ pid: "g_abc", name: "@guest" }), "/vs/guest");
});
