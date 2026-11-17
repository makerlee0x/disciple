/**
 * Permanent duel challenges (maker, 2026-11-16: "the challenge link should be a permanent challenge").
 * A shared duel used to point at a friend room whose code lives 30 minutes, then the link was dead. Now every share points
 * at /vs/<pilot>, which never expires: it joins the challenger's open friend room when they're waiting in one, and
 * otherwise starts a free warm-up duel and offers a rematch request. The link carries the challenger's wallet as ?ref=
 * (same 30-day first-touch rule as /r/), so whoever they bring in counts toward their referrals.
 */
import { USERNAME_STORED_RE } from "@/lib/profile";
import { usernameOf, walletOf } from "@/lib/server/usernames";
import { activeRoomOf, ratingOf } from "./store";
import type { Rating } from "@/lib/duel/rules";

const isAddr = (a: string) => /^0x[0-9a-f]{40}$/.test(a);

export interface Challenger { pid: string; name: string; slug: string; rating: Rating; openCode: string | null }

/** /vs/<slug>: slug is a username (with or without @) or a 0x wallet. */
export async function challengerOf(raw: string): Promise<Challenger | null> {
  const slug = decodeURIComponent(raw || "").trim().toLowerCase().replace(/^@/, "");
  let pid: string | null = null, user: string | null = null;
  if (isAddr(slug)) { pid = slug; user = await usernameOf(slug).catch(() => null); }
  else if (USERNAME_STORED_RE.test(slug) && slug.length <= 20) { pid = await walletOf(slug).catch(() => null); if (pid) user = slug; }
  if (!pid) return null;
  const [rating, room] = await Promise.all([ratingOf(pid).catch(() => null), activeRoomOf(pid).catch(() => null)]);
  const openCode = room && room.mode === "friend" && room.status === "lobby" && room.players.length < 2 && room.code ? room.code : null;
  const name = user ? `@${user.replace(/^@/, "")}` : `pilot-${pid.slice(2, 6)}`;
  return { pid, name, slug: user ? user.replace(/^@/, "") : pid, rating: rating ?? { r: 1200, w: 0, l: 0, games: 0, streak: 0, peak: 1200 }, openCode };
}

/** The permanent share link for a signed-in pilot (pid = wallet). `code` is today's live room, when there is one. */
export function challengePath(o: { pid: string; name?: string | null; code?: string | null }): string {
  const slug = o.name ? o.name.replace(/^@/, "").toLowerCase() : o.pid;
  const q = new URLSearchParams();
  if (o.code) q.set("c", o.code);
  if (isAddr(o.pid)) q.set("ref", o.pid);
  const qs = q.toString();
  return `/vs/${encodeURIComponent(USERNAME_STORED_RE.test(slug) && !slug.startsWith("pilot-") ? slug : o.pid)}${qs ? `?${qs}` : ""}`;
}
