import type { MetadataRoute } from "next";

/** sitemap.xml (SEO/AEO pass, maker 2026-11-18): the public pages only. Docs join after mainnet (still a noindex draft). */
export const dynamic = "force-static";

const PAGES: [path: string, priority: number][] = [
  ["/", 1], ["/live", 0.9], ["/create", 0.8], ["/leaderboard", 0.7], ["/market", 0.7], ["/how-it-works", 0.7],
  ["/mint", 0.5], ["/security", 0.3], ["/risk", 0.3], ["/terms", 0.2], ["/privacy", 0.2], ["/support", 0.3],
];

export default function sitemap(): MetadataRoute.Sitemap {
  return PAGES.map(([path, priority]) => ({ url: `https://www.disciple.vip${path}`, changeFrequency: path === "/" || path === "/live" ? "hourly" : "weekly", priority }));
}
