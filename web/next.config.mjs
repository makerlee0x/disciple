/** @type {import('next').NextConfig} */
const isStatic = process.env.STATIC_PREVIEW === "1";
const basePath = isStatic
  ? process.env.NEXT_PUBLIC_BASE_PATH || "/makerlee0x/disciple/preview"
  : "";

const nextConfig = {
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
  experimental: {
    // server-side moderation fallback (pure-JS tfjs + nsfwjs) and image normalisation; undici = /api/img pinned-IP fetch
    serverComponentsExternalPackages: ["sharp", "nsfwjs", "@tensorflow/tfjs", "@napi-rs/canvas", "undici"],
    // share card reads the static Geist fonts + tier plates at runtime
    outputFileTracingIncludes: { "/api/share/card": ["./public/fonts/share/**", "./public/assets/**"] },
  },
  env: {
    // lets the client pick NEXT_PUBLIC_PRIVY_APP_ID_PREVIEW on Vercel preview deployments
    NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV || "",
    ...(isStatic ? { NEXT_PUBLIC_STATIC_PREVIEW: "1", NEXT_PUBLIC_BASE_PATH: basePath } : {}),
  },
};

export default nextConfig;
