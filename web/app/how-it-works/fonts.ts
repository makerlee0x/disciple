import localFont from "next/font/local";

/** Geist Mono (SIL OFL) for the page's eyebrows, labels and figures; scoped to /how-it-works. Latin subset (Basic Latin, Latin-1,
 * punctuation and the few symbols in content/how-it-works.ts) as woff2: app/fonts/GeistMonoVF-latin.woff2, 31 KB vs 68 KB woff.
 * Not preloaded: it is never the LCP text, so it must not compete with the hero image; system mono shows until it swaps in. */
export const geistMono = localFont({
  src: "../fonts/GeistMonoVF-latin.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  preload: false,
  variable: "--font-geist-mono",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
});
