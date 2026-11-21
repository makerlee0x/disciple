/**
 * Security headers (Privy production checklist, maker 2026-11-20: "Set up CSP" + "Set X-Frame options").
 *
 * Two layers, so nothing a player sees can break on day one:
 *   1. ENFORCED, every page except /duel: X-Frame-Options SAMEORIGIN + `frame-ancestors 'self'` (no other site can frame
 *      DISCIPLE; the Turbo Royale iframe is same-origin so it still works), `object-src 'none'`, `base-uri 'self'`.
 *      /duel keeps letting x.com / twitter.com frame it (the X player card from /vs/[pilot]) and sends no X-Frame-Options.
 *   2. REPORT-ONLY, every page: the full allow-list policy (Privy's CSP guidance + every host the browser talks to). The
 *      browser only reports what it would have blocked, to /api/csp-report (Vercel logs, "[csp]" lines). Once a few days
 *      of real traffic show no reports for hosts we need, move CSP_FULL from Report-Only to the enforced header.
 *
 * The iPhone app loads the live site top level in WKWebView (mobile/capacitor.config.ts), so frame rules never apply to
 * it, and a Report-Only policy can't block anything there either.
 */

/** origin of an env URL (RPC / indexer overrides), or nothing when unset or not a URL */
const originOf = (u) => {
  if (!u) return [];
  try {
    const x = new URL(u.trim());
    const ws = x.protocol === "https:" ? `wss://${x.host}` : x.protocol === "http:" ? `ws://${x.host}` : null;
    return [x.origin, ...(ws ? [ws] : [])];
  } catch { return []; }
};

const PRIVY = ["https://auth.privy.io", "https://*.privy.io", "wss://*.privy.io", "https://*.rpc.privy.systems"];
const WALLETCONNECT = [
  "wss://relay.walletconnect.com", "wss://relay.walletconnect.org", "wss://www.walletlink.org",
  "https://explorer-api.walletconnect.com", "https://pulse.walletconnect.org", "https://api.web3modal.org",
];
const FRAMES = [
  "https://auth.privy.io", "https://*.privy.io", "https://verify.walletconnect.com", "https://verify.walletconnect.org",
  "https://challenges.cloudflare.com", "https://*.moonpay.com",
];

/** @param {Record<string, string | undefined>} env @param {string} framers who may frame the page */
export function fullCsp(env = process.env, framers = "'self'") {
  const dev = env.NODE_ENV !== "production";
  const connect = [
    "'self'",
    ...PRIVY, ...WALLETCONNECT,
    // Robinhood Chain (rpc + the flight engine's Alchemy socket) and any RPC / indexer the env points at
    "https://rpc.mainnet.chain.robinhood.com", "https://rpc.testnet.chain.robinhood.com", "https://*.robinhood.com",
    "https://*.alchemy.com", "wss://*.alchemy.com",
    ...originOf(env.NEXT_PUBLIC_RH_RPC_URL), ...originOf(env.NEXT_PUBLIC_RHT_RPC_URL),
    ...originOf(env.NEXT_PUBLIC_ANVIL_RPC_URL), ...originOf(env.NEXT_PUBLIC_INDEXER_URL),
    // always-on trade relay (web/relay, Fly.io)
    ...originOf(env.NEXT_PUBLIC_GASLESS_RELAY_URL),
    // Turbo prices (Hyperliquid, Lighter) and coin data
    "https://api.hyperliquid.xyz", "wss://api.hyperliquid.xyz",
    "https://mainnet.zklighter.elliot.ai", "wss://mainnet.zklighter.elliot.ai", "https://*.lighter.xyz", "wss://*.lighter.xyz",
    "https://api.dexscreener.com",
    // NFT metadata, Vercel Blob, Vercel Analytics, Cloudflare Turnstile (Privy's captcha)
    "https://gateway.pinit.io", "https://*.public.blob.vercel-storage.com", "https://*.vercel-insights.com",
    "https://challenges.cloudflare.com",
    ...(dev ? ["ws:", "http://localhost:*", "http://127.0.0.1:*"] : []),
  ];
  const directives = {
    "default-src": ["'self'"],
    // Next's inline bootstrap scripts need 'unsafe-inline' until we move to nonces; WASM for the signer libs
    "script-src": ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", "https://challenges.cloudflare.com", "https://va.vercel-scripts.com", ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
    // coin logos, X avatars, Blob uploads and NFT art come from many hosts
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "media-src": ["'self'", "data:", "blob:", "https:"],
    "connect-src": [...new Set(connect)],
    "frame-src": ["'self'", ...FRAMES],
    "child-src": ["'self'", "blob:", ...FRAMES],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": [framers],
    "report-uri": ["/api/csp-report"],
  };
  return Object.entries(directives).map(([k, v]) => `${k} ${v.join(" ")}`).join("; ");
}

/** sites allowed to frame /duel (the X player card) */
const DUEL_FRAMERS = "'self' https://x.com https://*.x.com https://twitter.com https://*.twitter.com";

/** next.config headers() rules */
export function securityHeaders(env = process.env) {
  const base = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  ];
  return [
    {
      // every path except /duel
      source: "/:path((?!duel$).*)",
      headers: [
        ...base,
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'self'; object-src 'none'; base-uri 'self'" },
        { key: "Content-Security-Policy-Report-Only", value: fullCsp(env) },
      ],
    },
    {
      source: "/duel",
      headers: [
        ...base,
        { key: "Content-Security-Policy", value: `frame-ancestors ${DUEL_FRAMERS}; object-src 'none'; base-uri 'self'` },
        { key: "Content-Security-Policy-Report-Only", value: fullCsp(env, DUEL_FRAMERS) },
      ],
    },
  ];
}
