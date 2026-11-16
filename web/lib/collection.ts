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
/**
 * Series 1 is live from launch. Later series get their dates when they're ready (set start, and end the one before).
 * Dates and new series can also be set live from /admin/catalog (see Catalog below), with no deploy.
 */
export const SERIES: Series[] = [
  { n: 1, name: "First Light", hulls: ["bullet", "needle"], start: 0, end: null,
    paints: ["white-gloss", "red-classic", "sky-blue", "hazard", "checkered", "walnut-brass", "neon-circuit", "nebula", "marble-gilt"] },
  { n: 2, name: "Series 2", hulls: ["pulp", "wedge"], start: null, end: null,
    paints: ["racing-green", "olive-drab", "carbon-gold", "arctic-camo", "koi", "damascus", "delft-porcelain", "stained-glass", "amethyst", "aurora", "holo-foil", "seraph-wing", "marble-gilt"] },
];
/**
 * Drops: a batch added to a series part way through (Fortnite-style), on that series' hulls. Nothing in a drop shows, drops
 * or sells before its start; it stops dropping with its series. start null = no date yet (set it in /admin/catalog).
 */
export interface Drop { id: string; series: number; name: string; start: number | null; paints?: string[]; trails?: string[]; flourishes?: string[] }
export const DROPS: Drop[] = [
  { id: "s1-afterburn", series: 1, name: "Afterburn", start: null,
    paints: ["safety-orange", "teal-racer", "copper-verdigris", "molten"], trails: ["ember", "comet", "glitch", "stardust"] },
];
/** Ring-tail is never in a series: it's the Prestige 1 hull (with every paint the pilot has found on another hull). */
export const PRESTIGE_HULL = "ring-tail";

/**
 * Trails: an animated plume (public/turbo/trails/trail-<id>-plume.webp, 6 frames of 128x384, black = clear) plus 3
 * particles (-bits.webp, 64x64 each) sprinkled down the contrail. Every one keeps a gold-white core and none is pink.
 * series 0 = always in the pool (the starter); a trail drops with its series; prestige = never drops, unlocks at that Prestige.
 */
export interface Trail { id: string; name: string; rar: Rarity; color: string; /** fallback flame rgb */ rgb: string; series: number; prestige?: number }
export const TRAILS: Trail[] = [
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
export const trailArt = (id: string, part: "plume" | "bits" = "plume") => ART[`trail-${id}${part === "bits" ? ":bits" : ""}`] ?? `/turbo/trails/trail-${id}-${part}.webp`;

/**
 * Name tags: the plate behind your name over your rocket. One per rarity (common is the starter steel plate; the rest
 * drop from crates and sell in the shop, any series), plus 9 prestige plates you get by reaching that Prestige.
 * Art: public/turbo/tags/tag-<tier>.webp and tag-prestige-<n>.webp, 600x140 with an empty middle.
 */
export const PRESTIGE_TAGS = 9;
const PRESTIGE_NAMES = ["Acolyte", "Disciple", "Herald", "Seeker", "Warden", "Ascendant", "Exalted", "Celestial", "Empyrean"];
export const tagArt = (id: string) => `/turbo/tags/${id}.webp`;

/** Win flourishes: an 8-frame burst over your rocket when you win a duel (256x256 frames, black = clear). They drop in a series. */
export interface Flourish { id: string; name: string; rar: Rarity; series: number; art: string }
export const FLOURISHES: Flourish[] = [
  { id: "flourish-gold-rush", name: "Gold Rush", rar: "epic", series: 1, art: "/turbo/flourish/win-flourish.webp" },
];
export const tagPrestige = (id: string) => { const m = /^tag-prestige-(\d)$/.exec(id); return m ? Number(m[1]) : 0; };

export type ItemKind = "skin" | "trail" | "tag" | "flourish";
/** series 0 = not tied to a series. prestige = never drops or sells; it unlocks at that Prestige. */
export interface Item { id: string; kind: ItemKind; name: string; rar: Rarity; series: number; hull?: string; paint?: string; prestige?: number; /** in this drop (DROPS) */ drop?: string }

/** "needle--walnut-brass" */
export const skinId = (hull: string, paint: string) => `${hull}--${paint}`;
export const skinArt = (id: string) => ART[id] ?? `/turbo/skins/${id}.webp`;
export const crateArt = (tier: Rarity, open = false) => `/turbo/crates/${tier}${open ? "-open" : ""}.webp`;
/** 8 frames of light bursting out of an opened crate (256x256 each, black = clear) */
export const crateBurstArt = (tier: Rarity) => `/turbo/crates/${tier}-burst.webp`;
export const seriesArt = (n: number) => ART[`series-${n}`] ?? (n === 1 ? "/turbo/series/series-1-first-light.webp" : `/turbo/series/series-${n}.webp`);
/** 4-frame gold glint sweeping up a Marble & Gold Leaf skin (same size per frame as the skin) */
export const glintArt = (hull: string) => `/turbo/glint/${hull}--marble-gilt.webp`;
export const trailId = (id: string) => `trail-${id}`;

/** The starter look every pilot owns. */
export const STARTER_SKIN = skinId("bullet", "white-gloss");
export const STARTER_TRAIL = trailId("gold");
export const STARTER_TAG = "tag-common";

function buildItems(): Item[] {
  const out: Item[] = [], seen = new Set<string>();
  const push = (i: Item) => { if (!seen.has(i.id)) { seen.add(i.id); out.push(i); } };
  const dropOf = (kind: "paints" | "trails" | "flourishes", series: number, id: string) => DROPS.find((d) => d.series === series && d[kind]?.includes(id))?.id;
  for (const s of SERIES) {
    const extra = DROPS.filter((d) => d.series === s.n).flatMap((d) => d.paints ?? []);
    for (const h of s.hulls) for (const p of [...s.paints, ...extra]) {
      const pt = PAINTS[p]; if (!pt) continue;
      const drop = s.paints.includes(p) ? undefined : dropOf("paints", s.n, p);
      push({ id: skinId(h, p), kind: "skin", name: pt.name, rar: pt.rar, series: s.n, hull: h, paint: p, ...(drop ? { drop } : {}) });
    }
  }
  TRAILS.forEach((t) => { const drop = dropOf("trails", t.series, t.id); push({ id: trailId(t.id), kind: "trail", name: t.name, rar: t.rar, series: t.series, ...(t.prestige ? { prestige: t.prestige } : {}), ...(drop ? { drop } : {}) }); });
  const TAG_NAMES: Record<Rarity, string> = { common: "Steel", uncommon: "Enamel", rare: "Chrome", epic: "Crystal", legendary: "Reactor", mythic: "Marble & Gold" };
  RARITIES.forEach((r) => push({ id: `tag-${r}`, kind: "tag", name: TAG_NAMES[r], rar: r, series: 0 }));
  FLOURISHES.forEach((f) => { const drop = dropOf("flourishes", f.series, f.id); push({ id: f.id, kind: "flourish", name: f.name, rar: f.rar, series: f.series, ...(drop ? { drop } : {}) }); });
  PRESTIGE_NAMES.forEach((n, k) => push({ id: `tag-prestige-${k + 1}`, kind: "tag", name: n, rar: k >= 6 ? "mythic" : k >= 3 ? "legendary" : "epic", series: 0, prestige: k + 1 }));
  return out;
}
export const ITEMS: Item[] = buildItems();
export const itemById = (id: string): Item | undefined => ITEMS.find((i) => i.id === id) ?? prestigeSkin(id);
/** Ring-tail skins (prestige hull): any catalogue paint. */
function prestigeSkin(id: string): Item | undefined {
  const [h, p] = id.split("--");
  if (h !== PRESTIGE_HULL || !PAINTS[p]) return undefined;
  return { id, kind: "skin", name: PAINTS[p].name, rar: PAINTS[p].rar, series: 0, hull: h, paint: p };
}
export const itemTitle = (i: Item) => (i.kind === "skin" ? `${HULL_NAMES[i.hull!] ?? i.hull} | ${i.name}` : i.kind === "trail" ? `${i.name} trail` : i.kind === "tag" ? `${i.name} name tag` : `${i.name} win flourish`);
/** Items you get by reaching a Prestige rather than finding them. */
export const prestigeUnlocked = (i: Item, prestige: number) => !!i.prestige && prestige >= i.prestige;

export const liveSeries = (now: number): Series | null => [...SERIES].reverse().find((s) => s.start != null && s.start <= now && (s.end == null || now < s.end)) ?? null;
export const releasedSeries = (now: number) => SERIES.filter((s) => s.start != null && s.start <= now);
const dropOut = (id: string | undefined, now: number) => { if (!id) return true; const d = DROPS.find((x) => x.id === id); return !!d && d.start != null && d.start <= now; };
/** Out yet: its series has started and, for a drop item, its drop has too. Items that aren't out never show anywhere. */
export function itemOut(i: Item, now: number): boolean {
  if (i.series > 0) { const s = SERIES.find((x) => x.n === i.series); if (!s || s.start == null || s.start > now) return false; }
  return dropOut(i.drop, now);
}
/** The next drop or series with a date that hasn't come yet (for "next drop in 3 days"). */
export function nextDrop(now: number): { name: string; series: number; start: number } | null {
  const c = [...DROPS.map((d) => ({ name: d.name, series: d.series, start: d.start })), ...SERIES.map((s) => ({ name: s.name, series: s.n, start: s.start }))]
    .filter((x): x is { name: string; series: number; start: number } => x.start != null && x.start > now).sort((a, b) => a.start - b.start);
  return c[0] ?? null;
}
/** What crates can drop right now: the live series' skins and trails that are out, plus the any-series items. Prestige items never drop. */
export function dropPool(now: number): Item[] {
  const live = liveSeries(now);
  return ITEMS.filter((i) => !i.prestige && (i.series === 0 || (live && i.series === live.n)) && itemOut(i, now));
}

/* ---------------------------------------------------------------- crates ---------------------------------------------------------------- */

/** The chance of each rarity before a crate's floor. A crate drops 1 item at its floor or better, plus XP. */
/** Tightened before items can trade (maker, 16 Nov): Legendary 0.6%, Mythic 0.1%. Never change these once items trade. */
export const BASE_ODDS: Record<Rarity, number> = { common: 52.8, uncommon: 28, rare: 13, epic: 5.5, legendary: 0.6, mythic: 0.1 };
export const CRATE: Record<Rarity, { floor: Rarity; xp: number }> = {
  common: { floor: "common", xp: 20 }, uncommon: { floor: "uncommon", xp: 40 }, rare: { floor: "uncommon", xp: 80 },
  epic: { floor: "rare", xp: 150 }, legendary: { floor: "epic", xp: 300 }, mythic: { floor: "legendary", xp: 600 },
};
/** XP for scrapping a copy (duplicates are kept; scrapping is the player's choice). */
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
  const pool = ITEMS.filter((i) => !i.prestige && (i.series === 0 || (live && i.series === live.n)) && itemOut(i, now) && i.rar !== "mythic" && !starters.has(i.id));
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
  /** duel crates per pilot per week (Monday 00:00 UTC), so a grind can't out-print the series */
  duelPerWeek: 15,
  /** each level gained: Common; every 5th level Rare; levels 25 and 50 Epic */
  level: (lv: number): Rarity => (lv === 25 || lv === 50 ? "epic" : lv % 5 === 0 ? "rare" : "common"),
  /** all of the week's missions done */
  weekly: "epic" as Rarity,
  /** first visit after collections launch */
  welcome: "rare" as Rarity,
};
export function duelCrateTier(streak: number): Rarity { return streak >= 5 ? EARN.streak5 : streak >= 3 ? EARN.streak3 : EARN.duelWin; }

/* ---------------------------------------------------------------- copies ---------------------------------------------------------------- */

/**
 * Every drop is its own copy (like a CS2 skin with its float and pattern): a serial ("#14 of 312"), a burn roll, a pattern
 * seed, maybe FlightTrak, maybe first edition. Duplicates are kept. bound copies (XP shop buys, level-up and welcome
 * crates, starters) never trade. Starter copies have serial 0. Prestige items aren't copies; they come with the Prestige.
 */
export interface Copy {
  uid: string; item: string; serial: number;
  /** 0..1, how scorched it looks (grades in BURN_GRADES) */ burn: number;
  /** 0..999, shifts the paint (PATTERN_PAINTS) or the trail's particle mix */ seed: number;
  /** FlightTrak: ranked duel wins flown with it; null = not a FlightTrak copy */ trak: number | null;
  /** dropped in its series' first 7 days */ fe: boolean;
  origin: "crate" | "shop" | "tradeup" | "starter" | "migrated"; at: number; bound: boolean;
}
export const BURN_GRADES: readonly { name: string; short: string; max: number }[] = [
  { name: "Factory Fresh", short: "FF", max: 0.07 }, { name: "Test Flown", short: "TF", max: 0.15 }, { name: "Flight Worn", short: "FW", max: 0.38 },
  { name: "Re-entry Scorched", short: "RS", max: 0.45 }, { name: "Burnt Out", short: "BO", max: 1.0001 },
];
export const burnGrade = (b: number) => BURN_GRADES.find((g) => b < g.max) ?? BURN_GRADES[BURN_GRADES.length - 1];
/** Paints whose pattern seed visibly shifts the paint. (Gem seeds get picked by hand later and are never published ahead.) */
export const PATTERN_PAINTS = new Set(["nebula", "marble-gilt", "aurora", "damascus", "holo-foil"]);
export const FLIGHTTRAK_PCT = 10;
export const FIRST_EDITION_MS = 7 * DAY_MS;
export const copyTitle = (c: Copy) => `${burnGrade(c.burn).name} · ${c.serial ? `#${c.serial}` : "Starter"}`;
/** How a copy looks, for the Hangar and the duel engine: hue shift (deg) for pattern paints, and soot strength. */
export function copyLook(c: Pick<Copy, "item" | "burn" | "seed">): { hue: number; soot: number; sheen: number } {
  const paint = c.item.split("--")[1];
  const pat = !!paint && PATTERN_PAINTS.has(paint);
  return { hue: pat ? ((c.seed * 37) % 41) - 20 : 0, sheen: pat ? 0.85 + ((c.seed * 13) % 31) / 100 : 1, soot: Math.min(0.85, Math.max(0, (c.burn - 0.05) * 1.1)) };
}

/**
 * Provable rolls: each UTC day has a server seed whose sha256 is published a day ahead; a crate opened that day rolls from
 * HMAC-SHA256(seed, crateId) and the seed is revealed the next day, so anyone can check the roll. This turns the digest
 * into the numbers (pure, so a checker in the browser gets the same result).
 */
export function rollsFromDigest(hex: string): { r1: number; r2: number; burn: number; seed: number; trak: boolean } {
  const u = (i: number) => parseInt(hex.slice(i * 8, i * 8 + 8), 16) / 4294967296;
  return { r1: u(0), r2: u(1), burn: u(2), seed: parseInt(hex.slice(24, 32), 16) % 1000, trak: u(4) * 100 < FLIGHTTRAK_PCT };
}

/** Trade-ups: 10 copies of one rarity from one series become 1 copy of the next rarity from that series. Never into Mythic. */
export const TRADE_UP_N = 10;
export function tradeUpTarget(rar: Rarity): Rarity | null { const k = rank(rar); return k + 1 < rank("mythic") ? RARITIES[k + 1] : null; }
export function tradeUpPool(series: number, rar: Rarity, now = Date.now()): Item[] {
  const to = tradeUpTarget(rar);
  return to ? ITEMS.filter((i) => i.series === series && i.rar === to && !i.prestige && itemOut(i, now)) : [];
}

/* ---------------------------------------------------------------- types ---------------------------------------------------------------- */

export interface Crate { id: string; tier: Rarity; src: string; label: string; at: number }
/** proof: the day whose seed rolled it (revealed after that day) and the HMAC input */
export interface Opened { crate: Crate; item: Item | null; copy?: Copy; dupe: boolean; xp: number; at: number; proof?: { day: number; input: string; hash: string } }
export type Slot = "skin" | "trail" | "tag" | "flourish";
export interface Collection {
  wallet: string;
  /** item ids you own (copies, starters, prestige items) */
  owned: string[];
  copies: Copy[];
  /** total copies ever made, per item you own */
  supply: Record<string, number>;
  crates: Crate[];
  /** item ids; flourish "" = none */
  equipped: { skin: string; trail: string; tag: string; flourish: string };
  /** the copy behind each equipped slot (absent for prestige items) */
  equippedCopy: Partial<Record<Slot, string>>;
  spendableXp: number;
  prestige: number;
  recent: Opened[];
}
/** POST /api/collection actions. equip slots take a copy uid, or an item id (prestige items; or your best copy of it). */
export type CollectionAction =
  | { op: "open"; crate: string } | { op: "buy"; item: string }
  | { op: "equip"; skin: string; trail: string; tag?: string; flourish?: string }
  | { op: "scrap"; copy: string } | { op: "tradeup"; copies: string[] };

/* ------------------------------------------------------------ live catalogue ------------------------------------------------------------ */

/**
 * The live catalogue: an overlay kept on the server (edited at /admin/catalog) and merged over the lists above, so a new
 * drop, a new series, a new paint, hull or trail, or a date change needs no deploy. It only adds: code-defined paints,
 * trails and flourishes can't be renamed or re-rated here, and once any copy of an item exists its name, rarity and art
 * are frozen and it can't be pulled back (the server refuses that save), because a copy may later be a token whose
 * metadata must never move. New art is uploaded to blob storage and referenced here by URL.
 */
type Geo = [number, [number, number, number][]];
export interface CatalogSeries { n: number; name?: string; start?: number | null; end?: number | null; hulls?: string[]; paints?: string[] }
export interface Catalog {
  /** bumps on every save */ v: number; at?: number; by?: string;
  /** date changes for any series, paints added to a series, or a whole new series (n = next number) */ series?: CatalogSeries[];
  /** new drops, or dates and additions for an existing one (by id) */ drops?: Drop[];
  paints?: Record<string, { name: string; rar: Rarity }>;
  /** new hull shapes: name and engine geometry [aspect w/h, nozzles [x, y, size] as 0..1 of the image] */
  hulls?: Record<string, { name: string; geo: Geo }>;
  trails?: Trail[];
  flourishes?: Flourish[];
  /** art URLs for catalogue items: skin id → image; "trail-<id>" → plume sheet; "trail-<id>:bits" → particles */
  art?: Record<string, string>;
}
/** art URLs from the catalogue (only for items the catalogue added) */
export const ART: Record<string, string> = {};
/** new hull shapes from the catalogue, for the duel engine */
export const HULL_GEO: Record<string, Geo> = {};
let CURRENT: Catalog | null = null;
export const catalogVersion = () => CURRENT?.v ?? 0;
export const currentCatalog = () => CURRENT;

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const BASE = { paints: clone(PAINTS), hulls: clone(HULL_NAMES), series: clone(SERIES), drops: clone(DROPS), trails: clone(TRAILS), flourishes: clone(FLOURISHES) };
const BASE_IDS = new Set(ITEMS.map((i) => i.id));
/** In the code list (not added by the catalogue). */
export const isBaseItem = (id: string) => BASE_IDS.has(id);
const reset = <T,>(arr: T[], to: T[]) => { arr.length = 0; arr.push(...clone(to)); };
const resetObj = <T,>(o: Record<string, T>, to: Record<string, T>) => { for (const k of Object.keys(o)) delete o[k]; Object.assign(o, clone(to)); };
const union = (a: string[], b: string[] | undefined) => [...a, ...(b ?? []).filter((x) => !a.includes(x))];

/** Merge a catalogue over the code lists (null = code only). Pure data in, so client and server end up the same. */
export function applyCatalog(c: Catalog | null): void {
  resetObj(PAINTS, BASE.paints); resetObj(HULL_NAMES, BASE.hulls); reset(SERIES, BASE.series); reset(DROPS, BASE.drops);
  reset(TRAILS, BASE.trails); reset(FLOURISHES, BASE.flourishes); resetObj(ART, {}); resetObj(HULL_GEO, {});
  CURRENT = c;
  if (c) {
    for (const [k, p] of Object.entries(c.paints ?? {})) if (!BASE.paints[k]) PAINTS[k] = { name: p.name, rar: p.rar };
    for (const [k, h] of Object.entries(c.hulls ?? {})) if (!BASE.hulls[k]) { HULL_NAMES[k] = h.name; HULL_GEO[k] = h.geo; }
    for (const cs of c.series ?? []) {
      const s = SERIES.find((x) => x.n === cs.n);
      if (s) {
        if (cs.name) s.name = cs.name;
        if (cs.start !== undefined) s.start = cs.start;
        if (cs.end !== undefined) s.end = cs.end;
        s.hulls = union(s.hulls, cs.hulls); s.paints = union(s.paints, cs.paints);
      } else if (cs.n === SERIES.length + 1 && cs.hulls?.length) {
        SERIES.push({ n: cs.n, name: cs.name || `Series ${cs.n}`, hulls: [...cs.hulls], paints: [...(cs.paints ?? [])], start: cs.start ?? null, end: cs.end ?? null });
      }
    }
    for (const d of c.drops ?? []) {
      const e = DROPS.find((x) => x.id === d.id);
      if (e) { e.name = d.name || e.name; e.start = d.start; e.paints = union(e.paints ?? [], d.paints); e.trails = union(e.trails ?? [], d.trails); e.flourishes = union(e.flourishes ?? [], d.flourishes); }
      else if (SERIES.some((s) => s.n === d.series)) DROPS.push(clone(d));
    }
    for (const t of c.trails ?? []) if (!TRAILS.some((x) => x.id === t.id)) TRAILS.push(clone(t));
    for (const f of c.flourishes ?? []) if (!FLOURISHES.some((x) => x.id === f.id)) FLOURISHES.push(clone(f));
  }
  ITEMS.length = 0; ITEMS.push(...buildItems());
  if (c?.art) for (const [k, url] of Object.entries(c.art)) if (!BASE_IDS.has(k.replace(/:bits$/, ""))) ART[k] = url;
}

/** An item as it would be minted: what may never change once a copy exists. */
export interface Frozen { id: string; name: string; rar: Rarity; kind: ItemKind; art: string }
export const frozenOf = (i: Item): Frozen => ({
  id: i.id, name: i.name, rar: i.rar, kind: i.kind,
  art: i.kind === "skin" ? skinArt(i.id) : i.kind === "trail" ? `${trailArt(i.id.slice(6))} ${trailArt(i.id.slice(6), "bits")}` : i.kind === "flourish" ? FLOURISHES.find((f) => f.id === i.id)?.art ?? "" : tagArt(i.id),
});
/** Items a catalogue gives (applied, read, then the current one put back). */
export function itemsUnder(c: Catalog | null, now: number): { item: Frozen; out: boolean }[] {
  const keep = CURRENT;
  applyCatalog(c);
  const rows = ITEMS.map((i) => ({ item: frozenOf(i), out: itemOut(i, now) }));
  applyCatalog(keep);
  return rows;
}

const RX_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isRar = (r: unknown): r is Rarity => RARITIES.includes(r as Rarity);
const okDate = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 4e12);
const okUrl = (u: unknown) => typeof u === "string" && u.length < 400 && /^(https:\/\/[a-z0-9.-]+\/|\/turbo\/)[\w\-./%]+\.(webp|png)$/i.test(u);
const okName = (n: unknown) => typeof n === "string" && n.trim().length >= 1 && n.length <= 32 && !/[<>]/.test(n);
const okIds = (a: unknown, max = 64) => Array.isArray(a) && a.length <= max && a.every((x) => typeof x === "string" && x.length <= 32 && RX_ID.test(x));

/** Shape check for a catalogue an admin sends (rules about what's frozen live on the server, which knows the supply). */
export function catalogShapeProblems(c: Catalog): string[] {
  const bad: string[] = [];
  const p = (cond: boolean, why: string) => { if (!cond) bad.push(why); };
  p(typeof c === "object" && c !== null, "Catalogue must be an object.");
  if (bad.length) return bad;
  for (const [k, v] of Object.entries(c.paints ?? {})) { p(RX_ID.test(k) && k.length <= 32, `Paint id "${k}" must be lower-case-with-dashes.`); p(okName(v?.name) && isRar(v?.rar), `Paint "${k}" needs a name and a rarity.`); }
  for (const [k, v] of Object.entries(c.hulls ?? {})) {
    p(RX_ID.test(k) && k.length <= 24, `Hull id "${k}" must be lower-case-with-dashes.`);
    const g = v?.geo, geoOk = Array.isArray(g) && typeof g[0] === "number" && g[0] > 0.1 && g[0] < 2 && Array.isArray(g[1]) && g[1].length >= 1 && g[1].length <= 4
      && g[1].every((n) => Array.isArray(n) && n.length === 3 && n.every((x) => typeof x === "number" && x >= 0 && x <= 1.5));
    p(okName(v?.name) && geoOk, `Hull "${k}" needs a name and its shape (aspect and 1 to 4 nozzles).`);
  }
  for (const s of c.series ?? []) {
    p(Number.isInteger(s?.n) && s.n >= 1 && s.n <= 99, "Each series needs its number.");
    p((s.start === undefined || okDate(s.start)) && (s.end === undefined || okDate(s.end)), `Series ${s.n}: dates must be times or empty.`);
    p((s.hulls === undefined || okIds(s.hulls, 8)) && (s.paints === undefined || okIds(s.paints)), `Series ${s.n}: hulls and paints are id lists.`);
    p(s.name === undefined || okName(s.name), `Series ${s.n}: name is 1 to 32 characters.`);
  }
  for (const d of c.drops ?? []) {
    p(RX_ID.test(d?.id ?? "") && d.id.length <= 32 && okName(d.name) && Number.isInteger(d.series) && okDate(d.start), `Drop "${d?.id}" needs an id, a name, a series and a date (or empty).`);
    p((d.paints === undefined || okIds(d.paints)) && (d.trails === undefined || okIds(d.trails)) && (d.flourishes === undefined || okIds(d.flourishes)), `Drop "${d?.id}": paints, trails and flourishes are id lists.`);
  }
  for (const t of c.trails ?? []) {
    p(RX_ID.test(t?.id ?? "") && t.id.length <= 24 && okName(t.name) && isRar(t.rar) && Number.isInteger(t.series) && t.series >= 1, `Trail "${t?.id}" needs an id, a name, a rarity and a series.`);
    p(/^#[0-9a-f]{6}$/i.test(t?.color ?? "") && /^\d{1,3},\d{1,3},\d{1,3}$/.test(t?.rgb ?? ""), `Trail "${t?.id}": colour is #rrggbb and rgb is "r,g,b".`);
    p(t?.prestige === undefined, `Trail "${t?.id}": prestige items stay in code.`);
  }
  for (const f of c.flourishes ?? []) p(/^flourish-[a-z0-9-]{1,24}$/.test(f?.id ?? "") && okName(f.name) && isRar(f.rar) && Number.isInteger(f.series) && f.series >= 1 && okUrl(f.art), `Flourish "${f?.id}" needs flourish-<id>, a name, a rarity, a series and its art URL.`);
  for (const [k, u] of Object.entries(c.art ?? {})) p(k.length <= 64 && /^[a-z0-9-]+(--[a-z0-9-]+)?(:bits)?$/.test(k) && okUrl(u), `Art for "${k}" must be an https .webp or .png URL.`);
  return bad;
}
