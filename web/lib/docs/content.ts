/**
 * Docs v1 DRAFT (temporary mockup at /docs). Reads web/content/docs/v1/<section>/<page>.md at BUILD time:
 * every page is statically generated, so neither fs nor `marked` ships to the browser.
 * Front matter (title / slug / section) drives the sidebar; order comes from the numeric file prefixes.
 * [CONFIRM: …] review markers render as a small muted "Being verified" note (no bracket text, no internal names).
 */
import "server-only";
import fs from "node:fs";
import path from "node:path";
import { Marked, type Tokens } from "marked";
import { withBase } from "@/lib/base-path";

const ROOT = path.join(process.cwd(), "content/docs/v1");
const VERIFY = "%%DV_VERIFY%%";
const ADDR = "%%DV_ADDR%%";
/** Any 40-hex 0x address (contract or token). Hidden in the draft until FLOW re-verifies addresses against chain. */
const ADDR_RE = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;
/**
 * The ONLY addresses allowed to render. Verified on Robinhood Chain testnet (46630, rpc.testnet.chain.robinhood.com)
 * on 2026-10-17: code present, same address as lib/chains.ts RH_V4 + contracts/deployments/rh-testnet-46630.json, and:
 *  - PoolManager: DiscipleRouter/DiscipleHook/LockedLP .poolManager() all return it; owner() responds.
 *  - StateView: poolManager() = PoolManager; getSlot0 on the smoke coin's v4 pool returns live state (used by the indexer).
 *  - UniversalRouter: poolManager() = PoolManager (canonical RH router; the app no longer routes through it).
 *  - Permit2: canonical address; DOMAIN_SEPARATOR() matches EIP-712 for chain 46630.
 * Not allowlisted (stays hidden): V4Quoter (the app quotes through DiscipleRouter.quoteExactIn, not V4Quoter),
 * test tokens, and every DISCIPLE contract (they change at the redeploy).
 */
const ADDR_ALLOW = new Set([
  "0x8366a39cc670b4001a1121b8f6a443a643e40951", // Uniswap v4 PoolManager
  "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b", // Uniswap v4 StateView
  "0x8876789976decbfcbbbe364623c63652db8c0904", // Uniswap UniversalRouter
  "0x000000000022d473030f116ddee9f6b43ac78ba3", // Permit2 (canonical)
]);
const ADDR_HTML =
  '<span class="dv-verify dv-verify-addr" title="This address is being checked against the live deployment."><span class="dv-verify-dot" aria-hidden="true"></span>Address being verified</span>';
const VERIFY_HTML =
  '<span class="dv-verify" title="This detail is still being checked and may change."><span class="dv-verify-dot" aria-hidden="true"></span>Being verified</span>';

export type TocItem = { id: string; text: string; depth: 2 | 3 };
export type DocMeta = { title: string; slug: string; section: string; file: string };
export type DocPage = DocMeta & { titleHtml: string; html: string; toc: TocItem[]; verifyCount: number; addrCount: number };
export type DocSection = { title: string; pages: DocMeta[] };

function frontMatter(src: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { data: {}, body: src };
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) data[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return { data, body: src.slice(m[0].length) };
}

let cache: DocMeta[] | null = null;
/** All pages in reading order (section dir prefix, then file prefix). */
export function allDocs(): DocMeta[] {
  if (cache) return cache;
  const out: DocMeta[] = [];
  for (const dir of fs.readdirSync(ROOT).filter((d) => fs.statSync(path.join(ROOT, d)).isDirectory()).sort()) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith(".md")).sort()) {
      const file = path.join(dir, f);
      const { data } = frontMatter(fs.readFileSync(path.join(ROOT, file), "utf8"));
      if (!data.slug || !data.slug.startsWith("/docs")) throw new Error(`docs: ${file} has no /docs slug`);
      out.push({ title: data.title || f, slug: data.slug.replace(/\/+$/, "") || "/docs", section: data.section || dir, file });
    }
  }
  const seen = new Set<string>();
  for (const d of out) { if (seen.has(d.slug)) throw new Error(`docs: duplicate slug ${d.slug}`); seen.add(d.slug); }
  cache = out;
  return out;
}

export function docSections(): DocSection[] {
  const out: DocSection[] = [];
  for (const d of allDocs()) {
    const last = out[out.length - 1];
    if (last && last.title === d.section) last.pages.push(d);
    else out.push({ title: d.section, pages: [d] });
  }
  return out;
}

/** "/docs/launch/modes" -> ["launch", "modes"]; "/docs" -> [] */
export const slugParts = (slug: string) => slug.replace(/^\/docs\/?/, "").split("/").filter(Boolean);
export const findDoc = (parts: string[]) => allDocs().find((d) => d.slug === ["/docs", ...parts].join("/")) ?? null;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const plain = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const slugify = (s: string) => plain(s).toLowerCase().replace(/[`*_~]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";

export function renderDoc(meta: DocMeta): DocPage {
  const { body } = frontMatter(fs.readFileSync(path.join(ROOT, meta.file), "utf8"));
  let verifyCount = 0;
  let addrCount = 0;
  const src = body
    .replace(/[ \t]*\[CONFIRM:[^\]]*\]/g, () => { verifyCount++; return " " + VERIFY; })
    // Contract/token addresses are hidden in the rendered draft (source md untouched, so re-syncs stay hidden).
    .replace(new RegExp("`?(" + ADDR_RE.source + ")`?", "g"), (m: string, a: string) => {
      if (ADDR_ALLOW.has(a.toLowerCase())) return m;
      addrCount++;
      return ADDR;
    });
  const toc: TocItem[] = [];
  const used = new Map<string, number>();
  const md = new Marked({ gfm: true });
  md.use({
    renderer: {
      // Raw HTML in the markdown is shown as text (e.g. `"<your name>'s Rocket"`), never injected.
      html(t: Tokens.HTML | Tokens.Tag) { return esc(t.text); },
      heading(t: Tokens.Heading) {
        const inner = this.parser.parseInline(t.tokens);
        if (t.depth === 1) return `<h1 class="dv-h1">${inner}</h1>\n`;
        const base = slugify(inner.replace(VERIFY, ""));
        const n = used.get(base) ?? 0; used.set(base, n + 1);
        const id = n ? `${base}-${n}` : base;
        if (t.depth === 2 || t.depth === 3) toc.push({ id, text: plain(inner.replace(VERIFY, "")).trim(), depth: t.depth });
        return `<h${t.depth} id="${id}"><a class="dv-anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${t.depth}>\n`;
      },
      link(t: Tokens.Link) {
        const inner = this.parser.parseInline(t.tokens);
        const ext = /^https?:\/\//.test(t.href);
        const href = ext ? t.href : withBase(t.href);
        return `<a href="${esc(href)}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ""}>${inner}</a>`;
      },
    },
  });
  let html = md.parse(src, { async: false }) as string;
  html = html
    .replace(/<table>/g, '<div class="dv-table"><table>').replace(/<\/table>/g, "</table></div>")
    .split(VERIFY).join(VERIFY_HTML)
    .split(ADDR).join(ADDR_HTML);
  // A blockquote / paragraph that was ONLY a review marker becomes a quiet standalone note.
  html = html.replace(/<blockquote>\s*<p>\s*(<span class="dv-verify"[\s\S]*?Being verified<\/span>)\s*<\/p>\s*<\/blockquote>/g, '<p class="dv-verify-solo">$1</p>');
  html = html.replace(/<p>\s*(<span class="dv-verify"[\s\S]*?Being verified<\/span>)\s*<\/p>/g, '<p class="dv-verify-solo">$1</p>');
  if (/\[CONFIRM|CONFIRM:/.test(html)) throw new Error(`docs: unrendered review marker in ${meta.file}`);
  const leaked = (html.match(new RegExp(ADDR_RE.source, "g")) ?? []).filter((a) => !ADDR_ALLOW.has(a.toLowerCase()));
  if (leaked.length || html.includes("%%DV_")) throw new Error(`docs: non-allowlisted 0x address (or sentinel) in ${meta.file}: ${leaked.join(", ")}`);
  // The page H1 renders above the mobile "On this page" list, so lift it out of the body.
  let titleHtml = esc(meta.title);
  html = html.replace(/^\s*<h1 class="dv-h1">([\s\S]*?)<\/h1>\n?/, (_, h: string) => { titleHtml = h; return ""; });
  return { ...meta, titleHtml, html, toc, verifyCount, addrCount };
}
