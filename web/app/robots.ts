import type { MetadataRoute } from "next";

/** robots.txt (SEO/AEO pass, maker 2026-11-18). Private and test routes stay out; noindex pages (docs draft, Turbo) carry their own tag. */
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/admin/", "/dev/", "/api/", "/lighter/", "/settings/", "/wallet/"] }],
    sitemap: "https://disciple.vip/sitemap.xml",
    host: "https://disciple.vip",
  };
}
