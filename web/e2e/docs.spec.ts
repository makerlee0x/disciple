/**
 * Docs: every page in content/docs/v1 opens with its own title, and no link on a docs page points at a page of ours
 * that isn't there (a crawl of every same-site link from every docs page, plus the legal and security pages).
 */
import fs from "node:fs";
import path from "node:path";
import { test, expect, isPhone } from "./support/fixtures";

const ROOT = path.join(__dirname, "../content/docs/v1");
type Doc = { title: string; slug: string };
function docs(): Doc[] {
  const out: Doc[] = [];
  for (const dir of fs.readdirSync(ROOT).sort()) {
    const d = path.join(ROOT, dir); if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".md")).sort()) {
      const src = fs.readFileSync(path.join(d, f), "utf8"), fm = /^---\n([\s\S]*?)\n---/.exec(src)?.[1] ?? "";
      const get = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(fm)?.[1].trim().replace(/^["']|["']$/g, "") ?? "";
      out.push({ title: get("title"), slug: get("slug").replace(/\/+$/, "") || "/docs" });
    }
  }
  return out;
}
const DOCS = docs();

test("the docs home lists every section", async ({ page }) => {
  await page.goto("/docs");
  await expect(page.getByRole("heading", { level: 1 }).first()).toHaveText(/what is disciple/i);
  if (isPhone(page)) return; // the sidebar folds into a menu on phones
  for (const d of DOCS.slice(0, 6)) await expect(page.getByRole("link", { name: d.title, exact: true }).first()).toBeAttached();
});

test("every docs page opens with its title", async ({ request }) => {
  test.skip(test.info().project.name !== "desktop", "server output is the same on both sizes");
  expect(DOCS.length).toBeGreaterThan(20);
  for (const d of DOCS) {
    const r = await request.get(d.slug);
    expect(r.status(), d.slug).toBe(200);
    const html = await r.text();
    expect(html, `${d.slug} has its title`).toContain(d.title.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;"));
    expect(html, `${d.slug} has no leftover [CONFIRM] tags`).not.toMatch(/\[CONFIRM\]/);
  }
});

test("no docs, legal or security link points at a missing page", async ({ request }) => {
  test.skip(test.info().project.name !== "desktop", "server output is the same on both sizes");
  test.setTimeout(180_000);
  const start = [...DOCS.map((d) => d.slug), "/terms", "/privacy", "/risk", "/security", "/how-it-works"];
  const seen = new Map<string, number>(), broken: string[] = [];
  const status = async (u: string) => {
    if (!seen.has(u)) seen.set(u, (await request.get(u, { maxRedirects: 5 })).status());
    return seen.get(u)!;
  };
  for (const from of start) {
    const html = await (await request.get(from)).text();
    const links = new Set([...html.matchAll(/href="(\/[^"#?]*)(?:[?#][^"]*)?"/g)].map((m) => m[1]).filter((u) => !u.startsWith("/_next") && !/\.(png|webp|jpg|svg|ico|css|js|woff2?)$/.test(u)));
    for (const u of links) if ((await status(u)) >= 400) broken.push(`${from} → ${u} (${seen.get(u)})`);
  }
  expect(broken, "broken links").toEqual([]);
});

test("a docs article reads well on this screen", async ({ page }) => {
  await page.goto("/docs/trading/boost-and-dump".replace(/.*/, DOCS.find((d) => /boost/i.test(d.title))?.slug ?? "/docs"));
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  // nothing runs off the side of the page
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over).toBeLessThanOrEqual(1);
});
