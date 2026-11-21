import "server-only";
/** Duel friends and rivals (lib/duel/social). Friends: a sorted set per pilot (score = when added). Rivals: from duelHistory. */
import { kv, type Kv } from "@/lib/server/kv";
import { usernameOf } from "@/lib/server/usernames";
import { FRIENDS_MAX, rivalsFrom, slugOf, type PilotRow } from "@/lib/duel/social";
import { activeRoomOf, duelHistory, DuelError } from "./store";

const K = { friends: (pid: string) => `duel:friends:${pid}` };

async function statusOf(pid: string, s: Kv): Promise<Pick<PilotRow, "status" | "code">> {
  const r = await activeRoomOf(pid, s).catch(() => null);
  if (!r) return { status: null };
  if (r.mode === "friend" && r.status === "lobby" && r.players.length < 2 && r.code) return { status: "open", code: r.code };
  return { status: r.status === "live" ? "live" : null };
}

export async function friendIds(pid: string, s: Kv = kv()): Promise<string[]> {
  return s.zrange(K.friends(pid), FRIENDS_MAX, true);
}

export async function addFriend(pid: string, who: string, s: Kv = kv()): Promise<{ added: boolean }> {
  if (who === pid) throw new DuelError(400, "That's you.");
  const ids = await friendIds(pid, s);
  if (ids.includes(who)) return { added: false };
  if ((await s.zcard(K.friends(pid))) >= FRIENDS_MAX) throw new DuelError(409, `Friend list is full (${FRIENDS_MAX}).`);
  await s.zadd(K.friends(pid), [{ score: Date.now(), member: who }]);
  return { added: true };
}

export async function removeFriend(pid: string, who: string, s: Kv = kv()): Promise<void> {
  await s.zrem(K.friends(pid), who);
}

/** Both lists for the lobby panel, each row with its live status. */
export async function socialOf(pid: string, s: Kv = kv()): Promise<{ friends: PilotRow[]; rivals: PilotRow[] }> {
  const [ids, hist] = await Promise.all([friendIds(pid, s), duelHistory(pid, 100, s).catch(() => [])]);
  const riv = rivalsFrom(hist, pid);
  const h2hBy = new Map(rivalsFrom(hist, pid, 1000).map((r) => [r.pid, r.h2h]));
  const fset = new Set(ids);
  const friends = await Promise.all(ids.map(async (f): Promise<PilotRow> => {
    const [u, st] = await Promise.all([usernameOf(f).catch(() => null), statusOf(f, s)]);
    const name = u ? `@${u.replace(/^@/, "")}` : `@pilot-${f.slice(2, 6)}`;
    return { pid: f, name, slug: slugOf(f, u), h2h: h2hBy.get(f) ?? null, friend: true, ...st };
  }));
  const rivals = await Promise.all(riv.map(async (r): Promise<PilotRow> => {
    const st = await statusOf(r.pid, s);
    return { pid: r.pid, name: r.name, slug: slugOf(r.pid, r.name), h2h: r.h2h, last: r.last, ...(r.nemesis ? { nemesis: true } : {}), friend: fset.has(r.pid), ...st };
  }));
  // open rooms first, then mid-duel, then the rest in list order
  const rank = (r: PilotRow) => (r.status === "open" ? 0 : r.status === "live" ? 1 : 2);
  friends.sort((a, b) => rank(a) - rank(b));
  return { friends, rivals };
}
