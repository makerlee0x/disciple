import "server-only";
/**
 * Each pilot's rocket look (Hangar "Your rocket": hull + engine flare), kept on the server so everyone sees it: the host's
 * hull flies their flight and each booster's flare fires on their boosts (the flight engine's boost signature). A save
 * is checked against lib/unlocks with the pilot's level, prestige and trophies. Cosmetic only.
 */
import { ACTIVE_CHAIN } from "@/lib/chains";
import { FLARES, HULLS, isUnlocked, type Progress } from "@/lib/unlocks";
import { unlocksOf } from "./achievements";
import { kv, type Kv } from "./kv";
import { xpSummary } from "./xp";

export type Looks = { hull: string; flare: string };
export const STOCK_LOOKS: Looks = { hull: HULLS[0].id, flare: FLARES[0].id };
const key = (w: string) => `looks:${ACTIVE_CHAIN.id}:${w.toLowerCase()}`;

function parse(raw: string | null): Looks | null {
  try {
    const j = raw ? (JSON.parse(raw) as Partial<Looks>) : null;
    if (!j) return null;
    return { hull: HULLS.some((h) => h.id === j.hull) ? j.hull! : STOCK_LOOKS.hull, flare: FLARES.some((f) => f.id === j.flare) ? j.flare! : STOCK_LOOKS.flare };
  } catch { return null; }
}

/** Stored looks for up to 100 wallets (lower case). Wallets with nothing stored are left out. */
export async function looksOf(wallets: readonly string[], s: Kv = kv()): Promise<Record<string, Looks>> {
  const ws = [...new Set(wallets.map((w) => w.toLowerCase()))].slice(0, 100);
  if (!ws.length) return {};
  const raw = await s.mget(ws.map(key));
  const out: Record<string, Looks> = {};
  ws.forEach((w, i) => { const l = parse(raw[i]); if (l) out[w] = l; });
  return out;
}

export async function progressOf(wallet: string, s: Kv = kv()): Promise<Progress> {
  const [xp, unlocks] = await Promise.all([xpSummary(wallet, Date.now(), s), unlocksOf(wallet, s)]);
  return { level: xp.level.level, prestige: xp.level.prestige, trophies: new Set(unlocks.map((u) => u.id)) };
}

export type SaveResult = { ok: true; looks: Looks } | { ok: false; reason: string };
export async function saveLooks(wallet: string, hull: string, flare: string, s: Kv = kv()): Promise<SaveResult> {
  const h = HULLS.find((x) => x.id === hull), f = FLARES.find((x) => x.id === flare);
  if (!h || !f) return { ok: false, reason: "Pick a hull and a flare." };
  const p = await progressOf(wallet, s);
  if (!isUnlocked(h.rule, p)) return { ok: false, reason: `${h.name} isn't unlocked yet.` };
  if (!isUnlocked(f.rule, p)) return { ok: false, reason: `${f.name} isn't unlocked yet.` };
  const looks = { hull: h.id, flare: f.id };
  await s.set(key(wallet), JSON.stringify(looks));
  return { ok: true, looks };
}
