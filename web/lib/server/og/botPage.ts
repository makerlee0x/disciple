import "server-only";
/**
 * Invite links (/i/<CODE>, /r/<name>) redirect people straight on. Link preview crawlers get a tiny page with the
 * invite card's tags instead, because a redirect would show them the target's card, not the invite. The page is never
 * cached (private, no-store, Vary: User-Agent): a shared cache keyed only on the URL would hand it to people too, and
 * they would skip the redirect and the first-touch referral cookie.
 */
import { NextResponse } from "next/server";

const BOTS = /twitterbot|facebookexternalhit|facebookcatalog|discordbot|slackbot|telegrambot|whatsapp|linkedinbot|skypeuripreview|redditbot|embedly|pinterest|applebot|iframely|mastodon/i;
/** Absolute links on the crawler page use the site's own origin, never the request's Host header. Vercel previews use their deployment URL. */
export const SITE_ORIGIN = process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://disciple.vip";
export const isPreviewBot = (ua: string | null) => !!ua && BOTS.test(ua);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function previewPage({ title, description, image, url, to }: { title: string; description: string; image: string; url: string; to: string }): NextResponse {
  const t = esc(title), d = esc(description), i = esc(image), u = esc(url), r = esc(to);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${t}</title>
<meta name="description" content="${d}">
<meta property="og:type" content="website"><meta property="og:site_name" content="DISCIPLE">
<meta property="og:title" content="${t}"><meta property="og:description" content="${d}"><meta property="og:url" content="${u}">
<meta property="og:image" content="${i}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@disciplevip">
<meta name="twitter:title" content="${t}"><meta name="twitter:description" content="${d}"><meta name="twitter:image" content="${i}">
<meta http-equiv="refresh" content="0;url=${r}"></head><body><a href="${r}">${t}</a></body></html>`;
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", vary: "User-Agent" } });
}
