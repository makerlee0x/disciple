import { Instrument_Serif } from "next/font/google";
import localFont from "next/font/local";

/** Brand v1 type: Instrument Serif (display/headings) + Geist (UI/body). Both SIL OFL. */
export const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: "normal", // italic was never used and cost a second preloaded file on every page
  display: "swap", // metric-matched fallback (next/font adjustFontFallback) keeps the swap shift-free
  variable: "--font-instrument-serif",
  fallback: ["Georgia", "serif"],
});

// Geist variable (wght 100–900), self-hosted (app/fonts/GeistVF.woff2, 55 KB vs 66 KB as woff) so next/font can preload +
// size-adjust the fallback. Keep it preloaded: Chrome's render-blocking fonts hold the first paint (up to ~1s) for a font
// that is first requested during layout, so a late-discovered Geist delays FCP/LCP more than its bytes cost.
export const geist = localFont({
  src: "./fonts/GeistVF.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-geist",
  fallback: ["system-ui", "-apple-system", "Segoe UI", "sans-serif"],
  adjustFontFallback: "Arial",
});
