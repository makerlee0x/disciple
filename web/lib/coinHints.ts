/**
 * First-paint hints for a coin page (name, ticker, pair, icon, "launched" fade) handed over in memory instead of the
 * address bar (maker 2026-11-20: "the url is still wrong"). Lobby links are the clean /rocket/robinhood/<CA>; the card
 * records what it already knows here and the coin page merges it under its real query (the URL still wins). A fresh
 * load (shared link, refresh) has no hints and reads everything from chain as before.
 */
const HINTS = new Map<string, Record<string, string>>();

export function setCoinHints(token: string, h: Record<string, string | null | undefined>) {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (typeof v === "string" && v) clean[k] = v;
  HINTS.set(token.toLowerCase(), clean);
  if (HINTS.size > 200) HINTS.delete(HINTS.keys().next().value as string);
}

/** The page's query with this coin's hints filled in underneath (a key already in the URL is kept). */
export function withCoinHints(token: string, sp: URLSearchParams | { toString(): string }): URLSearchParams {
  const q = new URLSearchParams(sp.toString());
  const h = HINTS.get(token.toLowerCase());
  if (h) for (const [k, v] of Object.entries(h)) if (!q.has(k)) q.set(k, v);
  return q;
}
