import localFont from "next/font/local";

/** Geist Mono (SIL OFL) for the page's eyebrows, labels and figures; scoped to /how-it-works (app/fonts/GeistMonoVF.woff). */
export const geistMono = localFont({
  src: "../fonts/GeistMonoVF.woff",
  weight: "100 900",
  style: "normal",
  display: "swap",
  preload: false,
  variable: "--font-geist-mono",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
});
