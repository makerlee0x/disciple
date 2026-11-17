import { beforeAll, describe, expect, it } from "vitest";
import {
  BURN_GRADES, CRATE, ITEMS, TRADE_UP_N, burnGrade, rollsFromDigest, tradeUpPool, tradeUpTarget, PAINTS, RARITIES, SERIES, STARTER_SKIN, STARTER_TAG, TRAILS, crateBurstArt, crateOdds, dropPool, duelCrateTier, glintArt, itemById, rollCrate,
  seriesArt, skinArt, tagArt, trailArt, DAY_MS, applyCatalog, nextDrop, REWARDS,
} from "@/lib/collection";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("collection catalogue", () => {
  it("every skin in a series has art, and ids are unique", () => {
    const ids = new Set<string>();
    for (const i of ITEMS) { expect(ids.has(i.id)).toBe(false); ids.add(i.id); }
    for (const i of ITEMS.filter((x) => x.kind === "skin")) expect(existsSync(join(__dirname, "..", "public", skinArt(i.id)))).toBe(true);
    for (const s of SERIES) for (const p of s.paints) expect(PAINTS[p]).toBeTruthy();
  });

  it("every trail, tag, burst, banner and glint has art", () => {
    const pub = (p: string) => existsSync(join(__dirname, "..", "public", p));
    expect(TRAILS).toHaveLength(17);
    for (const t of TRAILS) { expect(pub(trailArt(t.id))).toBe(true); expect(pub(trailArt(t.id, "bits"))).toBe(true); }
    for (const i of ITEMS.filter((x) => x.kind === "tag")) expect(pub(tagArt(i.id))).toBe(true);
    for (const r of RARITIES) expect(pub(crateBurstArt(r))).toBe(true);
    for (const s of SERIES) expect(pub(seriesArt(s.n))).toBe(true);
    for (const h of ["bullet", "needle", "pulp", "wedge", "ring-tail"]) expect(pub(glintArt(h))).toBe(true);
  });

  it("trails drop with their series, prestige items never drop or sell, tags drop in any series", () => {
    const pool = dropPool(Date.UTC(2026, 10, 20));
    const trails = pool.filter((i) => i.kind === "trail").map((i) => i.id);
    expect(trails).toContain("trail-ice");
    expect(trails).not.toContain("trail-comet");   // Afterburn drop, no date yet
    expect(trails).not.toContain("trail-toxic");   // Series 2
    expect(trails).not.toContain("trail-halo");    // Prestige 2
    expect(pool.filter((i) => i.kind === "tag").map((i) => i.id).sort()).toEqual(RARITIES.map((r) => `tag-${r}`).sort());
    expect(SERIES[1].paints).toEqual(expect.arrayContaining(["koi", "aurora", "holo-foil", "stained-glass"]));
  });

  it("only the live series drops (Series 1 at launch: 2 hulls x 9 paints, 5 trails + gold)", () => {
    const pool = dropPool(Date.UTC(2026, 10, 20));
    const skins = pool.filter((i) => i.kind === "skin");
    expect(skins.length).toBe(18);
    for (const r of REWARDS) expect(itemById(r.item)).toBeTruthy();   // every level / trophy reward is a real item
    expect(pool.filter((i) => i.kind === "trail").map((i) => i.id).sort()).toEqual(["gold", "ice", "mint", "smoke", "solar", "violet"].map((t) => `trail-${t}`).sort());
    expect(new Set(skins.map((s) => s.hull))).toEqual(new Set(["bullet", "needle"]));
    expect(pool.some((i) => i.hull === "pulp")).toBe(false);
  });

  it("crate odds start at the floor and add to 100", () => {
    for (const t of RARITIES) {
      const o = crateOdds(t);
      expect(o[0].rar).toBe(CRATE[t].floor);
      expect(o.reduce((a, r) => a + r.pct, 0)).toBeCloseTo(100, 6);
    }
    expect(crateOdds("common").find((r) => r.rar === "mythic")!.pct).toBeCloseTo(0.1, 6);
    expect(crateOdds("common").find((r) => r.rar === "legendary")!.pct).toBeCloseTo(0.6, 6);
  });

  it("a roll respects the floor and the pool, and falls back when a rarity is empty", () => {
    const pool = dropPool(Date.UTC(2026, 10, 20));
    for (let k = 0; k < 2000; k++) {
      const it = rollCrate("epic", pool, Math.random(), Math.random())!;
      expect(RARITIES.indexOf(it.rar)).toBeGreaterThanOrEqual(RARITIES.indexOf("rare"));
      expect(pool).toContain(it);
    }
    const onlyCommon = pool.filter((i) => i.rar === "common");
    expect(rollCrate("mythic", onlyCommon, 0.99, 0.5)!.rar).toBe("common");   // falls down to the nearest rarity with items
    expect(rollCrate("common", onlyCommon, 0.999, 0.5)!.rar).toBe("common");
  });

  it("win streaks upgrade the duel crate", () => {
    expect(duelCrateTier(1)).toBe("uncommon");
    expect(duelCrateTier(3)).toBe("rare");
    expect(duelCrateTier(7)).toBe("epic");
  });

  it("copies: burn grades, digest rolls and trade-up targets", () => {
    expect(burnGrade(0.01).name).toBe("Factory Fresh");
    expect(burnGrade(0.2).name).toBe("Flight Worn");
    expect(burnGrade(0.999).name).toBe("Burnt Out");
    expect(BURN_GRADES.map((g) => g.name)).toEqual(["Factory Fresh", "Test Flown", "Flight Worn", "Re-entry Scorched", "Burnt Out"]);
    const r = rollsFromDigest("ff".repeat(32)), z = rollsFromDigest("00".repeat(32));
    expect(r.r1).toBeLessThan(1); expect(z.r1).toBe(0); expect(z.trak).toBe(true); expect(r.trak).toBe(false);
    expect(r.seed).toBeGreaterThanOrEqual(0); expect(r.seed).toBeLessThan(1000);
    expect(tradeUpTarget("legendary")).toBeNull();     // never into Mythic
    expect(tradeUpTarget("rare")).toBe("epic");
    expect(tradeUpPool(1, "rare").every((i) => i.series === 1 && i.rar === "epic" && !i.prestige)).toBe(true);
    expect(itemById("flourish-gold-rush")?.kind).toBe("flourish");
  });

  it("a dated drop joins its series on its date, and never before", () => {
    const at = Date.UTC(2026, 11, 14);
    applyCatalog({ v: 1, drops: [{ id: "s1-afterburn", series: 1, name: "Afterburn", start: at }] });
    try {
      expect(dropPool(at - 1).filter((i) => i.kind === "skin")).toHaveLength(18);
      const after = dropPool(at);
      expect(after.filter((i) => i.kind === "skin")).toHaveLength(26);
      expect(after.map((i) => i.id)).toEqual(expect.arrayContaining(["trail-comet", "needle--molten"]));
      expect(itemById("needle--molten")?.drop).toBe("s1-afterburn");
      expect(nextDrop(at - DAY_MS)?.name).toBe("Afterburn");
    } finally { applyCatalog(null); }
  });

  it("the catalogue adds a series, paint, hull and trail with their art, and resets cleanly", () => {
    const art = (id: string) => `https://example.blob.vercel-storage.com/catalog/${id}.webp`;
    applyCatalog({
      v: 2, paints: { "sunset-fade": { name: "Sunset Fade", rar: "epic" } }, hulls: { lancer: { name: "Lancer", geo: [0.4, [[0.5, 0.98, 1]]] } },
      series: [{ n: 1, end: Date.UTC(2027, 0, 1) }, { n: 2, start: Date.UTC(2027, 0, 1), end: Date.UTC(2027, 2, 1) }, { n: 3, name: "Deep Space", hulls: ["lancer"], paints: ["sunset-fade", "nebula"], start: Date.UTC(2027, 2, 1), end: null }],
      trails: [{ id: "aurora-wake", name: "Aurora Wake", rar: "legendary", color: "#8FF0D0", rgb: "143,240,208", series: 3 }],
      art: { "lancer--sunset-fade": art("lancer--sunset-fade"), "lancer--nebula": art("lancer--nebula"), "trail-aurora-wake": art("p"), "trail-aurora-wake:bits": art("b"), "bullet--white-gloss": art("nope") },
    });
    try {
      expect(SERIES).toHaveLength(3);
      expect(itemById("lancer--sunset-fade")).toMatchObject({ rar: "epic", series: 3 });
      expect(skinArt("lancer--sunset-fade")).toBe(art("lancer--sunset-fade"));
      expect(skinArt(STARTER_SKIN)).toBe("/turbo/skins/bullet--white-gloss.webp");   // code items keep their art
      expect(trailArt("aurora-wake", "bits")).toBe(art("b"));
      const s3 = dropPool(Date.UTC(2027, 3, 1)).filter((i) => i.kind !== "tag").map((i) => i.id);
      expect(s3).toEqual(expect.arrayContaining(["lancer--sunset-fade", "lancer--nebula", "trail-aurora-wake"]));
      expect(s3.some((id) => id.startsWith("needle--"))).toBe(false);
      expect(dropPool(Date.UTC(2026, 11, 1)).some((i) => i.series === 3)).toBe(false);
    } finally { applyCatalog(null); }
    expect(SERIES).toHaveLength(2); expect(itemById("lancer--sunset-fade")).toBeUndefined(); expect(PAINTS["sunset-fade"]).toBeUndefined();
  });

  it("ring-tail skins resolve for any paint (prestige hull)", () => {
    expect(itemById("ring-tail--nebula")?.rar).toBe("legendary");
    expect(itemById("ring-tail--nope")).toBeUndefined();
  });
});

describe("collection server (local KV)", () => {
  let col: typeof import("@/lib/server/collection");
  let xp: typeof import("@/lib/server/xp");
  beforeAll(async () => {
    process.env.KV_LOCAL_FILE = join(tmpdir(), `col-test-${Date.now()}.json`);
    col = await import("@/lib/server/collection");
    xp = await import("@/lib/server/xp");
  });
  const W = "0x" + "c0".repeat(20);

  it("a new pilot gets the starter look and a welcome crate, and can open it", async () => {
    const c = await col.collectionOf(W);
    expect(c.owned).toContain(STARTER_SKIN);
    expect(c.crates.map((x) => x.src)).toContain("welcome");
    const again = await col.collectionOf(W);
    expect(again.crates.filter((x) => x.src === "welcome")).toHaveLength(1);
    const r = await col.openCrate(W, c.crates[0].id);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.opened.xp).toBe(CRATE.rare.xp); expect(r.opened.item).toBeTruthy();
      const cp = r.opened.copy!;
      expect(cp.serial).toBeGreaterThanOrEqual(1); expect(cp.bound).toBe(true);   // welcome crate items never trade
      expect(cp.burn).toBeGreaterThanOrEqual(0); expect(cp.burn).toBeLessThan(1); expect(cp.fe).toBe(true);
      expect(r.opened.proof?.input).toBe(c.crates[0].id);
      const rec = await col.copyRecord(cp.uid);
      expect(rec?.copy).toEqual(cp); expect(rec?.owner).toBe(W.toLowerCase());
      expect(rec?.history[0]).toMatchObject({ ev: "made", origin: "crate", crate: c.crates[0].id, proofDay: r.opened.proof?.day });
    }
    expect((await col.openCrate(W, c.crates[0].id)).ok).toBe(false);
    expect((await col.collectionOf(W)).crates).toHaveLength(0);
  });

  it("ranked duel wins drop crates, streaks upgrade them, a room pays once", async () => {
    await col.onDuelSettled("room-a", W, "0x" + "0d".repeat(20));
    await col.onDuelSettled("room-a", W, "0x" + "0d".repeat(20));
    await col.onDuelSettled("room-b", W, null);
    await col.onDuelSettled("room-c", W, null);
    const tiers = (await col.collectionOf(W)).crates.map((c) => c.tier);
    expect(tiers).toEqual(["uncommon", "uncommon", "rare"]);
  });

  it("duel crate copies trade; dupes are kept; a roll can be checked against the revealed seed", async () => {
    const c = await col.collectionOf(W);
    for (const cr of c.crates) expect((await col.openCrate(W, cr.id)).ok).toBe(true);
    const after = await col.collectionOf(W);
    expect(after.copies.filter((x) => x.origin === "crate" && !x.bound).length).toBe(3);
    for (const id of new Set(after.copies.map((x) => x.item))) expect(after.supply[id] ?? 0).toBeGreaterThanOrEqual(after.copies.some((x) => x.item === id && x.serial) ? 1 : 0);
    // the roll is HMAC(day seed, crate id): recompute it from the stored seed and get the same numbers
    const { createHmac } = await import("node:crypto");
    const { kv } = await import("@/lib/server/kv");
    const o = after.recent[0];
    const seed = (await kv().get(col.COLK.seed(o.proof!.day)))!;
    expect(col.seedHash(seed)).toBe(o.proof!.hash);
    const r = rollsFromDigest(createHmac("sha256", seed).update(o.proof!.input).digest("hex"));
    expect(o.copy!.seed).toBe(r.seed);
    const pr = await col.rollProof();
    expect(pr.tomorrow.day).toBe(pr.today.day + 1);
    expect(pr.revealed.every((x) => x.day < pr.today.day)).toBe(true);
  });

  it("scrap gives XP and destroys the copy; trade-up turns 10 into 1 of the next rarity", async () => {
    const T = "0x" + "7e".repeat(20);
    const { kv } = await import("@/lib/server/kv");
    await col.collectionOf(T);
    const commons = ITEMS.filter((i) => i.series === 1 && i.rar === "common" && i.kind === "skin" && i.id !== STARTER_SKIN).slice(0, 5);
    for (const i of commons) await kv().sadd(col.COLK.own(T), i.id);   // legacy ids migrate into copies
    await kv().del(col.COLK.inv(T));
    let cur = await col.collectionOf(T);
    expect(cur.copies.filter((x) => x.origin === "migrated")).toHaveLength(5);
    const victim = cur.copies.find((x) => x.origin === "migrated")!;
    const sc = await col.scrapCopy(T, victim.uid);
    expect(sc.ok).toBe(true);
    expect((await col.scrapCopy(T, victim.uid)).ok).toBe(false);
    const vr = await col.copyRecord(victim.uid);   // the record outlives the copy, so its uid and serial are never reused
    expect(vr?.burned).toBe(true); expect(vr?.copy.serial).toBe(victim.serial);
    expect(vr?.history.map((e) => e.ev)).toEqual(["made", "burned"]);
    expect((await col.collectionOf(T)).owned).not.toContain(victim.item);
    expect((await col.scrapCopy(T, cur.copies.find((x) => x.origin === "starter")!.uid)).ok).toBe(false);
    // build 10 Series 1 commons and trade them up
    cur = await col.collectionOf(T);
    const inv = cur.copies.filter((x) => x.origin === "migrated");
    const raw = JSON.parse((await kv().get(col.COLK.inv(T)))!);
    for (let k = inv.length; k < TRADE_UP_N; k++) raw.push({ ...inv[0], uid: `extra-${k}`, serial: 900 + k });
    await kv().set(col.COLK.inv(T), JSON.stringify(raw));
    cur = await col.collectionOf(T);
    const ten = cur.copies.filter((x) => x.origin === "migrated").map((x) => x.uid);
    expect(ten).toHaveLength(TRADE_UP_N);
    expect((await col.tradeUp(T, ten.slice(0, 9))).ok).toBe(false);
    const tu = await col.tradeUp(T, ten);
    expect(tu.ok).toBe(true);
    if (tu.ok) { expect(tu.item.rar).toBe("uncommon"); expect(tu.item.series).toBe(1); expect(tu.copy.origin).toBe("tradeup"); }
    if (tu.ok) {
      expect(tu.copy.uid).toMatch(/^[a-f0-9]{16}$/); expect(tu.copy.fe).toBe(false);
      const r = await col.copyRecord(tu.copy.uid);
      expect(r?.owner).toBe(T); expect(r?.history[0]).toMatchObject({ ev: "made", origin: "tradeup", from: ten });
      const fromReal = (await col.copyRecord(ten.find((u) => /^[a-f0-9]{16}$/.test(u))!))!;
      expect(fromReal.history.at(-1)).toMatchObject({ ev: "burned", why: "tradeup", into: tu.copy.uid });
    }
    const end = await col.collectionOf(T);
    expect(end.copies.filter((x) => x.origin === "migrated")).toHaveLength(0);
    expect(end.copies.filter((x) => x.origin === "tradeup")).toHaveLength(1);
  });

  it("a look saved before copies is tied to its copy on migration, so the copy you fly can't be scrapped", async () => {
    const { kv } = await import("@/lib/server/kv");
    const L = "0x" + "1e".repeat(20), item = "bullet--hazard";
    await kv().sadd(col.COLK.own(L), item);
    await kv().set(col.COLK.looks(L), JSON.stringify({ hull: "classic", flare: "gold", skin: item, trail: "trail-gold" }));
    const c = await col.collectionOf(L);
    const cp = c.copies.find((x) => x.item === item)!;
    expect(c.equippedCopy.skin).toBe(cp.uid);
    expect(JSON.parse((await kv().get(col.COLK.looks(L)))!).copy.skin).toBe(cp.uid);
    expect((await col.scrapCopy(L, cp.uid)).ok).toBe(false);
    // and with the link missing (an old record), the scrap still refuses
    await kv().set(col.COLK.looks(L), JSON.stringify({ hull: "classic", flare: "gold", skin: item, trail: "trail-gold" }));
    expect((await col.scrapCopy(L, cp.uid)).ok).toBe(false);
  });

  it("levels don't drop crates (cut with the XP shop); equip checks ownership", async () => {
    const before = (await col.collectionOf(W)).crates.length;
    await xp.award(W, { src: "test:grant", kind: "mission", xp: 20000, label: "test", ts: Date.now() });
    expect((await col.collectionOf(W)).crates.length).toBe(before);
    expect((await col.equip(W, "needle--nebula", "trail-gold")).ok).toBe(false);
    expect((await col.equip(W, STARTER_SKIN, "trail-gold")).ok).toBe(true);
    expect((await col.equip(W, STARTER_SKIN, "trail-halo")).ok).toBe(false);          // Prestige 2
    expect((await col.equip(W, STARTER_SKIN, "trail-gold", "tag-prestige-1")).ok).toBe(false);
    expect((await col.equip(W, STARTER_SKIN, "trail-gold", "tag-mythic")).ok).toBe(false);
    const e = await col.equip(W, STARTER_SKIN, "trail-gold", STARTER_TAG);
    expect(e.ok && e.equipped.tag).toBe(STARTER_TAG);
    expect(e.ok && e.equipped.copy.skin).toBe(`st-${STARTER_SKIN}`);
  });

  it("level rewards land as bound copies in the collection, once each", async () => {
    const P = "0x" + "e1".repeat(20);
    expect((await col.collectionOf(P)).copies.some((c) => c.origin === "reward")).toBe(false);
    await xp.award(P, { src: "test:reward", kind: "mission", xp: 20000, label: "test", ts: Date.now() });
    const lvl = (await xp.xpSummary(P)).level.level;
    const due = REWARDS.filter((r) => r.rule.kind === "level" && lvl >= r.rule.level).map((r) => r.item);
    expect(due.length).toBeGreaterThan(0);
    const c = await col.collectionOf(P);
    const got = c.copies.filter((x) => x.origin === "reward");
    expect(got.map((x) => x.item).sort()).toEqual([...due].sort());
    expect(got.every((x) => x.bound && x.serial >= 1)).toBe(true);
    for (const id of due) expect(c.owned).toContain(id);
    expect((await col.collectionOf(P)).copies.filter((x) => x.origin === "reward")).toHaveLength(due.length);
    // a reward skin can be flown
    const skin = due.find((id) => id.includes("--"));
    if (skin) expect((await col.equip(P, skin, "trail-gold")).ok).toBe(true);
  });

  it("a catalogue save can't change or pull back an item that has copies, and new items need art", async () => {
    const cat = await import("@/lib/server/catalog");
    const { kv } = await import("@/lib/server/kv");
    expect((await col.collectionOf(W)).copies.some((x) => x.serial > 0 && itemById(x.item)?.series === 1)).toBe(true);
    const now = Date.now();
    const ok = await cat.saveCatalog({ v: 0, drops: [{ id: "s1-afterburn", series: 1, name: "Afterburn", start: now + 28 * DAY_MS }] }, 0, "test", kv(), now);
    expect(ok.ok).toBe(true);
    const stale = await cat.saveCatalog({ v: 0 }, 0, "test", kv(), now);
    expect(stale.ok).toBe(false);
    const hide = await cat.saveCatalog({ v: 0, series: [{ n: 1, start: now + DAY_MS }] }, 1, "test", kv(), now);
    expect(hide.ok).toBe(false);
    if (!hide.ok) expect(hide.problems?.some((p) => p.includes("pulled back"))).toBe(true);   // Series 1 copies exist
    const noArt = await cat.saveCatalog({ v: 0, series: [{ n: 3, hulls: ["pulp"], paints: ["nebula"], start: null, end: null }] }, 1, "test", kv(), now);
    expect(noArt.ok).toBe(false);
    const clash = await cat.saveCatalog({ v: 0, series: [{ n: 3, hulls: ["needle"], paints: ["nebula"], start: null, end: null }] }, 1, "test", kv(), now);
    expect(!clash.ok && clash.problems?.some((p) => p.includes("already in Series 1"))).toBe(true);
    const recode = await cat.saveCatalog({ v: 0, paints: { nebula: { name: "Nebula II", rar: "mythic" } } }, 1, "test", kv(), now);
    expect(recode.ok).toBe(false);
    cat.resetCatalogCache();
    expect((await cat.ensureCatalog(kv()))?.v).toBe(1);
    const { DROPS } = await import("@/lib/collection");
    expect(DROPS[0].start).toBe(now + 28 * DAY_MS);
    await kv().del(cat.CATK.catalog()); cat.resetCatalogCache(); await cat.ensureCatalog(kv());
  });
});
