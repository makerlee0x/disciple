import type { Metadata } from "next";

/** Page metadata with its own link preview card (step 7). `card` is an /api/og/... path. */
export function cardMeta(title: string, description: string, card: string, alt: string): Metadata {
  const image = { url: card, width: 1200, height: 630, alt };
  return {
    title, description,
    openGraph: { title, description, siteName: "DISCIPLE", type: "website", images: [image] },
    twitter: { card: "summary_large_image", site: "@disciplevip", title, description, images: [card] },
  };
}

/** "KÁRMÁN LINE" → "Kármán Line". */
export const titleCase = (s: string) => s.toLowerCase().split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
