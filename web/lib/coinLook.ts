/**
 * A coin's launch rocket, picked by the host at launch (maker, 2026-11-16): one skin (hull + paint) and one trail, plus
 * the coin's badge painted on the hull. It replaces the chrome rocket wherever the coin itself is shown (the pad, the
 * lobby and All rockets cards). In the flight every trader flies their own Hangar rocket; only the launch rocket changes.
 * Any skin or trail that is out (its series and drop have started) can go on a coin, picked or shuffled, and so can
 * anything the host owns (prestige items too). A host's own copy is credited on the coin (its serial) and not used up.
 * Nothing unreleased ever shows. Hidden launches get their pick too, with no serial (it would point at the host).
 * Set once at launch; changing what you wear later doesn't repaint coins you launched. No look = the classic chrome rocket.
 * Pure and shared by the server (lib/server/coinLooks.ts), the launch builder, the lobby cards and the flight. Cosmetic only.
 */
import { HULL_GEO, HULL_NAMES, ITEMS, PAINTS, TRAILS, itemById, itemOut, skinArt, trailArt, type Copy, type Item } from "./collection";

/** "classic" = the chrome rocket every coin flew before skins. */
export const CLASSIC = "classic";

export interface CoinLook {
  /** a skin item id ("needle--walnut-brass") or CLASSIC */
  skin: string;
  /** a trail item id ("trail-ember"); the starter gold trail when left out */
  trail: string;
  /** the host's copy it was stamped from, shown on the coin ("Walnut & Brass #812") */
  serial?: number;
  /** how that copy looked (burn and pattern seed), so every screen draws it the same */
  fx?: { burn: number; seed: number };
}
export const CLASSIC_LOOK: CoinLook = { skin: CLASSIC, trail: "trail-gold" };

/** [width / height] of each hull's art (public/turbo/skins/<hull>--<paint>.webp, all 320 tall). Same numbers as the duel engine. */
export const HULL_ASPECT: Record<string, number> = {
  bullet: 0.454, needle: 0.4, pulp: 0.557, wedge: 0.732, "twin-booster": 0.436, shuttle: 0.575, hauler: 0.432, "ring-tail": 0.432,
};
/**
 * Where the coin's badge sits on each hull: centre x, y and radius, as fractions of the art's width (x, r) and height (y).
 * Picked by eye on the white-gloss art: the widest flat part of the body, clear of fins, windows and seams.
 */
export const HULL_BADGE: Record<string, [number, number, number]> = {
  bullet: [0.5, 0.34, 0.2], needle: [0.5, 0.5, 0.115], pulp: [0.5, 0.36, 0.17], wedge: [0.5, 0.52, 0.085],
  "twin-booster": [0.5, 0.34, 0.135], shuttle: [0.5, 0.56, 0.1], hauler: [0.5, 0.33, 0.19], "ring-tail": [0.5, 0.42, 0.12],
};
/** The chrome rocket's badge spot (lib/decal MID; HeroPad .decal). */
const CLASSIC_BADGE: [number, number, number] = [0.5, 0.39, 0.19];
const CLASSIC_ASPECT = 221 / 609;

export const isClassic = (l: Pick<CoinLook, "skin"> | null | undefined) => !l || l.skin === CLASSIC || !l.skin;
export const hullOf = (skin: string) => skin.split("--")[0];

export interface LookArt { src: string | null; aspect: number; badge: [number, number, number]; hull: string | null }
/** Art for a look: src null = the classic chrome rocket (callers keep their own chrome art and lighting). */
export function lookArt(l: CoinLook | null | undefined): LookArt {
  if (isClassic(l)) return { src: null, aspect: CLASSIC_ASPECT, badge: CLASSIC_BADGE, hull: null };
  const h = hullOf(l!.skin);
  const geo = HULL_GEO[h];
  return { src: skinArt(l!.skin), aspect: HULL_ASPECT[h] ?? geo?.[0] ?? 0.45, badge: HULL_BADGE[h] ?? [0.5, 0.4, 0.14], hull: h };
}

/** "Needle | Walnut & Brass", or "Classic chrome". */
export function lookName(l: CoinLook | null | undefined): string {
  if (isClassic(l)) return "Classic chrome";
  const [h, p] = l!.skin.split("--");
  return `${HULL_NAMES[h] ?? h} | ${PAINTS[p]?.name ?? itemById(l!.skin)?.name ?? p}`;
}
export const trailName = (id: string) => TRAILS.find((t) => `trail-${t.id}` === id)?.name ?? "Gold";
export const trailRgb = (id: string) => TRAILS.find((t) => `trail-${t.id}` === id)?.rgb ?? "255,200,120";
export const trailPlume = (id: string) => trailArt(id.replace(/^trail-/, ""));

/** CSS filter for a stamped copy's pattern shift (lib/collection copyLook), or undefined. */
export function lookFilter(l: CoinLook | null | undefined): string | undefined {
  if (!l?.fx || isClassic(l)) return undefined;
  const paint = l.skin.split("--")[1];
  if (!["nebula", "marble-gilt", "aurora", "damascus", "holo-foil"].includes(paint)) return undefined;
  const hue = ((l.fx.seed * 37) % 41) - 20, sheen = 0.85 + ((l.fx.seed * 13) % 31) / 100;
  return `hue-rotate(${hue}deg) saturate(${sheen})`;
}

/** The look stamped from a copy (or a prestige item with no copy). */
export function lookFromCopy(skin: string, trail: string, copy?: Pick<Copy, "serial" | "burn" | "seed"> | null): CoinLook {
  if (skin === CLASSIC) return { skin: CLASSIC, trail };
  return { skin, trail, ...(copy ? { fx: { burn: copy.burn, seed: copy.seed }, ...(copy.serial ? { serial: copy.serial } : {}) } : {}) };
}

/** Parse a stored / sent look; null when it isn't one. */
export function parseLook(v: unknown): CoinLook | null {
  const o = v as Partial<CoinLook> | null;
  if (!o || typeof o !== "object" || typeof o.skin !== "string" || typeof o.trail !== "string") return null;
  if (o.skin !== CLASSIC && itemById(o.skin)?.kind !== "skin") return null;
  if (itemById(o.trail)?.kind !== "trail") return null;
  const fx = o.fx && Number.isFinite(o.fx.burn) && Number.isFinite(o.fx.seed) ? { burn: Math.min(1, Math.max(0, +o.fx.burn)), seed: Math.round(Math.min(999, Math.max(0, +o.fx.seed))) } : undefined;
  const serial = Number.isInteger(o.serial) && o.serial! > 0 ? o.serial : undefined;
  return { skin: o.skin, trail: o.trail, ...(fx && o.skin !== CLASSIC ? { fx } : {}), ...(serial && o.skin !== CLASSIC ? { serial } : {}) };
}

/** Skins and trails any host can put on a coin right now: out (series + drop started) and not prestige-only. */
export function launchPool(now = Date.now()): { skins: Item[]; trails: Item[] } {
  const ok = (i: Item) => !i.prestige && itemOut(i, now);
  return { skins: ITEMS.filter((i) => i.kind === "skin" && ok(i)), trails: ITEMS.filter((i) => i.kind === "trail" && ok(i)) };
}
/** May this skin / trail go on a coin: in the launch pool, or owned (owned may be a prestige item). */
export function lookAllowed(id: string, kind: "skin" | "trail", owned: ReadonlySet<string>, now = Date.now()): boolean {
  if (kind === "skin" && id === CLASSIC) return true;
  const i = itemById(id);
  if (!i || i.kind !== kind) return false;
  return owned.has(id) || (!i.prestige && itemOut(i, now));
}
/** A random rocket from the pool (the shuffle button). `rnd` returns 0..1. */
export function shuffleLook(pool: { skins: readonly { id: string }[]; trails: readonly { id: string }[] }, prev?: { skin: string; trail: string }, rnd = Math.random): { skin: string; trail: string } {
  const pick = <T extends { id: string }>(a: readonly T[], not?: string) => { const b = a.length > 1 ? a.filter((x) => x.id !== not) : a; return b[Math.floor(rnd() * b.length)]?.id; };
  return { skin: pick(pool.skins.filter((x) => x.id !== CLASSIC), prev?.skin) ?? CLASSIC, trail: pick(pool.trails, prev?.trail) ?? "trail-gold" };
}
/** What a hidden host signs with the coin's stealth owner key to paint it (checked against Launchpad.creatorOf). */
/** What a hidden coin's stealth owner signs to have its launch credited to this account's trophies (kept private). */
export const anonHostMessage = (token: string, wallet: string, chainId: number) => `Disciple: credit my hidden launch ${token.toLowerCase()}\nto ${wallet.toLowerCase()}\nchain ${chainId}`;
export const coinLookMessage = (token: string, skin: string, trail: string) => `Disciple: paint rocket ${token.toLowerCase()}\nskin ${skin}\ntrail ${trail}`;
