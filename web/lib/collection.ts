/**
 * Rocket collection (Hangar "Your rocket", Crates, Shop; maker's pick 2026-11-16: series + crates + daily shop).
 *
 * A skin is one hull in one paint ("Needle | Walnut & Brass"), like a CS:GO weapon skin, so the 8 hulls x 18 paints of
 * player art are 144 separate items. They come out a series at a time: only the live series drops from crates and shows
 * in the shop, and a series that has ended stops dropping. Trails (gold core, so you stay easy to spot) drop alongside.
 * Everything here is pure and shared by the server (lib/server/collection.ts) and the Hangar. Cosmetic only.
 * Art: public/turbo/skins/<hull>--<paint>.webp, crates/<tier>[-open|-burst].webp, trails/, tags/, series/, glint/, flourish/.
 */

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary" | "mythic";
export const RARITIES: readonly Rarity[] = ["common", "uncommon", "rare", "epic", "legendary", "mythic"];
export const RARITY_NAME: Record<Rarity, string> = { common: "Common", uncommon: "Uncommon", rare: "Rare", epic: "Epic", legendary: "Legendary", mythic: "Mythic" };
/** Turbo art rarity colours (docs/brand/turbo-skins). Mythic is champagne: gold means "you". No pink: pink means rivals. */
export const RARITY_COLOR: Record<Rarity, string> = { common: "#A7AFBE", uncommon: "#5FF0A0", rare: "#4F8BFF", epic: "#A066FF", legendary: "#FF9A3C", mythic: "#F3DFA8" };
const rank = (r: Rarity) => RARITIES.indexOf(r);

export const HULL_NAMES: Record<string, string> = {
  bullet: "Bullet", needle: "Needle", pulp: "Pulp", wedge: "Wedge", "twin-booster": "Twin Booster", shuttle: "Shuttle", hauler: "Hauler", "ring-tail": "Ring-tail",
};
export const PAINTS: Record<string, { name: string; rar: Rarity }> = {
  "white-gloss": { name: "White Gloss", rar: "common" }, "red-classic": { name: "Red Classic", rar: "common" }, "sky-blue": { name: "Sky Blue", rar: "common" },
  "safety-orange": { name: "Safety Orange", rar: "common" }, "olive-drab": { name: "Olive Drab", rar: "common" },
  hazard: { name: "Hazard", rar: "uncommon" }, checkered: { name: "Checkered", rar: "uncommon" }, "teal-racer": { name: "Teal Racer", rar: "uncommon" }, "arctic-camo": { name: "Arctic Camo", rar: "uncommon" },
  "walnut-brass": { name: "Walnut & Brass", rar: "rare" }, "delft-porcelain": { name: "Delft", rar: "rare" }, "copper-verdigris": { name: "Old Copper", rar: "rare" },
  "neon-circuit": { name: "Neon Circuit", rar: "epic" }, amethyst: { name: "Amethyst", rar: "epic" }, molten: { name: "Molten", rar: "epic" },
  nebula: { name: "Nebula", rar: "legendary" }, "seraph-wing": { name: "Seraph Wing", rar: "legendary" },
  "marble-gilt": { name: "Marble & Gold Leaf", rar: "mythic" },
  // new for Series 2 (PR 422 art)
  "racing-green": { name: "Racing Green", rar: "common" }, "carbon-gold": { name: "Carbon & Gold", rar: "uncommon" },
  koi: { name: "Koi", rar: "rare" }, damascus: { name: "Damascus", rar: "rare" }, "stained-glass": { name: "Stained Glass", rar: "epic" },
  aurora: { name: "Aurora", rar: "legendary" }, "holo-foil": { name: "Holo Foil", rar: "legendary" },
};

export interface Series { n: number; name: string; hulls: string[]; paints: string[]; /** UTC ms; null = not out yet */ start: number | null; /** UTC ms crates stop dropping it; null = open-ended */ end: number | null }
/** Series 1 is live from launch. Later series get their dates when they're ready (set start, and end the one before). */
export const SERIES: readonly Series[] = [
  { n: 1, name: "First Light", hulls: ["bullet", "needle"], start: 0, end: null,
    paints: ["white-gloss", "red-classic", "sky-blue", "safety-orange", "hazard", "checkered", "teal-racer", "walnut-brass", "copper-verdigris", "neon-circuit", "molten", "nebula", "marble-gilt"] },
  { n: 2, name: "Series 2", hulls: ["pulp", "wedge"], start: null, end: null,
    paints: ["racing-green", "olive-drab", "carbon-gold", "arctic-camo", "koi", "damascus", "delft-porcelain", "stained-glass", "amethyst", "aurora", "holo-foil", "seraph-wing", "marble-gilt"] },
];
/** Ring-tail is never in a series: it's the Prestige 1 hull (with every paint the pilot has found on another hull). */
export const PRESTIGE_HULL = "ring-tail";

/**
 * Trails: an animated plume (public/turbo/trails/trail-<id>-plume.webp, 6 frames of 128x384, black = clear) plus 3
 * particles (-bits.webp, 64x64 each) sprinkled down the contrail. Every one keeps a gold-white core and none is pink.
 * series 0 = always in the pool (the starter); a trail drops with its series; prestige = never drops, unlocks at that Prestige.
 */
export interface Trail { id: string; name: string; rar: Rarity; color: string; /** fallback flame rgb */ rgb: string; series: number; prestige?: number }
export const TRAILS: readonly Trail[] = [
  { id: "gold", name: "Gold", rar: "common", color: "#F3DFA8", rgb: "255,200,120", series: 0 },
  { id: "smoke", name: "Old Smoke", rar: "common", color: "#A7AFBE", rgb: "190,194,204", series: 1 },
  { id: "mint", name: "Mint Wake", rar: "uncommon", color: "#5FF0A0", rgb: "95,240,160", series: 1 },
  { id: "ember", name: "Ember", rar: "uncommon", color: "#FF6A3C", rgb: "255,106,60", series: 1 },
  { id: "ice", name: "Ice Wake", rar: "rare", color: "#8FB8FF", rgb: "143,184,255", series: 1 },
  { id: "comet", name: "Comet", rar: "rare", color: "#F3DFA8", rgb: "243,223,168", series: 1 },
  { id: "violet", name: "Violet Arc", rar: "epic", color: "#A066FF", rgb: "160,102,255", series: 1 },
  { id: "glitch", name: "Glitch", rar: "epic", color: "#5FE8FF", rgb: "95,232,255", series: 1 },
  { id: "solar", name: "Solar Flare", rar: "legendary", color: "#FF9A3C", rgb: "255,154,60", series: 1 },
  { id: "stardust", name: "Stardust", rar: "legendary", color: "#8C7BFF", rgb: "140,123,255", series: 1 },
  { id: "toxic", name: "Toxic Drip", rar: "uncommon", color: "#9CFF3C", rgb: "156,255,60", series: 2 },
  { id: "frost", name: "Frost", rar: "rare", color: "#BFE3FF", rgb: "191,227,255", series: 2 },
  { id: "lightning", name: "Storm", rar: "epic", color: "#CFE6FF", rgb: "207,230,255", series: 2 },
  { id: "lava", name: "Lava", rar: "epic", color: "#FF7A2A", rgb: "255,122,42", series: 2 },
  { id: "prism", name: "Prism", rar: "legendary", color: "#BFF4FF", rgb: "200,240,255", series: 2 },
  { id: "feather", name: "Seraph", rar: "mythic", color: "#FFF6DC", rgb: "255,246,220", series: 2 },
  { id: "halo", name: "Halo", rar: "legendary", color: "#F2C14E", rgb: "242,193,78", series: 0, prestige: 2 },
];
export const trailArt = (id: string, part: "plume" | "bits" = "plume") => `/turbo/trails/trail-${id}-${part}.webp`;

/**
 * Name tags: the plate behind your name over your rocket. One per rarity (common is the starter steel plate; the rest
 * drop from crates and sell in the shop, any series), plus 9 prestige plates you get by reaching that Prestige.
 * Art: public/turbo/tags/tag-<tier>.webp and tag-prestige-<n>.webp, 600x140 with an empty middle.
 */
export const PRESTIGE_TAGS = 9;
const PRESTIGE_NAMES = ["Acolyte", "Disciple", "Herald", "Seeker", "Warden", "Ascendant", "Exalted", "Celestial", "Empyrean"];
export const tagArt = (id: string) => `/turbo/tags/${id}.webp`;
export const tagPrestige = (id: string) => { const m = /^tag-prestige-(\d)$/.exec(id); return m ? Number(m[1]) : 0; };

export type ItemKind = "skin" | "trail" | "tag";
/** series 0 = not tied to a series. prestige = never drops or sells; it unlocks at that Prestige. */
export interface Item { id: string; kind: ItemKind; name: string; rar: Rarity; series: number; hull?: string; paint?: string; prestige?: number }

/** "needle--walnut-brass" */
export const skinId = (hull: string, paint: string) => `${hull}--${paint}`;
export const skinArt = (id: string) => `/turbo/skins/${id}.webp`;
export const crateArt = (tier: Rarity, open = false) => `/turbo/crates/${tier}${open ? "-open" : ""}.webp`;
/** 8 frames of light bursting out of an opened crate (256x256 each, black = clear) */
export const crateBurstArt = (tier: Rarity) => `/turbo/crates/${tier}-burst.webp`;
export const seriesArt = (n: number) => (n === 1 ? "/turbo/series/series-1-first-light.webp" : `/turbo/series/series-${n}.webp`);
/** 4-frame gold glint sweeping up a Marble & Gold Leaf skin (same size per frame as the skin) */
export const glintArt = (hull: string) => `/turbo/glint/${hull}--marble-gilt.webp`;
export const trailId = (id: string) => `trail-${id}`;

/** The starter look every pilot owns. */
export const STARTER_SKIN = skinId("bullet", "white-gloss");
export const STARTER_TRAIL = trailId("gold");
export const STARTER_TAG = "tag-common";

function buildItems(): Item[] {
  const out: Item[] = [];
  for (const s of SERIES) for (const h of s.hulls) for (const p of s.paints) {
    const pt = PAINTS[p]; if (!pt) continue;
    out.push({ id: skinId(h, p), kind: "skin", name: pt.name, rar: pt.rar, series: s.n, hull: h, paint: p });
  }
  TRAILS.forEach((t) => out.push({ id: trailId(t.id), kind: "trail", name: t.name, rar: t.rar, series: t.series, ...(t.prestige ? { prestige: t.prestige } : {}) }));
  const TAG_NAMES: Record<Rarity, string> = { common: "Steel", uncommon: "Enamel", rare: "Chrome", epic: "Crystal", legendary: "Reactor", mythic: "Marble & Gold" };
  RARITIES.forEach((r) => out.push({ id: `tag-${r}`, kind: "tag", name: TAG_NAMES[r], rar: r, series: 0 }));
  PRESTIGE_NAMES.forEach((n, k) => out.push({ id: `tag-prestige-${k + 1}`, kind: "tag", name: n, rar: k >= 6 ? "mythic" : k >= 3 ? "legendary" : "epic", series: 0, prestige: k + 1 }));
  return out;
}
export const ITEMS: readonly Item[] = buildItems();
export const itemById = (id: string): Item | undefined => ITEMS.find((i) => i.id === id) ?? prestigeSkin(id);
/** Ring-tail skins (prestige hull): any catalogue paint. */
function prestigeSkin(id: string): Item | undefined {
  const [h, p] = id.split("--");
  if (h !== PRESTIGE_HULL || !PAINTS[p]) return undefined;
  return { id, kind: "skin", name: PAINTS[p].name, rar: PAINTS[p].rar, series: 0, hull: h, paint: p };
}
export const itemTitle = (i: Item) => (i.kind === "skin" ? `${HULL_NAMES[i.hull!] ?? i.hull} | ${i.name}` : i.kind === "trail" ? `${i.name} trail` : `${i.name} name tag`);
/** Items you get by reaching a Prestige rather than finding them. */
export const prestigeUnlocked = (i: Item, prestige: number) => !!i.prestige && prestige >= i.prestige;

export const liveSeries = (now: number): Series | null => [...SERIES].reverse().find((s) => s.start != null && s.start <= now && (s.end == null || now < s.end)) ?? null;
export const releasedSeries = (now: number) => SERIES.filter((s) => s.start != null && s.start <= now);
/** What crates can drop right now: the live series' skins and trails, plus the any-series items. Prestige items never drop. */
export function dropPool(now: number): Item[] {
  const live = liveSeries(now);
  return ITEMS.filter((i) => !i.prestige && (i.series === 0 || (live && i.series === live.n)));
}

/* ---------------------------------------------------------------- crates ---------------------------------------------------------------- */

/** The chance of each rarity before a crate's floor. A crate drops 1 item at its floor or better, plus XP. */
export const BASE_ODDS: Record<Rarity, number> = { common: 52, uncommon: 28, rare: 13, epic: 5.5, legendary: 1.3, mythic: 0.2 };
export const CRATE: Record<Rarity, { floor: Rarity; xp: number }> = {
  common: { floor: "common", xp: 20 }, uncommon: { floor: "uncommon", xp: 40 }, rare: { floor: "uncommon", xp: 80 },
  epic: { floor: "rare", xp: 150 }, legendary: { floor: "epic", xp: 300 }, mythic: { floor: "legendary", xp: 600 },
};
/** XP a duplicate turns into. */
export const DUPE_XP: Record<Rarity, number> = { common: 25, uncommon: 50, rare: 100, epic: 250, legendary: 600, mythic: 1500 };

/** The odds a crate shows, in percent (floor and up, renormalised; rounded for display). */
export function crateOdds(tier: Rarity): { rar: Rarity; pct: number }[] {
  const floor = rank(CRATE[tier].floor);
  const rows = RARITIES.filter((r) => rank(r) >= floor).map((r) => ({ rar: r, w: BASE_ODDS[r] }));
  const sum = rows.reduce((a, r) => a + r.w, 0);
  return rows.map((r) => ({ rar: r.rar, pct: (r.w / sum) * 100 }));
}
export const pctLabel = (p: number) => (p >= 10 ? `${Math.round(p)}%` : p >= 1 ? `${p.toFixed(1)}%` : `${p.toFixed(2)}%`);

/**
 * One crate roll (server only calls this, with crypto random numbers). r1 picks the rarity, r2 the item. A rarity with
 * nothing in the pool (no trail at Mythic, say) falls back down to the nearest rarity that has items.
 */
export function rollCrate(tier: Rarity, pool: readonly Item[], r1: number, r2: number): Item | null {
  const odds = crateOdds(tier);
  let x = r1 * 100, pick: Rarity = odds[odds.length - 1].rar;
  for (const o of odds) { if (x < o.pct) { pick = o.rar; break; } x -= o.pct; }
  for (let k = rank(pick); k >= 0; k--) {
    const items = pool.filter((i) => i.rar === RARITIES[k]);
    if (items.length) return items[Math.min(items.length - 1, Math.floor(r2 * items.length))];
  }
  return null;
}

/* ----------------------------------------------------------------- shop ----------------------------------------------------------------- */

/** XP to spend. Mythic is never sold. Only the Common crate is sold; better crates are earned. */
export const PRICE: Partial<Record<Rarity, number>> = { common: 800, uncommon: 1500, rare: 3000, epic: 6000, legendary: 12000 };
export const CRATE_PRICE = 800;
export const SHOP_CRATE_ID = "crate-common";

export const DAY_MS = 86_400_000;
export const dayIndex = (now: number) => Math.floor(now / DAY_MS);

function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

export interface ShopStock { day: number; endsAt: number; featured: Item | null; featuredEndsAt: number; daily: Item[] }
/**
 * The day's stock, the same for every pilot (UTC). The featured Epic or Legendary skin changes every 2 days; three
 * Common to Rare items change every day. Mythic never shows. Pilots see owned items marked as owned.
 */
export function shopStock(now: number): ShopStock {
  const day = dayIndex(now), live = liveSeries(now);
  const starters = new Set([STARTER_SKIN, STARTER_TRAIL, STARTER_TAG]);
  const pool = ITEMS.filter((i) => !i.prestige && (i.series === 0 || (live && i.series === live.n)) && i.rar !== "mythic" && !starters.has(i.id));
  const big = pool.filter((i) => i.kind === "skin" && (i.rar === "epic" || i.rar === "legendary"));
  const small = pool.filter((i) => rank(i.rar) <= rank("rare"));
  const f = rng(0x5eed + Math.floor(day / 2) * 7919);
  const featured = big.length ? big[Math.floor(f() * big.length)] : null;
  const d = rng(0xc0ffee + day * 104729), left = small.filter((i) => i.id !== featured?.id), daily: Item[] = [];
  while (daily.length < 3 && left.length) daily.push(left.splice(Math.floor(d() * left.length), 1)[0]);
  return { day, endsAt: (day + 1) * DAY_MS, featured, featuredEndsAt: (Math.floor(day / 2) * 2 + 2) * DAY_MS, daily };
}

/* --------------------------------------------------------------- earning --------------------------------------------------------------- */

/** How crates are earned (server-checked results only; practice bots and Royale practice don't drop crates). */
export const EARN = {
  /** ranked duel win; a win streak of 3 gives Rare, 5+ gives Epic */
  duelWin: "uncommon" as Rarity, streak3: "rare" as Rarity, streak5: "epic" as Rarity,
  /** duel crates per pilot per UTC day */
  duelPerDay: 5,
  /** each level gained: Common; every 5th level Rare; levels 25 and 50 Epic */
  level: (lv: number): Rarity => (lv === 25 || lv === 50 ? "epic" : lv % 5 === 0 ? "rare" : "common"),
  /** all of the week's missions done */
  weekly: "epic" as Rarity,
  /** first visit after collections launch */
  welcome: "rare" as Rarity,
};
export function duelCrateTier(streak: number): Rarity { return streak >= 5 ? EARN.streak5 : streak >= 3 ? EARN.streak3 : EARN.duelWin; }

/* ---------------------------------------------------------------- types ---------------------------------------------------------------- */

export interface Crate { id: string; tier: Rarity; src: string; label: string; at: number }
export interface Opened { crate: Crate; item: Item | null; dupe: boolean; xp: number; at: number }
export interface Collection {
  wallet: string;
  owned: string[];
  crates: Crate[];
  equipped: { skin: string; trail: string; tag: string };
  spendableXp: number;
  prestige: number;
  recent: Opened[];
}
/** POST /api/collection actions */
export type CollectionAction = { op: "open"; crate: string } | { op: "buy"; item: string } | { op: "equip"; skin: string; trail: string; tag?: string };
