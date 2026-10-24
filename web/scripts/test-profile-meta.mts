// Pure checks for profile meta (pfp / bio / flag) validation + signed message.   pnpm test:profile-meta
import test from "node:test";
import assert from "node:assert/strict";
import { BIO_MAX, COUNTRY_CODES, isFlag, normalizeFlag, profileMetaMessage, sanitizeBio, validateMeta } from "../lib/profileMeta.ts";

test("sanitizeBio strips controls, zero-width and bidi overrides, collapses whitespace", () => {
  assert.equal(sanitizeBio("  hi\n\nthere\t\u0007 "), "hi there");
  assert.equal(sanitizeBio("a\u200Bb\u202Ec\uFEFF"), "abc");
  assert.equal(sanitizeBio(undefined), "");
  assert.equal(sanitizeBio("<b>x</b>"), "<b>x</b>"); // rendered as text by React, never as HTML
});

test("bio length is counted in code points", () => {
  assert.equal(validateMeta({ pfp: "", flag: "", bio: "🚀".repeat(BIO_MAX) }), null);
  assert.match(validateMeta({ pfp: "", flag: "", bio: "x".repeat(BIO_MAX + 1) }) ?? "", /max/);
});

test("flag must be an ISO 3166-1 alpha-2 code", () => {
  assert.equal(COUNTRY_CODES.length, 249);
  assert.ok(isFlag("US") && isFlag("") && !isFlag("XX") && !isFlag("USA"));
  assert.equal(normalizeFlag(" us "), "US");
  assert.equal(validateMeta({ pfp: "", flag: "ZZ", bio: "" }), "Unknown flag.");
});

test("pfp must be a stored image id (sha256 hex), never a URL", () => {
  assert.equal(validateMeta({ pfp: "a".repeat(64), flag: "", bio: "" }), null);
  assert.equal(validateMeta({ pfp: "https://evil.example/x.png", flag: "", bio: "" }), "Invalid picture.");
});

test("signed message covers every field and the nonce", () => {
  const m = profileMetaMessage("0xABC", { pfp: "", flag: "FR", bio: "salut" }, "n1");
  assert.ok(m.includes("Wallet: 0xabc") && m.includes("Flag: FR") && m.includes("Bio: salut") && m.includes("Nonce: n1") && m.includes("Picture: none"));
  assert.notEqual(m, profileMetaMessage("0xABC", { pfp: "", flag: "FR", bio: "salut!" }, "n1"));
});
