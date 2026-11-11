/**
 * /terms, /privacy, /risk. Copy lives in web/content/legal/*.md and is rendered at build time, the same way
 * /security is (lib/security/content.ts): neither fs nor `marked` ships to the browser. Raw HTML is escaped.
 * Every [CONFIRM: visible blank] stays visible, highlighted, in square brackets. The source note is the blank itself.
 */
import "server-only";
import fs from "node:fs";
import path from "node:path";
import { Marked, type Tokens } from "marked";
import { withBase } from "@/lib/base-path";
import type { DocMeta, DocPage, TocItem } from "@/lib/docs/content";

const DIR = path.join(process.cwd(), "content/legal");
const ORDER = ["terms", "privacy", "risk"] as const;
export type LegalId = (typeof ORDER)[number];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const plain = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const slugify = (s: string) => plain(s).toLowerCase().replace(/[`*_~]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";

const blankHtml = (text: string) => `<span class="dv-blank">[${esc(text)}]</span>`;

/** Markdown → page. Exported for tests (scripts/test-legal-pages.mts). */
export function renderLegal(src: string, id: LegalId): DocPage & { pending: number } {
  const blanks: string[] = [];
  const body = src
    .replace(/<!--[\s\S]*?-->\s*/g, "")
    .replace(/[ \t]*\[CONFIRM:\s*([^\]]+)\]/g, (_, text: string) => {
      const label = text.trim();
      if (!label) throw new Error(`legal/${id}: empty [CONFIRM]`);
      blanks.push(label);
      return ` %%LEGAL_BLANK_${blanks.length - 1}%%`;
    });
  const toc: TocItem[] = [];
  const used = new Map<string, number>();
  const md = new Marked({ gfm: true });
  md.use({
    renderer: {
      html(t: Tokens.HTML | Tokens.Tag) { return esc(t.text); },
      heading(t: Tokens.Heading) {
        const inner = this.parser.parseInline(t.tokens);
        if (t.depth === 1) return `<h1 class="dv-h1">${inner}</h1>\n`;
        const base = slugify(inner.replace(/%%LEGAL_BLANK_\d+%%/g, ""));
        const n = used.get(base) ?? 0; used.set(base, n + 1);
        const hid = n ? `${base}-${n}` : base;
        if (t.depth === 2 || t.depth === 3) toc.push({ id: hid, text: plain(inner.replace(/%%LEGAL_BLANK_\d+%%/g, "")).trim(), depth: t.depth });
        return `<h${t.depth} id="${hid}"><a class="dv-anchor" href="#${hid}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${t.depth}>\n`;
      },
      link(t: Tokens.Link) {
        const inner = this.parser.parseInline(t.tokens);
        const ext = /^(https?:|mailto:)/.test(t.href);
        return `<a href="${esc(ext ? t.href : withBase(t.href))}"${/^https?:/.test(t.href) ? ' target="_blank" rel="noopener noreferrer"' : ""}>${inner}</a>`;
      },
    },
  });
  let html = md.parse(body, { async: false }) as string;
  html = html.replace(/<table>/g, '<div class="dv-table"><table>').replace(/<\/table>/g, "</table></div>");
  html = html.replace(/%%LEGAL_BLANK_(\d+)%%/g, (_, i: string) => blankHtml(blanks[Number(i)] ?? ""));
  if (/CONFIRM:|%%LEGAL_BLANK_/.test(html)) throw new Error(`legal/${id}: unrendered review marker`);
  let titleHtml: string = id;
  html = html.replace(/^\s*<h1 class="dv-h1">([\s\S]*?)<\/h1>\n?/, (_, h: string) => { titleHtml = h; return ""; });
  return {
    title: plain(titleHtml),
    slug: `/${id}`,
    section: "Legal",
    file: `${id}.md`,
    titleHtml,
    html,
    toc,
    verifyCount: blanks.length,
    addrCount: 0,
    pending: blanks.length,
  };
}

const cache = new Map<LegalId, ReturnType<typeof renderLegal>>();
export function legalPage(id: LegalId) {
  const hit = cache.get(id);
  if (hit) return hit;
  const page = renderLegal(fs.readFileSync(path.join(DIR, `${id}.md`), "utf8"), id);
  cache.set(id, page);
  return page;
}

function metaOf(id: LegalId): DocMeta {
  const p = legalPage(id);
  return { title: p.title, slug: p.slug, section: p.section, file: p.file };
}

export function legalView(id: LegalId) {
  const i = ORDER.indexOf(id);
  return {
    page: legalPage(id),
    prev: i > 0 ? metaOf(ORDER[i - 1]) : null,
    next: i < ORDER.length - 1 ? metaOf(ORDER[i + 1]) : null,
  };
}
