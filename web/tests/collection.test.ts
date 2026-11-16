import { beforeAll, describe, expect, it } from "vitest";
import {
  CRATE, ITEMS, PAINTS, RARITIES, SERIES, STARTER_SKIN, crateOdds, dropPool, duelCrateTier, itemById, rollCrate, shopStock, skinArt, DAY_MS,
} from "@/lib/collection";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("collection catalogue", () => {
  it("every skin in a series has art, and ids are unique", () => {
    const ids = new Set<string>();
    for (const i of ITEMS) { expect(ids.has(i.id)).toBe(false); ids.add(i.id); }
    for (const i of ITEMS.filter((x) => x.kind === "skin")) expect(existsSync(join(__dirname, "..", "public", skinArt(i.id)))).toBe(true);
    for (const s of SERIES) for (const p of s.paints) expect(PAINTS[p]).toBeTruthy();
  });

  it("only the live series drops (Series 1 at launch: 2 hulls x 13 paints, plus trails)", () => {
    const pool = dropPool(Date.UTC(2026, 10, 20));
    const skins = pool.filter((i) => i.kind === "skin");
    expect(skins.length).toBe(26);
    expect(new Set(skins.map((s) => s.hull))).toEqual(new Set(["bullet", "needle"]));
    expect(pool.some((i) => i.hull === "pulp")).toBe(false);
  });

  it("crate odds start at the floor and add to 100", () => {
    for (const t of RARITIES) {
      const o = crateOdds(t);
      expect(o[0].rar).toBe(CRATE[t].floor);
      expect(o.reduce((a, r) => a + r.pct, 0)).toBeCloseTo(100, 6);
    }
    expect(crateOdds("common").find((r) => r.rar === "mythic")!.pct).toBeCloseTo(0.2, 6);
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

  it("the shop is the same for everyone each day, never sells Mythic or the starter, and the featured slot lasts 2 days", () => {
    const d = Date.UTC(2026, 10, 20, 9);
    expect(shopStock(d)).toEqual(shopStock(d + 3600_000));
    const s = shopStock(d);
    expect(s.daily).toHaveLength(3);
    for (const i of [s.featured!, ...s.daily]) { expect(i.rar).not.toBe("mythic"); expect(i.id).not.toBe(STARTER_SKIN); }
    expect(["epic", "legendary"]).toContain(s.featured!.rar);
    const even = Math.floor(d / DAY_MS) % 2 === 0 ? d : d + DAY_MS;
    expect(shopStock(even).featured!.id).toBe(shopStock(even + DAY_MS).featured!.id);
  });

  it("win streaks upgrade the duel crate", () => {
    expect(duelCrateTier(1)).toBe("uncommon");
    expect(duelCrateTier(3)).toBe("rare");
    expect(duelCrateTier(7)).toBe("epic");
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
    process.env.KV_LOCAL_FILE = join(require("node:os").tmpdir(), `col-test-${Date.now()}.json`);
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
    if (r.ok) { expect(r.opened.xp).toBeGreaterThanOrEqual(CRATE.rare.xp); expect(r.opened.item).toBeTruthy(); }
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

  it("the shop checks stock, balance and ownership; equip checks ownership", async () => {
    const s = shopStock(Date.now());
    expect((await col.buyItem(W, "needle--marble-gilt")).ok).toBe(false);   // never sold
    const r = await col.buyItem(W, s.daily[0].id);
    expect(r.ok).toBe(false);   // not enough XP yet
    await xp.award(W, { src: "test:grant", kind: "mission", xp: 20000, label: "test", ts: Date.now() });
    const b = await col.buyItem(W, s.daily[0].id);
    expect(b.ok).toBe(true);
    expect((await col.buyItem(W, s.daily[0].id)).ok).toBe(false);
    expect((await col.equip(W, "needle--nebula", "trail-gold")).ok).toBe(false);
    expect((await col.equip(W, STARTER_SKIN, "trail-gold")).ok).toBe(true);
    const crate = await col.buyItem(W, "crate-common");
    expect(crate.ok).toBe(true);
  });
});
