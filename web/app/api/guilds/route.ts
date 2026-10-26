export const runtime = "nodejs";
/**
 * Guilds V1 (tags only). Plan: disciple-notes/guilds-v1-plan.md. Store: lib/server/guildStore.
 * GET  ?wallet=0x…           → { guild | null, nextSwitchAt | null }
 * GET  ?tag=PEPE             → { guild | null }            (search by tag, case-insensitive; with member count)
 * GET  ?list=1               → { guilds }                  (starter guilds, then the newest player-made guilds)
 * GET  ?nonce=1&address=0x…  → { nonce, ttlSec }
 * POST { address, tag, name, nonce, signature, owner? } → { ok, guild | reason }   start a guild and join it.
 *   Needs a claimed username. Tag: 2–5 chars A–Z 0–9, unique, not reserved. Name ≤ 24 chars, bio clean-up + word filter.
 * Join: POST /api/guilds/join · leave: POST /api/guilds/leave · batch tags: GET /api/guilds/of?w=a,b,c
 */
import { NextResponse } from "next/server";
import { guilds } from "@/lib/server/guilds";
import { usernameOf } from "@/lib/server/usernames";
import { guildNonce, guildResponse, isAddr, verifiedGuildAction } from "@/lib/server/guildAuth";
import { GUILD_COPY, normalizeTag, sanitizeGuildName } from "@/lib/guilds";

export const dynamic = "force-dynamic";
const noStore = { headers: { "cache-control": "no-store" } };

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const address = (q.get("address") || q.get("wallet") || "").toLowerCase();
  if (q.get("nonce") !== null) {
    if (!isAddr(address)) return NextResponse.json({ error: "address required" }, { status: 400 });
    return guildNonce(req, address);
  }
  try {
    if (q.get("list") !== null) return NextResponse.json({ guilds: await guilds().list() }, { headers: { "cache-control": "public, s-maxage=15, stale-while-revalidate=60" } });
    if (q.get("tag") !== null) {
      const c = await guilds().guildByTag(normalizeTag(q.get("tag")));
      return NextResponse.json({ guild: await guilds().withCount(c) }, noStore);
    }
    if (!isAddr(address)) return NextResponse.json({ error: "wallet, tag or list required" }, { status: 400 });
    const [guild, nextSwitchAt] = await Promise.all([guilds().guildOf(address), guilds().nextSwitchAt(address)]);
    return NextResponse.json({ guild, nextSwitchAt }, noStore);
  } catch (e) {
    console.warn("[guilds] read failed:", (e as Error).message);
    return NextResponse.json({ error: "guilds unavailable" }, { status: 503 });
  }
}

export async function POST(req: Request) {
  const f = (b: { tag?: unknown; name?: unknown }) => ({ tag: normalizeTag(b.tag), name: sanitizeGuildName(b.name) });
  const v = await verifiedGuildAction(req, "create", f);
  if (!v.ok) return v.res;
  const { tag, name } = f(v.body);
  if (!(await usernameOf(v.addr).catch(() => null))) return NextResponse.json({ ok: false, reason: GUILD_COPY.needUsername }, { status: 403 });
  if (!(await v.consume())) return NextResponse.json({ ok: false, reason: "Sign-in expired. Try again." }, { status: 401 });
  return guildResponse(await guilds().create(v.addr, tag, name));
}
