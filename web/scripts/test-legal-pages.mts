/** /terms /privacy /risk: plain pages, a blanket waiver, no placeholders, no positive product claims. */
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
const WAIVER = "You use DISCIPLE at your own risk. There are no guarantees of any kind, and using it is not safe. You can lose everything you put in. Nothing here is financial, legal, or tax advice. You are responsible for your own wallet, your login, and your own choices. The team behind DISCIPLE is not liable for losses or problems that come from using it.";

/** Markdown links use brackets that visitors never see. Strip them, then forbid a leftover bracket. */
const visitorSource = (src: string) => src.replace(/<!--[\s\S]*?-->/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

test("each page names itself and links the other two", () => {
  assert.equal(pages.terms.page.title, "Terms of Use");
  assert.equal(pages.privacy.page.title, "Privacy Policy");
  assert.equal(pages.risk.page.title, "Read this before you trade");
  for (const id of IDS) assert.ok(pages[id].page.toc.length >= 5, `${id} toc`);
  assert.match(pages.terms.page.html, /href="\/privacy"/);
  assert.match(pages.terms.page.html, /href="\/risk"/);
  assert.match(pages.privacy.page.html, /href="\/terms"/);
  assert.match(pages.privacy.page.html, /href="\/risk"/);
  assert.match(pages.risk.page.html, /href="\/terms"/);
  assert.match(pages.risk.page.html, /href="\/privacy"/);
});

test("no placeholder, draft note, or lawyer line remains", () => {
  const banned = /\[|\bCONFIRM\b|to be added|No lawyer/i;
  assert.doesNotMatch(html, banned);
  for (const id of IDS) {
    assert.doesNotMatch(pages[id].src, /\bCONFIRM\b|to be added|No lawyer/i);
    assert.doesNotMatch(visitorSource(pages[id].src), banned);
  }
  const chrome = ["layout.tsx", "terms/page.tsx", "privacy/page.tsx", "risk/page.tsx"]
    .map((f) => fs.readFileSync(new URL(`../app/(legal)/${f}`, import.meta.url), "utf8"))
    .join("\n");
  assert.doesNotMatch(chrome, banned);
});

test("Terms and Risk carry the same plain waiver", () => {
  assert.ok(pages.terms.page.html.includes(WAIVER));
  assert.ok(pages.risk.page.html.includes(WAIVER));
  assert.doesNotMatch(pages.privacy.page.html, /not liable/);
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
  assert.match(html, /does not include a separate analytics tool/);
});

test("does not make a positive claim that the product is audited, safe, secure, or guaranteed, and hides addresses", () => {
  assert.doesNotMatch(html, /\bis audited\b|\baudited\b|\bis secure\b|\bsecure\b|guaranteed returns|\bguaranteed\b/i);
  assert.doesNotMatch(html, /\bis safe\b/i);
  assert.match(html, /is not safe/);
  assert.match(html, /no guarantees/i);
  assert.doesNotMatch(html, /0x[0-9a-fA-F]{40}/);
  assert.doesNotMatch(html, /smart account|embedded wallet|paymaster|ERC-20|on-chain|\bgraduation\b|testnet|test funds|achievements reset/i);
});

test("raw HTML is escaped, comments are dropped, and a placeholder cannot render", () => {
  const p = renderLegal("<!-- secret note -->\n# T\n\n<script>x</script>\n\nhi there", "terms");
  assert.doesNotMatch(p.html, /<script>|secret note/);
  assert.match(p.html, /&lt;script&gt;/);
  assert.throws(() => renderLegal("# T\n\n[CONFIRM: A blank to be added]", "terms"));
  assert.throws(() => renderLegal("# T\n\nNo lawyer has read this.", "terms"));
});
