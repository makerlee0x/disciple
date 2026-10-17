import { Instrument_Serif } from "next/font/google";
import localFont from "next/font/local";

/** Brand v1 type: Instrument Serif (display/headings) + Geist (UI/body). Both SIL OFL. */
export const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-instrument-serif",
  fallback: ["Georgia", "serif"],
});

// Geist variable (wght 100–900), self-hosted (app/fonts/GeistVF.woff) so next/font can preload + size-adjust the fallback.
export const geist = localFont({
  src: "./fonts/GeistVF.woff",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-geist",
  fallback: ["system-ui", "-apple-system", "Segoe UI", "sans-serif"],
  adjustFontFallback: "Arial",
});
