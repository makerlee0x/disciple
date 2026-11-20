/**
 * Public coin links (maker 2026-11-20): disciple.vip/rocket/robinhood/<contract address>?r=<username or wallet>.
 * next.config rewrites /rocket/robinhood/<0x…> to the /coin/<0x…> page, so the address bar keeps the short link.
 * /coin/<0x…> still works (old links, in-app navigation).
 */
export const ROCKET_CHAIN_SLUG = "robinhood";
export const ROCKET_PREFIX = `/rocket/${ROCKET_CHAIN_SLUG}/`;

const PATH_RE = /^(?:\/[^/]+)*?\/(?:coin|rocket\/robinhood)\/(0x[0-9a-fA-F]{40})(?:[/?#]|$)/;

/** The coin's public path: /rocket/robinhood/<lowercase 0x…>. */
export const rocketPath = (coin: string) => `${ROCKET_PREFIX}${coin.toLowerCase()}`;

/** The coin address in a /coin/<0x…> or /rocket/robinhood/<0x…> path (base path tolerated), lowercase; "" when none. */
export function coinFromPath(pathname: string | null | undefined): string {
  return (PATH_RE.exec(String(pathname ?? ""))?.[1] ?? "").toLowerCase();
}

/** True on a coin flight page under either path. */
export const isCoinPath = (pathname: string | null | undefined) => coinFromPath(pathname) !== "";
