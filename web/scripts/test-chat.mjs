// Live chat unit tests: filter (length, links, profanity), token bucket (burst 5, 1/2s), ulid ordering.
//   Run: node scripts/test-chat.mjs
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const dir = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chat-"));
for (const f of ["types", "filter", "ratelimit", "ulid"]) {
  const src = fs.readFileSync(path.join(dir, `../lib/chat/${f}.ts`), "utf8").replace(/from "\.\/(\w+)"/g, 'from "./$1.mjs"');
  fs.writeFileSync(path.join(tmp, f + ".mjs"), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText);
}
const imp = (f) => import(pathToFileURL(path.join(tmp, f + ".mjs")).href);
const { filterText } = await imp("filter"); const { take } = await imp("ratelimit"); const { ulid } = await imp("ulid");
let n = 0; const t = (name, fn) => { fn(); n++; console.log("ok", name); };

t("plain text passes, whitespace collapsed", () => assert.deepEqual(filterText("  gm   :halo:  "), { ok: true, text: "gm :halo:" }));
t("200 chars ok, 201 too_long", () => { assert.equal(filterText("a".repeat(200)).ok, true); assert.deepEqual(filterText("a".repeat(201)), { ok: false, error: "too_long" }); });
t("empty → filtered", () => assert.deepEqual(filterText("   "), { ok: false, error: "filtered" }));
t("links stripped", () => {
  assert.equal(filterText("go https://evil.xyz/claim now").text, "go [link] now");
  assert.equal(filterText("visit www.scam.io").text, "visit [link]");
  assert.equal(filterText("airdrop at freemoney.com/x").text, "airdrop at [link]");
  assert.deepEqual(filterText("https://x.com"), { ok: false, error: "filtered" });
});
t("decimals are not links", () => assert.equal(filterText("mcap 1.5m and 0.25 eth").text, "mcap 1.5m and 0.25 eth"));
t("profanity masked (incl leet)", () => {
  assert.equal(filterText("this is fucking great").text, "this is f****** great");
  assert.equal(filterText("sh1t").text, "s***");
  assert.equal(filterText("FUCK").text, "F***");
});
t("no false positives on cockpit / spice / Dickens", () => assert.equal(filterText("cockpit spice Dickens assess").text, "cockpit spice Dickens assess"));
t("control/zero-width chars removed", () => assert.equal(filterText("g\u200bm\u0007").text, "gm"));

t("burst of 5 then limited", () => {
  let b = null; const now = 1_000_000;
  for (let i = 0; i < 5; i++) { const r = take(b, now); assert.equal(r.ok, true, `msg ${i}`); b = r.bucket; }
  const r = take(b, now); assert.equal(r.ok, false); assert.equal(r.retryAfterMs, 2000);
});
t("refills 1 token per 2s, capped at burst", () => {
  let b = null; let now = 0;
  for (let i = 0; i < 5; i++) b = take(b, now).bucket;
  assert.equal(take(b, now + 1000).ok, false);
  const r = take(b, now + 1000); assert.equal(r.retryAfterMs, 1000);
  const r2 = take(b, now + 2000); assert.equal(r2.ok, true); b = r2.bucket;
  assert.equal(take(b, now + 2000).ok, false);
  // long idle → back to 5, not more
  let c = take(b, now + 10 ** 7).bucket; let ok = 1;
  for (let i = 0; i < 10; i++) { const x = take(c, now + 10 ** 7); if (!x.ok) break; c = x.bucket; ok++; }
  assert.equal(ok, 5);
});
t("steady 1 msg / 2s never limited", () => { let b = null; for (let i = 0; i < 50; i++) { const r = take(b, i * 2000); assert.equal(r.ok, true); b = r.bucket; } });
t("ulid sortable + monotonic within ms", () => {
  const a = ulid(1000), b = ulid(1000), c = ulid(1001);
  assert.equal(a.length, 26); assert.ok(a < b && b < c);
});
console.log(`\n${n} chat tests passed`);
