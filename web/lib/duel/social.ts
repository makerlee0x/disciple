/**
 * Duel friends and rivals (PvP groundwork, maker 2026-11-21). Pure, shared by the server, the lobby panel and tests.
 *
 * Friends: pilots you add by name. One-way, like a follow: no request to accept, so a friend list is useful from the first tap.
 * Rivals: worked out from your finished online duels (lib/server/duel/store duelHistory), most-played first. No extra writes.
 * Each row says whether that pilot is waiting in an open friend room (JOIN) or mid-duel, and you can send any of them a duel
 * request (the same push as /vs/<pilot>).
 */
export const FRIENDS_MAX = 100;
export const RIVALS_MAX = 10;

export interface H2H { w: number; l: number; d: number }
export interface PilotRow {
  pid: string;
  name: string;
  /** the /vs/<slug> and /api/duel/request target: username without @, else the wallet */
  slug: string;
  /** head to head from your side, when you've met online */
  h2h: H2H | null;
  /** "open": waiting in a friend room you can join (code); "live": mid-duel */
  status: "open" | "live" | null;
  code?: string;
  /** rivals: most losses to them among your rivals (2 or more, and more losses than wins) */
  nemesis?: boolean;
  friend?: boolean;
  /** when you last met (ms), rivals only */
  last?: number;
}

/** The slice of a finished duel this needs (lib/server/duel/store HistRow). */
export interface HistLite { at: number; result: "win" | "loss" | "draw"; opp: { pid: string; name: string } }

const isWallet = (p: string) => /^0x[0-9a-f]{40}$/.test(p);

/** Group finished duels by opponent: most games first, then most recent. Guests (non-wallet ids) can't get a request, so they're left out. */
export function rivalsFrom(hist: HistLite[], me: string, max = RIVALS_MAX): Array<{ pid: string; name: string; h2h: H2H; last: number; games: number; nemesis: boolean }> {
  const by = new Map<string, { pid: string; name: string; h2h: H2H; last: number; games: number; nemesis: boolean }>();
  for (const h of hist) {
    const pid = h.opp.pid.toLowerCase();
    if (!isWallet(pid) || pid === me) continue;
    const x = by.get(pid) ?? { pid, name: h.opp.name, h2h: { w: 0, l: 0, d: 0 }, last: 0, games: 0, nemesis: false };
    x.games++;
    if (h.result === "win") x.h2h.w++; else if (h.result === "loss") x.h2h.l++; else x.h2h.d++;
    if (h.at > x.last) { x.last = h.at; x.name = h.opp.name; }
    by.set(pid, x);
  }
  const rows = [...by.values()].sort((a, b) => b.games - a.games || b.last - a.last).slice(0, max);
  const nem = rows.filter((r) => r.h2h.l >= 2 && r.h2h.l > r.h2h.w).sort((a, b) => b.h2h.l - b.h2h.w - (a.h2h.l - a.h2h.w) || b.last - a.last)[0];
  if (nem) nem.nemesis = true;
  return rows;
}

/** Username (stored without @) → the request slug; anything else falls back to the wallet. */
export const slugOf = (pid: string, name: string | null | undefined) => {
  const n = (name || "").replace(/^@/, "").toLowerCase();
  return n && !n.startsWith("pilot-") && /^[a-z0-9_]{1,20}$/.test(n) ? n : pid;
};
