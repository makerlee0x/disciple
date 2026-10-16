/** @type {import('next').NextConfig} */
const isStatic = process.env.STATIC_PREVIEW === "1";
const basePath = isStatic
  ? process.env.NEXT_PUBLIC_BASE_PATH || "/makerlee0x/disciple/preview"
  : "";

const nextConfig = {
  reactStrictMode: false, // flight engine IIFE must not double-mount
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
    // server-side moderation fallback (pure-JS tfjs + nsfwjs) and image normalisation
    serverComponentsExternalPackages: ["sharp", "nsfwjs", "@tensorflow/tfjs"],
    // share card reads the Geist woff files at runtime
    outputFileTracingIncludes: { "/api/share/card": ["./app/fonts/**"] },
  },
  env: isStatic
    ? {
        NEXT_PUBLIC_STATIC_PREVIEW: "1",
        NEXT_PUBLIC_BASE_PATH: basePath,
      }
    : {},
};

export default nextConfig;
