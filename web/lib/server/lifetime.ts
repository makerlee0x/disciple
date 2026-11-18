import "server-only";
/**
 * Lifetime points (maker 2026-11-18: "ranking is how we'll do the airdrop … there should be a lifetime thing for sure").
 * Season points (SP) and tiers reset every 12 weeks; lifetime points never do. Lifetime = every finished season's SP total
 * (floored at 0) + this season's SP so far, so one point earned is one lifetime point, whatever mode paid it.
 *
 * KV, no expiry:
 *   season:pts:<season> → JSON { wallet: ModeSp }, this season's SP by mode, rewritten on each Overall refresh
 *   season:life         → JSON { through: n, pts: { wallet: number } }, seasons 1..n added up (sealed once each ends)
 * Sealing a finished season re-reads Duel / Royale / Climb SP straight from that season's boards (exact), and takes Rockets
 * from the last snapshot (Rockets SP is worked out from fills, which don't go back that far).
 */
import { SEASON_MS, SEASON_ONE_START } from "@/lib/duel/season";
import { totalSp, type ModeSp } from "@/lib/season/points";
import { kv, type Kv } from "./kv";
import { modeSp } from "./seasonModes";

const SNAP = (seasonId: string) => `season:pts:${seasonId}`;
const LIFE = "season:life";
type Life = { through: number; pts: Record<string, number> };

/** This season's SP by mode, for sealing later. */
export async function snapSeason(seasonId: string, rows: { wallet: string; by: ModeSp }[], s: Kv = kv()) {
  await s.set(SNAP(seasonId), JSON.stringify(Object.fromEntries(rows.map((r) => [r.wallet, r.by]))));
}

async function readJson<T>(s: Kv, k: string): Promise<T | null> {
  try { const v = await s.get(k); return v ? (JSON.parse(v) as T) : null; } catch { return null; }
}

/** One finished season's final SP per wallet. */
export async function sealSeason(n: number, s: Kv = kv()): Promise<Record<string, number>> {
  const id = `s${n}`, inside = SEASON_ONE_START + (n - 1) * SEASON_MS + 1;
  const snap = (await readJson<Record<string, ModeSp>>(s, SNAP(id))) ?? {};
  const fresh = await Promise.all((["duel", "royale", "climb"] as const).map((m) => modeSp(m, 100_000, s, inside).catch(() => null)));
  const by = new Map<string, ModeSp>(Object.entries(snap).map(([w, v]) => [w, { ...v }]));
  (["duel", "royale", "climb"] as const).forEach((m, i) => {
    const f = fresh[i];
    if (!f) return;   // the board couldn't be read: keep the snapshot's number for this mode
    for (const r of by.values()) delete r[m];
    for (const [w, v] of Object.entries(f)) { const r = by.get(w) ?? {}; r[m] = v; by.set(w, r); }
  });
  const out: Record<string, number> = {};
  for (const [w, v] of by) { const t = Math.max(0, totalSp(v)); if (t > 0) out[w] = t; }
  return out;
}

/** Lifetime points from every finished season before season `current`. Seals any season that ended since the last read. */
export async function finishedLife(current: number, s: Kv = kv()): Promise<Record<string, number>> {
  const life = (await readJson<Life>(s, LIFE)) ?? { through: 0, pts: {} };
  if (life.through >= current - 1) return life.pts;
  for (let n = life.through + 1; n < current; n++) {
    for (const [w, v] of Object.entries(await sealSeason(n, s))) life.pts[w] = (life.pts[w] ?? 0) + v;
    life.through = n;
  }
  await s.set(LIFE, JSON.stringify(life));
  return life.pts;
}

/** Lifetime = finished seasons + this season so far, sorted (most first). */
export function addLife(finished: Record<string, number>, season: { wallet: string; pts: number }[]): { wallet: string; pts: number; season: number }[] {
  const m = new Map<string, { pts: number; season: number }>();
  for (const [w, v] of Object.entries(finished)) m.set(w, { pts: v, season: 0 });
  for (const r of season) { const cur = Math.max(0, r.pts), x = m.get(r.wallet); if (x) { x.pts += cur; x.season = cur; } else m.set(r.wallet, { pts: cur, season: cur }); }
  return [...m.entries()].filter(([, v]) => v.pts > 0).map(([wallet, v]) => ({ wallet, ...v })).sort((a, b) => b.pts - a.pts || a.wallet.localeCompare(b.wallet));
}

