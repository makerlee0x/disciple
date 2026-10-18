import localFont from "next/font/local";

/** Geist Mono (SIL OFL) for the page's eyebrows, labels and figures; scoped to /how-it-works. Latin subset (Basic Latin, Latin-1,
 * punctuation and the few symbols in content/how-it-works.ts) as woff2: app/fonts/GeistMonoVF-latin.woff2, 31 KB vs 68 KB woff.
 * Preloaded: the hero eyebrow uses it, and a font first requested during layout makes Chrome hold the first paint (render-
 * blocking fonts, up to ~1s). Measured: preloading it took mobile Lighthouse FCP 1.97s → 1.21s. */
export const geistMono = localFont({
  src: "../fonts/GeistMonoVF-latin.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  preload: true,
  variable: "--font-geist-mono",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
});
