// X OAuth helpers (lib/server/xLink): PKCE challenge (RFC 7636 appendix B vector) and the no-open-redirect returnTo guard.
// Run: tsx --conditions=react-server --test scripts/test-x-link.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { pkceChallenge, safeReturnTo, stateMatchesCookie } from "../lib/server/xLink";
import { isXResult, isXUsername, xConnectMessage } from "../lib/xLink";

test("PKCE S256 matches the RFC 7636 example", () => {
  assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("returnTo only allows same-site paths", () => {
  assert.equal(safeReturnTo("/profile"), "/profile");
  assert.equal(safeReturnTo("/u/pilot?tab=x"), "/u/pilot?tab=x");
  for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "", 42, null]) {
    assert.equal(safeReturnTo(bad), "/profile", String(bad));
  }
});

test("handles and results", () => {
  assert.ok(isXUsername("maker_01"));
  assert.ok(!isXUsername("way_too_long_handle"));
  assert.ok(!isXUsername("bad-handle"));
  assert.ok(isXResult("linked") && !isXResult("nope"));
  assert.match(xConnectMessage("0xABC", "n1"), /Wallet: 0xabc\nNonce: n1/);
});

test("the callback state must match the browser's cookie", () => {
  assert.equal(stateMatchesCookie("abc123", "abc123"), true);
  assert.equal(stateMatchesCookie("abc123", "abc124"), false);
  assert.equal(stateMatchesCookie("abc123", null), false);
  assert.equal(stateMatchesCookie("", ""), false);
  assert.equal(stateMatchesCookie("abc123", "abc1234"), false);
});
