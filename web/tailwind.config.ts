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
        // DISCIPLE v1 brand tokens (Lunar Refined) — see app/brand-tokens.css. Gold is retired.
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
      },
      fontFamily: {
        display: ["Georgia", "serif"],
        mono: ["ui-monospace", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
