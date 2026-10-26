/** /security copy checks: renders, keeps "TBD by lee" rewards, marks every open item, drops comments, escapes raw HTML. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { renderSecurity } from "../lib/security/content.ts";

const src = fs.readFileSync(new URL("../content/security.md", import.meta.url), "utf8");
const page = renderSecurity(src);

test("title and required sections", () => {
  assert.equal(page.title, "Security at DISCIPLE");
  const t = page.toc.map((x) => x.text.toLowerCase());
  for (const want of ["scope", "how to report", "rewards", "safe harbor"]) assert.ok(t.some((x) => x.includes(want)), want);
  assert.match(page.html, /Out of scope/);
  assert.match(page.html, /hours/); // response times
});

test("rewards stay TBD by lee, no amounts", () => {
  assert.match(page.html, /Rewards: TBD by lee/);
  const rewards = page.html.slice(page.html.indexOf('id="rewards"'));
  assert.doesNotMatch(rewards.slice(0, rewards.indexOf("<h2", 10) >>> 0), /\$\s?\d/);
});

test("every [CONFIRM] shows as To be confirmed; none leak", () => {
  const n = (src.replace(/<!--[\s\S]*?-->/g, "").match(/\[CONFIRM:/g) || []).length;
  assert.equal(page.pending, n);
  assert.equal((page.html.match(/To be confirmed/g) || []).length, n);
  assert.doesNotMatch(page.html, /CONFIRM|lee wants|Copy pending/);
});

test("raw HTML escaped, comments dropped", () => {
  const p = renderSecurity("<!-- note -->\n# T\n\n<script>x</script>\n\nhi [CONFIRM: a]");
  assert.doesNotMatch(p.html, /<script>|note/);
  assert.match(p.html, /&lt;script&gt;/);
  assert.equal(p.pending, 1);
});

test("security.txt has the RFC 9116 required fields", () => {
  const t = fs.readFileSync(new URL("../public/.well-known/security.txt", import.meta.url), "utf8");
  assert.match(t, /^Contact: \S+/m);
  const exp = /^Expires: (\S+)/m.exec(t);
  assert.ok(exp && Date.parse(exp[1]) > Date.now(), "Expires in the future");
});
