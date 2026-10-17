/**
 * Signer-mode constants with no dependencies, so the root layout (components/PrivyProviders.tsx) can decide whether to
 * mount Privy without pulling viem + @noble/curves (lib/aa/session.ts) into every page's first-load JS.
 * lib/aa/session.ts re-exports both; keep the logic here.
 */
/** Privy app id. Vercel previews use a separate dev app (NEXT_PUBLIC_PRIVY_APP_ID_PREVIEW) — see PR #59 notes. */
export const PRIVY_APP_ID = (process.env.NEXT_PUBLIC_VERCEL_ENV === "preview" && process.env.NEXT_PUBLIC_PRIVY_APP_ID_PREVIEW) || process.env.NEXT_PUBLIC_PRIVY_APP_ID || "";
export const SIGNER_MODE: "privy" | "local" = PRIVY_APP_ID && process.env.NEXT_PUBLIC_AA_SIGNER !== "local" ? "privy" : "local";
