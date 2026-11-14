import { statSync } from "node:fs";

/* Minified flight engine (scripts/minify-engine.mjs, run by `pnpm build`): pages load public/flight/engine.min.js only when it
   exists and is newer than engine.js, so dev and any build path that skipped the step keep loading the readable source. */
const engineMin = (() => {
  if (process.env.NODE_ENV !== "production") return false;
  try { return statSync(new URL("./public/flight/engine.min.js", import.meta.url)).mtimeMs >= statSync(new URL("./public/flight/engine.js", import.meta.url)).mtimeMs; } catch { return false; }
})();

/** @type {import('next').NextConfig} */
const isStatic = process.env.STATIC_PREVIEW === "1";
const basePath = isStatic
  ? process.env.NEXT_PUBLIC_BASE_PATH || "/makerlee0x/disciple/preview"
  : "";

const nextConfig = {
  // e2e builds go to their own folder (NEXT_DIST_DIR=.next-e2e, see playwright.config.ts) so they never clobber `next dev`
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  reactStrictMode: false, // flight engine IIFE must not double-mount
  // sdk/session-keys ships TypeScript source (workspace package)
  transpilePackages: ["@disciple/session-keys"],
  // Privy optional peer deps we don't use (Solana / Farcaster mini-apps are off)
  webpack(config) {
    config.resolve.alias = { ...(config.resolve.alias || {}), "@farcaster/mini-app-solana": false };
    return config;
  },
  ...(isStatic
    ? {
        output: "export",
        basePath,
        assetPrefix: basePath,
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {}),
  // Next 15: serverComponentsExternalPackages → serverExternalPackages;
  // outputFileTracingIncludes moved out of experimental.
  serverExternalPackages: ["sharp", "nsfwjs", "@tensorflow/tfjs", "@napi-rs/canvas", "undici"],
  outputFileTracingIncludes: {
    "/api/share/card": ["./public/fonts/share/**", "./public/assets/**"],
    "/api/daily/card": ["./public/fonts/share/**", "./public/free-play/**"],
    // link preview cards: fonts, tier skies, rocket, mark, and the art plates in public/og once they land
    "/api/og/[kind]": ["./public/fonts/share/**", "./public/assets/**", "./public/home/sky/**", "./public/brand/**", "./public/og/**"],
  },
  env: {
    // lets the client pick NEXT_PUBLIC_PRIVY_APP_ID_PREVIEW on Vercel preview deployments
    NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV || "",
    NEXT_PUBLIC_FLIGHT_ENGINE: engineMin ? "/flight/engine.min.js" : "/flight/engine.js",
    ...(isStatic ? { NEXT_PUBLIC_STATIC_PREVIEW: "1", NEXT_PUBLIC_BASE_PATH: basePath } : {}),
  },
};

export default nextConfig;
