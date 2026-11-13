/**
 * Rocket logbook (main mode hook loop, maker 2026-11-13).
 * GET ?wallet=0x…[&coin=0x…] → Logbook (lib/server/logbook), or one rocket's story with &coin.
 * Public view = closed flights only: rockets the pilot is still aboard, and every "on paper" value, are left out, so a
 * logbook can't be read as a live copy-trade feed (Top pilots links here). With a Privy bearer token for a wallet on
 * the caller's own account, the owner sees everything.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { authenticate, bearer, privyEnv } from "@/lib/server/privyAuth";
import { logbookFor, rocketStoryFor } from "@/lib/server/logbook";
import { logRecord, type LogEntry } from "@/lib/logbook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
const isAddr = (a: string) => /^0x[0-9a-f]{40}$/.test(a);
const out = (status: number, b: unknown, own = false) => NextResponse.json(b, { status, headers: { "cache-control": own ? "private, no-store" : "public, max-age=0, s-maxage=30, stale-while-revalidate=60" } });

/** what anyone may see of someone else's rocket */
const closed = (e: LogEntry): LogEntry => ({ ...e, paperUsd: null, paperPct: null, crewAboard: 0, news: e.news?.kind === "crew_aboard" ? null : e.news });

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `logbook:ip:${clientIp(req.headers)}`, 60, 60);
  if (!rl.ok) return out(429, { error: "Too many requests" });
  const q = new URL(req.url).searchParams;
  const wallet = (q.get("wallet") || "").toLowerCase(), coin = (q.get("coin") || "").toLowerCase();
  if (!isAddr(wallet) || (coin && !isAddr(coin))) return out(400, { error: "wallet=0x… required" });
  let own = false;
  const tok = bearer(req.headers);
  if (tok) {
    const a = await authenticate(tok, privyEnv());
    own = a.ok && a.user.wallets.some((x) => x.toLowerCase() === wallet);
  }
  try {
    if (coin) {
      const s = await rocketStoryFor(wallet, coin);
      if (!s || (!own && s.entry.status === "aboard")) return out(404, { error: "not in this logbook" }, own);
      return out(200, own ? { ...s, own } : { ...s, entry: closed(s.entry), own }, own);
    }
    const b = await logbookFor(wallet);
    if (own) return out(200, { ...b, own }, true);
    const entries = b.entries.filter((e) => e.status !== "aboard").map(closed);
    return out(200, { ...b, entries, record: { ...logRecord(entries), rockets: b.record.rockets }, own });
  } catch (e) {
    return out(503, { error: (e as Error).message }, own);
  }
}
