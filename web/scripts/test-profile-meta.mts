// Pure checks for profile meta (pfp / bio / flag) validation + signed message.   pnpm test:profile-meta
import test from "node:test";
import assert from "node:assert/strict";
import { BIO_MAX, COUNTRY_CODES, bioLength, isFlag, normalizeFlag, profileMetaMessage, sanitizeBio, validateMeta } from "../lib/profileMeta.ts";
import { COMMUNITY_FLAGS, COMMUNITY_FLAG_ID_RE } from "../lib/flags/community.ts";
import { linkify, safeHttpUrl } from "../lib/linkify.ts";
import { USERNAME_COOLDOWN_MS, nextUsernameChangeAt, usernameChange } from "../lib/usernameCooldown.ts";
import { existsSync } from "node:fs";

test("sanitizeBio strips controls, zero-width and bidi overrides, collapses whitespace", () => {
  assert.equal(sanitizeBio("  hi\n\nthere\t\u0007 "), "hi there");
  assert.equal(sanitizeBio("a\u200Bb\u202Ec\uFEFF"), "abc");
  assert.equal(sanitizeBio(undefined), "");
  assert.equal(sanitizeBio("<b>x</b>"), "<b>x</b>"); // rendered as text by React, never as HTML
});

test("bio length is counted in grapheme clusters (emoji = 1), enforced at 160", () => {
  assert.equal(bioLength("🚀"), 1);
  assert.equal(bioLength("👨‍👩‍👧"), 1); // ZWJ family
  assert.equal(bioLength("🇯🇵"), 1); // regional-indicator flag
  assert.equal(bioLength("e\u0301"), 1); // combining accent
  assert.equal(bioLength("gm 🚀 https://x.com/a"), 20);
  assert.equal(validateMeta({ pfp: "", flag: "", bio: "🚀".repeat(BIO_MAX) }), null);
  assert.equal(validateMeta({ pfp: "", flag: "", bio: "👨‍👩‍👧".repeat(BIO_MAX) }), null);
  assert.match(validateMeta({ pfp: "", flag: "", bio: "👨‍👩‍👧".repeat(BIO_MAX + 1) }) ?? "", /max/);
  assert.match(validateMeta({ pfp: "", flag: "", bio: "x".repeat(BIO_MAX + 1) }) ?? "", /max/);
});

test("sanitizeBio keeps emoji ZWJ sequences but drops stray joiners", () => {
  assert.equal(sanitizeBio("👨‍👩‍👧 crew"), "👨‍👩‍👧 crew");
  assert.equal(sanitizeBio("\u200Dhi\u200D there"), "hi there");
});

test("links: http(s) only, trailing punctuation stays text, nothing else becomes a link", () => {
  assert.deepEqual(linkify("gm https://x.com/disciple. wagmi"), [
    { kind: "text", text: "gm " }, { kind: "link", text: "https://x.com/disciple", href: "https://x.com/disciple" }, { kind: "text", text: ". wagmi" },
  ]);
  assert.deepEqual(linkify("javascript:alert(1) data:text/html,<b>x</b> x.com"), [{ kind: "text", text: "javascript:alert(1) data:text/html,<b>x</b> x.com" }]);
  assert.equal(linkify("see (http://a.io/b)")[1].kind, "link");
  assert.equal((linkify("see (http://a.io/b)")[1] as { href: string }).href, "http://a.io/b");
  assert.equal(linkify("xhttps://a.io").length, 1); // not at a word start
  assert.equal(linkify('https://a.io/"><img src=x onerror=alert(1)>').filter((p) => p.kind === "link").length, 1);
  assert.equal((linkify('https://a.io/"><img')[0] as { href: string }).href, "https://a.io/");
  assert.equal(safeHttpUrl("https://user:pw@a.io"), null);
  assert.equal(safeHttpUrl("ftp://a.io"), null);
});

test("community flags: config ids are valid, never collide with ISO codes, assets exist", () => {
  assert.ok(COMMUNITY_FLAGS.length >= 4);
  for (const f of COMMUNITY_FLAGS) {
    assert.match(f.id, COMMUNITY_FLAG_ID_RE);
    assert.ok(!COUNTRY_CODES.includes(f.id.toUpperCase()));
    assert.ok(isFlag(f.id) && normalizeFlag(f.id.toUpperCase()) === f.id, f.id);
    assert.ok(existsSync(new URL(`../public${f.asset}`, import.meta.url)), f.asset);
  }
  assert.ok(isFlag("c-pepe") && isFlag("AI") && !isFlag("c-nope") && !isFlag("pepe"));
  assert.equal(validateMeta({ pfp: "", flag: "c-mog", bio: "" }), null);
  assert.equal(validateMeta({ pfp: "", flag: "c-unknown", bio: "" }), "Unknown flag.");
});

test("username: one change per 24h; same name is not a change; first name starts the clock", () => {
  const now = 1_800_000_000_000;
  assert.deepEqual(usernameChange({ prev: null, next: "ace", lastChangeAt: null, now }), { kind: "allowed" });
  assert.deepEqual(usernameChange({ prev: "ace", next: "ace", lastChangeAt: now - 1000, now }), { kind: "same" });
  assert.deepEqual(usernameChange({ prev: "ace", next: "bee", lastChangeAt: now - 1000, now }), { kind: "wait", nextAllowedAt: now - 1000 + USERNAME_COOLDOWN_MS });
  assert.deepEqual(usernameChange({ prev: "ace", next: "bee", lastChangeAt: now - USERNAME_COOLDOWN_MS, now }), { kind: "allowed" });
  assert.deepEqual(usernameChange({ prev: "ace", next: "bee", lastChangeAt: null, now }), { kind: "allowed" }); // named before this shipped
  assert.equal(nextUsernameChangeAt(now - 1000, now), now - 1000 + USERNAME_COOLDOWN_MS);
  assert.equal(nextUsernameChangeAt(now - USERNAME_COOLDOWN_MS - 1, now), null);
});

test("flag must be empty, an ISO 3166-1 alpha-2 code or a community id", () => {
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
