import { Instrument_Serif } from "next/font/google";
import localFont from "next/font/local";

/** Brand v1 type: Instrument Serif (display/headings) + Geist (UI/body). Both SIL OFL. */
export const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: "normal", // italic was never used and cost a second preloaded file on every page
  display: "swap", // metric-matched fallback (next/font adjustFontFallback) keeps the swap shift-free
  preload: true, // the only preloaded font: it sets the headline
  variable: "--font-instrument-serif",
  fallback: ["Georgia", "serif"],
});

// Geist variable (wght 100–900), self-hosted (app/fonts/GeistVF.woff2) with a size-adjusted Arial fallback. Not preloaded:
// body text paints at once in the metric-matched system fallback and swaps when Geist arrives, so the 55 KB file no longer
// competes with each page's LCP image/headline for bandwidth.
export const geist = localFont({
  src: "./fonts/GeistVF.woff2",
  preload: false,
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-geist",
  fallback: ["system-ui", "-apple-system", "Segoe UI", "sans-serif"],
  adjustFontFallback: "Arial",
});
