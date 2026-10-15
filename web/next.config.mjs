/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // flight engine IIFE must not double-mount
  experimental: {
    // server-side moderation fallback (pure-JS tfjs + nsfwjs) and image normalisation
    serverComponentsExternalPackages: ["sharp", "nsfwjs", "@tensorflow/tfjs"],
  },
};

export default nextConfig;
