/**
 * Server-only Alchemy bundler key selection (no server-only import — unit-tested).
 * NEXT_PUBLIC_* is baked into the browser bundle; using it on the /api/bundler proxy defeats the proxy.
 * Local (non-Vercel, non-production) may fall back for convenience.
 */
export function alchemyKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.ALCHEMY_API_KEY) return env.ALCHEMY_API_KEY;
  const pub = env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  if (!pub) return undefined;
  if (env.VERCEL || env.NODE_ENV === "production") {
    console.warn("[bundler] ignoring NEXT_PUBLIC_ALCHEMY_API_KEY in production/preview — set server-only ALCHEMY_API_KEY");
    return undefined;
  }
  return pub;
}
