/**
 * /security copy: web/content/security.md (BRAND draft, pending lee). Rendered at BUILD time, like lib/docs/content,
 * so neither fs nor `marked` ships to the browser. Raw HTML in the markdown is shown as text; HTML comments are dropped.
 * Every [CONFIRM: …] marker renders as a visible "To be confirmed" tag (the note itself stays in the source only).
 */
import "server-only";
import fs from "node:fs";
import path from "node:path";
import { Marked, type Tokens } from "marked";
import { withBase } from "@/lib/base-path";
import type { DocPage, TocItem } from "@/lib/docs/content";

const FILE = path.join(process.cwd(), "content/security.md");
const TBC = "%%SEC_TBC%%";
const TBC_HTML = '<span class="dv-verify" title="This detail will be filled in before launch."><span class="dv-verify-dot" aria-hidden="true"></span>To be confirmed</span>';

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const plain = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const slugify = (s: string) => plain(s).toLowerCase().replace(/[`*_~]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";

/** Markdown → page. Exported for tests (scripts/test-security-page.mts). */
export function renderSecurity(src: string): DocPage & { pending: number } {
  let pending = 0;
  const body = src
    .replace(/<!--[\s\S]*?-->\s*/g, "")
    .replace(/[ \t]*\[CONFIRM:[^\]]*\]/g, () => { pending++; return " " + TBC; });
  const toc: TocItem[] = [];
  const used = new Map<string, number>();
  const md = new Marked({ gfm: true });
  md.use({
    renderer: {
      html(t: Tokens.HTML | Tokens.Tag) { return esc(t.text); },
      heading(t: Tokens.Heading) {
        const inner = this.parser.parseInline(t.tokens);
        if (t.depth === 1) return `<h1 class="dv-h1">${inner}</h1>\n`;
        const base = slugify(inner.replace(TBC, ""));
        const n = used.get(base) ?? 0; used.set(base, n + 1);
        const id = n ? `${base}-${n}` : base;
        if (t.depth === 2 || t.depth === 3) toc.push({ id, text: plain(inner.replace(TBC, "")).trim(), depth: t.depth });
        return `<h${t.depth} id="${id}"><a class="dv-anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${t.depth}>\n`;
      },
      link(t: Tokens.Link) {
        const inner = this.parser.parseInline(t.tokens);
        const ext = /^(https?:|mailto:)/.test(t.href);
        return `<a href="${esc(ext ? t.href : withBase(t.href))}"${/^https?:/.test(t.href) ? ' target="_blank" rel="noopener noreferrer"' : ""}>${inner}</a>`;
      },
    },
  });
  let html = md.parse(body, { async: false }) as string;
  html = html.replace(/<table>/g, '<div class="dv-table"><table>').replace(/<\/table>/g, "</table></div>").split(TBC).join(TBC_HTML);
  if (/CONFIRM:|%%SEC_/.test(html)) throw new Error("security: unrendered review marker in content/security.md");
  let titleHtml = "Security";
  html = html.replace(/^\s*<h1 class="dv-h1">([\s\S]*?)<\/h1>\n?/, (_, h: string) => { titleHtml = h; return ""; });
  return { title: plain(titleHtml), slug: "/security", section: "Security", file: "security.md", titleHtml, html, toc, verifyCount: pending, addrCount: 0, pending };
}

let cache: ReturnType<typeof renderSecurity> | null = null;
export const securityPage = () => (cache ??= renderSecurity(fs.readFileSync(FILE, "utf8")));
