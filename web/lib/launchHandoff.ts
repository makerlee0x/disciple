/**
 * Launch → flight handoff. The Launch page writes one small note for the coin it just launched, then goes straight to
 * the flight. The flight reads it once (and deletes it) to play the arrival and show the "you're live" share toast.
 * sessionStorage, not the URL: the flight engine rewrites its query string, so a ?flag would stick or get lost.
 */
export type LaunchHandoff = { name: string; ticker: string; mode: string; note: string | null; at: number };

const key = (token: string) => `disciple:launched:${token.toLowerCase()}`;
/** A note older than this is a stale tab or a back-navigation, not a fresh launch. */
const FRESH_MS = 10 * 60_000;

export function saveLaunchHandoff(token: string, h: Omit<LaunchHandoff, "at">): void {
  try { window.sessionStorage.setItem(key(token), JSON.stringify({ ...h, at: Date.now() })); } catch { /* storage blocked: no toast, flight still opens */ }
}

/** Reads and clears the note. null when there is none, it is stale, or storage is blocked. */
export function takeLaunchHandoff(token: string): LaunchHandoff | null {
  try {
    const raw = window.sessionStorage.getItem(key(token));
    if (!raw) return null;
    window.sessionStorage.removeItem(key(token));
    const h = JSON.parse(raw) as LaunchHandoff;
    if (!h || typeof h.name !== "string" || typeof h.ticker !== "string") return null;
    return Date.now() - (h.at || 0) < FRESH_MS ? h : null;
  } catch { return null; }
}
