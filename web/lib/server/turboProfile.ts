import "server-only";
/**
 * One pilot's Turbo page (/turbo, /u/<name>/turbo; maker 2026-11-20): duel record and recent duels (lib/server/duel/store),
 * Climb level, and the real Lighter fills with the PnL they add up to. Public, like the boards. Cached per wallet for
 * CACHE_MS so a shared page doesn't hammer KV or Lighter. A part that fails reads as null, never as a made-up 0.
 */
import { TIERS } from "@/lib/duel/rules";
import { pfpUrl } from "@/lib/profileMeta";
import { pnlOf, tradingOf, type TurboFill, type TurboMatch, type TurboProfile } from "@/lib/turbo/profile";
import { duelBoard, duelHistory, seasonBoard } from "./duel/store";
import { lighterConfig } from "./lighter/config";
import { fillsOf } from "./lighter/history";
import { metaOf } from "./profileMeta";
import { climbBoard } from "./seasonModes";
import { usernameOf } from "./usernames";

const CACHE_MS = 45_000;
const MATCHES = 30;
const FILLS_SHOWN = 40;

const g = globalThis as unknown as { __dscTurboProfile?: Map<string, { at: number; v: TurboProfile }> };
const safe = <T>(p: Promise<T>): Promise<T | null> => p.catch((e) => { console.warn("[turbo profile] part failed", (e as Error).message); return null; });

async function duel(w: string): Promise<TurboProfile["duel"]> {
  const [b, sb] = await Promise.all([duelBoard(1, w), safe(seasonBoard(1, w))]);
  if (!b.me) return null;
  return { w: b.me.w, l: b.me.l, games: b.me.games, streak: b.me.streak, rank: b.me.rank, league: sb?.me?.league ?? null, sp: sb?.me?.pts ?? null };
}

async function climb(w: string): Promise<TurboProfile["climb"]> {
  const rows = await climbBoard(1000);
  const i = rows.findIndex((r) => r.wallet === w);
  return i < 0 ? null : { level: rows[i].climbLevel, rank: i + 1 };
}

async function matches(w: string): Promise<TurboMatch[]> {
  const rows = await duelHistory(w, MATCHES);
  const opps = [...new Set(rows.map((r) => r.opp.pid))];
  const [metas, names] = await Promise.all([
    Promise.all(opps.map((o) => metaOf(o).catch(() => null))),
    Promise.all(opps.map((o) => usernameOf(o).catch(() => null))),
  ]);
  const by = new Map(opps.map((o, i) => [o, { pfp: metas[i] ? pfpUrl(metas[i]!.pfp) : "", handle: names[i] }]));
  return rows.map((r) => ({
    id: r.id, at: r.at, mode: r.mode, tier: r.fuel ? `$${r.fuel}` : TIERS[r.tier]?.label ?? r.tier, lenMs: r.lenMs,
    result: r.result, me: r.me, them: r.them, delta: r.delta, real: r.real,
    opp: { wallet: r.opp.pid, name: by.get(r.opp.pid)?.handle ? `@${by.get(r.opp.pid)!.handle!.replace(/^@/, "")}` : r.opp.name, pfp: by.get(r.opp.pid)?.pfp ?? "" },
  }));
}

/** real Turbo fills: null = no Turbo account yet; "missing" = Lighter didn't answer */
async function fills(w: string): Promise<TurboFill[] | null | "missing"> {
  const cfg = lighterConfig();
  if (!cfg.enabled) return null;
  try {
    const f = await fillsOf(cfg, w);
    return f ? f.map(({ at, market, side, size, price, usd, fee, pnl, liq }) => ({ at, market, side, size, price, usd, fee, pnl, liq })) : null;
  } catch (e) { console.warn("[turbo profile] fills", (e as Error).message); return "missing"; }
}

export async function turboProfile(walletIn: string, now = Date.now()): Promise<TurboProfile> {
  const w = walletIn.toLowerCase();
  const cache = (g.__dscTurboProfile ??= new Map());
  const hit = cache.get(w);
  if (hit && now - hit.at < CACHE_MS) return hit.v;
  const [d, c, m, f] = await Promise.all([safe(duel(w)), safe(climb(w)), safe(matches(w)), fills(w)]);
  const list = Array.isArray(f) ? f : [];
  const v: TurboProfile = {
    wallet: w, duel: d, climb: c, matches: m ?? [],
    pnl: Array.isArray(f) ? pnlOf(list, now) : null,
    trading: tradingOf(list),
    fills: list.slice(0, FILLS_SHOWN),
    fillsMissing: f === "missing",
  };
  cache.set(w, { at: now, v });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return v;
}
