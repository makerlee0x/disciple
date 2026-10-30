// Profile edit fixes (lee, 2026-10-24): flag search aliases, 3-character usernames (client + server), picture upload
// failures mapped to plain words.   pnpm test:profile-edit-fixes
import test from "node:test";
import assert from "node:assert/strict";
import { FLAG_ALIASES, flagMatchRank, foldSearch, searchFlags } from "../lib/flags/search.ts";
import { COUNTRY_CODES } from "../lib/profileMeta.ts";
import { USERNAME_SHORT, validateUsername } from "../lib/profile.ts";
import { PFP_ERROR, fitInside, pfpFailure, pfpPrecheck } from "../lib/pfpUpload.ts";
import { defaultUsername } from "../lib/defaultUsername.ts";

const names = new Intl.DisplayNames(["en"], { type: "region" });
const countries = COUNTRY_CODES.map((c) => ({ id: c, label: names.of(c) || c })).sort((a, b) => a.label.localeCompare(b.label));
const top = (q: string) => searchFlags(q, countries)[0]?.id;

test("flag search: aliases find United States / United Kingdom first, any case", () => {
  for (const q of ["america", "America", "AMERICA", "usa", "US", "us", "united states", "United States", "the states"]) assert.equal(top(q), "US", q);
  for (const q of ["uk", "UK", "britain", "great britain", "Great Britain", "england", "England", "scotland", "wales", "united kingdom"]) assert.equal(top(q), "GB", q);
});

test("flag search: other common aliases", () => {
  const cases: Record<string, string> = {
    holland: "NL", netherlands: "NL", korea: "KR", "south korea": "KR", "north korea": "KP", uae: "AE", UAE: "AE", emirates: "AE",
    dubai: "AE", czechia: "CZ", "ivory coast": "CI", burma: "MM", turkey: "TR", turkiye: "TR", "Türkiye": "TR", vatican: "VA",
    russia: "RU", deutschland: "DE", swiss: "CH", espana: "ES", "España": "ES", persia: "IR", "cape verde": "CV",
  };
  for (const [q, cc] of Object.entries(cases)) assert.equal(top(q), cc, q);
});

test("flag search: names, codes and partial queries still work; no match → empty", () => {
  assert.equal(top("japan"), "JP");
  assert.equal(top("JP"), "JP");
  assert.equal(top("fra"), "FR");
  assert.ok(searchFlags("ameri", countries).some((f) => f.id === "US"), "prefix of an alias");
  assert.ok(searchFlags("ameri", countries).some((f) => f.id === "AS"), "American Samoa still listed");
  assert.deepEqual(searchFlags("zzzz", countries), []);
  assert.equal(searchFlags("", countries).length, countries.length);
  // community flags (c-pepe …) were replaced by guilds in Guilds V1 (84730cc): countries only now
  assert.equal(foldSearch("  Côte d’Ivoire "), "cote d'ivoire");
  assert.equal(flagMatchRank("us", { id: "AU", label: "Australia" }), 2);
});

test("flag aliases only point at real country codes", () => {
  for (const cc of Object.keys(FLAG_ALIASES)) assert.ok(COUNTRY_CODES.includes(cc), cc);
});

test("usernames need at least 3 characters (plain message); 3–20 valid", () => {
  assert.equal(validateUsername("a"), USERNAME_SHORT);
  assert.equal(validateUsername("ab"), USERNAME_SHORT);
  assert.equal(validateUsername("@ab "), USERNAME_SHORT);
  assert.equal(USERNAME_SHORT, "Usernames need at least 3 characters.");
  assert.equal(validateUsername("abc"), null);
  assert.equal(validateUsername("a".repeat(20)), null);
  assert.match(validateUsername("a".repeat(21)) ?? "", /3–20/);
  assert.match(validateUsername("ab-c") ?? "", /3–20/);
  assert.equal(validateUsername("admin"), "That name is reserved.");
});

test("default call signs are display-only and long enough anyway", () => {
  // Defaults ("Captain Boom") are never claimed or validated as usernames; they're Title Case with a space.
  for (let i = 0; i < 200; i++) {
    const d = defaultUsername("0x" + i.toString(16).padStart(40, "0"));
    assert.ok(d.length >= 3 && d.includes(" "), d);
  }
});

test("server: POST /api/profile/username rejects a 2-character name with a 400 and the plain message", async () => {
  const { POST, GET } = await import("../app/api/profile/username/route.ts");
  const r = await POST(new Request("http://x/api/profile/username", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "ab", address: "0x" + "1".repeat(40), nonce: "n", signature: "0x" }) }));
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { ok: false, reason: "Usernames need at least 3 characters." });
  const g = await GET(new Request("http://x/api/profile/username?u=ab"));
  assert.deepEqual(await g.json(), { available: false, reason: "Usernames need at least 3 characters." });
});

test("picture upload: failures map to plain words (no jargon)", () => {
  assert.equal(pfpFailure(413, { verdict: "block", error: "File is larger than 2 MB." }), "too-big");
  assert.equal(pfpFailure(413, null), "too-big"); // platform body limit: not JSON
  assert.equal(pfpFailure(415, { verdict: "block" }), "format");
  assert.equal(pfpFailure(429, { verdict: "review" }), "busy");
  assert.equal(pfpFailure(200, { verdict: "block" }), "rejected");
  assert.equal(pfpFailure(200, { verdict: "review" }), "rejected");
  assert.equal(pfpFailure(200, { verdict: "allow" }), "failed"); // allowed but not stored
  assert.equal(pfpFailure(500, null), "failed");
  for (const m of Object.values(PFP_ERROR)) assert.doesNotMatch(m, /mime|blob|on-chain|relay|\btx\b|op id|moderat|verdict|413|KB|bytes/i, m);
  assert.equal(pfpPrecheck({ size: 3_000_000, type: "image/png" }), null, "a 3 MB screenshot is shrunk, not refused");
  assert.equal(pfpPrecheck({ size: 3_000_000, type: "image/heic" }), "format");
  assert.equal(pfpPrecheck({ size: 30 * 1024 * 1024, type: "image/png" }), "too-big");
  assert.deepEqual(fitInside(2880, 1800), { w: 1024, h: 640 });
  assert.deepEqual(fitInside(300, 200), { w: 300, h: 200 });
});

test("server: a big raw screenshot is refused by size, the same picture shrunk is accepted", async () => {
  const sharp = (await import("sharp")).default;
  const { normalizeImage } = await import("../lib/server/image.ts");
  // ~retina screenshot: 2880×1800, gradients + fine grain (PNG well over 2 MB, like a real one).
  const w = 2880, h = 1800, raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    const i = (y * w + x) * 3 + c;
    raw[i] = ((x >> 3) * (c + 1) + (y >> 2)) & 0xff ^ (((i * 2654435761) >>> 29) & 7);
  }
  const big = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  assert.ok(big.byteLength > 2 * 1024 * 1024, `fixture is > 2 MB (${big.byteLength})`);
  await assert.rejects(normalizeImage(big), /larger than 2 MB/);
  const { w: tw, h: th } = fitInside(w, h);
  const small = await sharp(big).resize(tw, th).webp({ quality: 90 }).toBuffer();
  assert.ok(small.byteLength <= 2 * 1024 * 1024, `shrunk upload is under 2 MB (${small.byteLength})`);
  const out = await normalizeImage(small);
  const m = await sharp(out.buf).metadata();
  assert.equal(m.format, "webp");
  assert.ok(Math.max(m.width ?? 0, m.height ?? 0) <= 1024);
});
