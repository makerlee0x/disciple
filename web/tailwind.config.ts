import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        // DISCIPLE brand tokens (Lunar Refined) — see app/brand-tokens.css (v1) + app/brand-tokens-v2.css (v2, additive).
        // Gold allowed (--dsc-gold #F2C14E, --dsc-champagne #F3DFA8); never #D9B86A.
        bg: "var(--dsc-bg)",
        surface: "var(--dsc-surface)",
        "surface-2": "var(--dsc-surface-2)",
        border: "var(--dsc-border)",
        text: "var(--dsc-text)",
        muted: "var(--dsc-muted)",
        primary: "var(--dsc-primary)",
        secondary: "var(--dsc-secondary)",
        up: "var(--dsc-up)",
        down: "var(--dsc-down)",
        warning: "var(--dsc-warning)",
        gold: "var(--dsc-gold)",
        champagne: "var(--dsc-champagne)",
        "muted-on-sky": "var(--dsc-muted-on-sky)",
      },
      fontFamily: {
        // Synced from disciple-brand/release/v1/tokens/tailwind.config.snippet.js
        display: ["var(--dsc-font-display)"],
        sans: ["var(--dsc-font-ui)"],
        ui: ["var(--dsc-font-ui)"],
        mono: ["var(--dsc-font-mono)"],
      },
    },
  },
  plugins: [],
};
export default config;
