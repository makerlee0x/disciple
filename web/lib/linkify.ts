/**
 * Split plain text into text runs and http(s) links, for rendering a bio safely. Pure; no HTML is ever produced:
 * callers render text runs as React text and links as <a href={href}> (see components/profile/BioText).
 * Only http: / https: become links (no javascript:, data:, mailto:, bare domains). Trailing punctuation stays text.
 */
export type LinkPart = { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const TRAIL = /[.,;:!?)\]}'"»”’]+$/;

export function safeHttpUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname || u.username || u.password) return null;
    return u.href;
  } catch { return null; }
}

export function linkify(text: string): LinkPart[] {
  const out: LinkPart[] = [];
  const push = (t: string) => { if (!t) return; const last = out[out.length - 1]; if (last?.kind === "text") last.text += t; else out.push({ kind: "text", text: t }); };
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    // Must start a word: "xhttps://…" stays text.
    if (start > 0 && /[\p{L}\p{N}_]/u.test(text[start - 1])) continue;
    let raw = m[0];
    const trail = raw.match(TRAIL)?.[0] ?? "";
    if (trail) raw = raw.slice(0, -trail.length);
    const href = safeHttpUrl(raw);
    push(text.slice(at, start));
    if (href) out.push({ kind: "link", text: raw, href }); else push(raw);
    push(trail);
    at = start + m[0].length;
  }
  push(text.slice(at));
  return out;
}
