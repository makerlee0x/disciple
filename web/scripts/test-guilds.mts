// Guilds V1: pure rules + store over an in-memory KV.   npm run test:guilds
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  COUNTRY_FLAGS_ENABLED, GUILDS_PER_PLAYER, GUILD_COPY, GUILD_SWITCH_COOLDOWN_MS, GUILD_TAG_MAX, GUILD_TAG_MIN, isGuildId, normalizeTag,
  seedGuildByTag, seedGuilds, validateTag,
} from "../lib/guilds.ts";
import { GUILD_CATEGORIES, GUILD_LOGOS_COMMITTED, GUILD_SEED, guildLogoPath } from "../lib/guildSeed.ts";
import { createGuildStore, type GuildKv } from "../lib/server/guildStore.ts";
import { clearOldFlag } from "../lib/guildMigration.ts";

function memKv(): GuildKv {
  const kv = new Map<string, string>(); const z = new Map<string, Map<string, number>>();
  return {
    async get(k) { return kv.get(k) ?? null; },
    async mget(ks) { return ks.map((k) => kv.get(k) ?? null); },
    async set(k, v) { kv.set(k, v); },
    async setNX(k, v) { if (kv.has(k)) return false; kv.set(k, v); return true; },
    async del(...ks) { ks.forEach((k) => kv.delete(k)); },
    async zadd(k, items) { const m = z.get(k) ?? new Map(); items.forEach((i) => { if (!m.has(i.member)) m.set(i.member, i.score); }); z.set(k, m); },
    async zrange(k, limit = 1000, rev = false) { return [...(z.get(k) ?? new Map()).entries()].sort((a, b) => (rev ? b[1] - a[1] : a[1] - b[1])).slice(0, limit).map(([m]) => m); },
    async zrem(k, ...ms) { const m = z.get(k); if (!m) return 0; let n = 0; ms.forEach((x) => { if (m.delete(x)) n++; }); return n; },
  };
}
const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40);

test("defaults are lee's: one guild, once a day, no country flags, 2–5 char tags", () => {
  assert.equal(GUILDS_PER_PLAYER, 1);
  assert.equal(GUILD_SWITCH_COOLDOWN_MS, 24 * 60 * 60 * 1000);
  assert.equal(COUNTRY_FLAGS_ENABLED, false);
  assert.deepEqual([GUILD_TAG_MIN, GUILD_TAG_MAX], [2, 5]);
  assert.ok(!("promptTitle" in GUILD_COPY), "no Pick-your-guild prompt");
});

test("seed: 12 guilds in 3 categories, unique valid tags and ids, logos off until reviewed", () => {
  assert.equal(GUILD_SEED.length, 12);
  assert.deepEqual(GUILD_CATEGORIES.map((c) => c.id), ["long", "robinhood", "og"]);
  const per = (c: string) => GUILD_SEED.filter((g) => g.category === c).map((g) => g.id);
  assert.deepEqual(per("long"), ["g-strategy", "g-ai", "g-schiffy"]);
  assert.deepEqual(per("robinhood"), ["g-cashcat", "g-pons", "g-orbio"]);
  assert.deepEqual(per("og"), ["g-pengu", "g-mog", "g-pepe", "g-dood", "g-jesus", "g-anime"]);
  assert.equal(new Set(GUILD_SEED.map((g) => g.tag)).size, 12);
  for (const g of GUILD_SEED) { assert.ok(isGuildId(g.id), g.id); assert.match(g.tag, /^[A-Z0-9]{2,5}$/); }
  if (!GUILD_LOGOS_COMMITTED) for (const g of seedGuilds()) assert.equal(g.mark, "", "placeholder until logos are committed");
  else for (const g of GUILD_SEED) if (g.coingeckoId) assert.ok(existsSync(new URL(`../public${guildLogoPath(g.id)}`, import.meta.url)), g.id);
});

test("tag rules", () => {
  assert.equal(normalizeTag(" [abc] "), "ABC");
  assert.equal(validateTag("ABC"), null);
  assert.equal(validateTag("A"), GUILD_COPY.tagRule);
  assert.equal(validateTag("ABCDEF"), GUILD_COPY.tagRule);
  assert.equal(validateTag("AB-C"), GUILD_COPY.tagRule);
  assert.equal(validateTag("PEPE"), GUILD_COPY.tagTaken); // starter tag
  assert.equal(validateTag("ADMIN"), GUILD_COPY.tagTaken); // reserved
  assert.equal(seedGuildByTag("pepe")?.id, "g-pepe");
});

test("store: join, one per player, daily switch, leave, unique tags, batch tags", async () => {
  let t = 1_800_000_000_000;
  const st = createGuildStore(memKv(), () => t);
  assert.equal(await st.guildOf(A), null);
  const j = await st.join(A, "g-pepe"); assert.ok(j.ok && j.guild?.tag === "PEPE" && j.guild.members === 1);
  assert.ok((await st.join(A, "g-pepe")).ok, "re-join is a no-op");
  const sw = await st.join(A, "g-mog"); assert.ok(sw.ok, "first switch allowed");
  assert.equal((await st.guildOf(A))?.tag, "MOG");
  assert.equal(await st.memberCount("g-pepe"), 0, "one guild per player");
  const again = await st.join(A, "g-pepe"); assert.ok(!again.ok && again.reason === "wait" && again.nextAllowedAt === t + GUILD_SWITCH_COOLDOWN_MS);
  assert.ok(!(await st.leave(A)).ok, "leave also waits");
  t += GUILD_SWITCH_COOLDOWN_MS;
  assert.ok((await st.leave(A)).ok); assert.equal(await st.guildOf(A), null);
  assert.ok((await st.join(A, "g-dood")).ok, "joining from no guild is free");
  assert.ok(!(await st.join(B, "g-nope")).ok);

  const c = await st.create(B, "ZAP", "Zap crew"); assert.ok(c.ok && c.guild?.tag === "ZAP" && c.guild.id.startsWith("u-"));
  const dup = await st.create("0x" + "c".repeat(40), "ZAP", "Other"); assert.ok(!dup.ok && dup.reason === GUILD_COPY.tagTaken);
  assert.equal((await st.guildByTag("zap"))?.id, c.ok ? c.guild?.id : "");
  assert.ok(!(await st.create("0x" + "d".repeat(40), "PEPE", "x")).ok);

  const tags = await st.tagsOf([A.toUpperCase().replace("0X", "0x"), B, "0x" + "e".repeat(40), "junk"]);
  assert.equal(tags[A]?.tag, "DOOD"); assert.equal(tags[B]?.tag, "ZAP"); assert.equal(tags["0x" + "e".repeat(40)], null);
  assert.ok(!("junk" in tags));
  const list = await st.list(); assert.equal(list.length, 13); assert.ok(list.every((g) => typeof g.members === "number"));
});

test("migration clears every old flag silently and is idempotent", () => {
  const a = clearOldFlag(JSON.stringify({ pfp: "p", flag: "c-pepe", bio: "hi" }));
  assert.deepEqual(JSON.parse(a!), { pfp: "p", flag: "", bio: "hi" });
  assert.deepEqual(JSON.parse(clearOldFlag(JSON.stringify({ flag: "US" }))!), { flag: "" });
  assert.equal(clearOldFlag(a), null);
  assert.equal(clearOldFlag(JSON.stringify({ bio: "x" })), null);
  assert.equal(clearOldFlag("not json"), null);
  assert.equal(clearOldFlag(null), null);
});
