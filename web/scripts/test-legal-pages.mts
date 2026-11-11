/** /terms /privacy /risk: plain draft copy, visible blanks, no testnet promises, no forbidden product claims. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { renderLegal, type LegalId } from "../lib/legal/content.ts";

const IDS = ["terms", "privacy", "risk"] as const;
const pages = Object.fromEntries(IDS.map((id) => {
  const src = fs.readFileSync(new URL(`../content/legal/${id}.md`, import.meta.url), "utf8");
  return [id, { src, page: renderLegal(src, id as LegalId) }];
})) as Record<LegalId, { src: string; page: ReturnType<typeof renderLegal> }>;

const html = IDS.map((id) => pages[id].page.html).join("\n");
const confirmCount = (src: string) => (src.replace(/<!--[\s\S]*?-->/g, "").match(/\[CONFIRM:/g) || []).length;

test("each page names itself, warns that no lawyer has read it, and links the other two", () => {
  assert.equal(pages.terms.page.title, "Terms of Use");
  assert.equal(pages.privacy.page.title, "Privacy Policy");
  assert.equal(pages.risk.page.title, "Read this before you trade");
  for (const id of IDS) {
    const p = pages[id].page;
    assert.match(p.html, /No lawyer has read this/);
    assert.match(p.html, /Last updated:/);
    assert.match(p.html, /\[Date to be added\]/);
    assert.ok(p.toc.length >= 5, `${id} toc`);
  }
  assert.match(pages.terms.page.html, /href="\/privacy"/);
  assert.match(pages.terms.page.html, /href="\/risk"/);
  assert.match(pages.privacy.page.html, /href="\/terms"/);
  assert.match(pages.privacy.page.html, /href="\/risk"/);
  assert.match(pages.risk.page.html, /href="\/terms"/);
  assert.match(pages.risk.page.html, /href="\/privacy"/);
});

test("every blank is visible, and no review marker leaks", () => {
  const want = [
    "Date to be added",
    "Operator name and address to be added",
    "Restricted places to be added",
    "Whether automated trading is allowed to be added",
    "Liability cap to be added",
    "Governing law and how disputes are handled to be added",
    "Contact email to be added",
    "X sign-in details to be added",
    "How the in-app wallet's keys are stored to be added",
    "Cookie notice to be added",
    "Analytics provider to be added",
    "How long we keep data to be added",
    "How to ask about your data to be added",
    "Privacy contact email to be added",
  ];
  for (const label of want) assert.ok(html.includes(`[${label}]`), label);
  let n = 0;
  for (const id of IDS) {
    const c = confirmCount(pages[id].src);
    assert.equal(pages[id].page.pending, c, id);
    assert.equal((pages[id].page.html.match(/class="dv-blank"/g) || []).length, c, id);
    n += c;
  }
  assert.equal(n, 17);
  assert.doesNotMatch(html, /CONFIRM:|%%LEGAL_BLANK_|testnet|achievements reset|test funds/i);
});

test("sign-in line, fees, and the locked-LP sentence match the code we could verify", () => {
  assert.match(html, /Sign in with email, Google, X or wallet/);
  assert.match(html, /a 1% fee/);
  assert.match(html, /from 0% up to 7%/);
  assert.match(html, /0\.777%/);
  assert.match(html, /rises to 3\.33%/);
  assert.match(html, /rises to 7\.77%/);
  assert.match(html, /locked forever in the Uniswap v4 LP/);
  assert.match(html, /wallet alone does not pass/);
  assert.match(html, /Privy/);
  assert.match(html, /Alchemy/);
  assert.match(html, /Upstash/);
  assert.match(html, /Vercel/);
  assert.match(html, /Google Cloud Vision/);
});

test("does not claim the product is audited, safe, secure, or guaranteed, and hides addresses", () => {
  assert.doesNotMatch(html, /\b(audited|guaranteed|safe|secure)\b/i);
  assert.doesNotMatch(html, /0x[0-9a-fA-F]{40}/);
  assert.doesNotMatch(html, /smart account|embedded wallet|paymaster|ERC-20|on-chain|\bgraduation\b/i);
});

test("raw HTML is escaped and comments are dropped", () => {
  const p = renderLegal("<!-- secret note -->\n# T\n\n<script>x</script>\n\nhi [CONFIRM: A blank to be added]", "terms");
  assert.doesNotMatch(p.html, /<script>|secret note/);
  assert.match(p.html, /&lt;script&gt;/);
  assert.match(p.html, /\[A blank to be added\]/);
  assert.equal(p.pending, 1);
});

test("the draft banner is on the shared legal layout", () => {
  const layout = fs.readFileSync(new URL("../app/(legal)/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /No lawyer has read this/);
});
