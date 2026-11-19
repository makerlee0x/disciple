import { beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { matchRank, normQuery, rankBy, itemHref } from "@/lib/search";

describe("search ranking", () => {
  it("normalises what the player typed", () => {
    expect(normQuery("  @Maker ")).toBe("maker");
    expect(normQuery("$MOON")).toBe("moon");
    expect(normQuery("a   b")).toBe("a b");
    expect(normQuery("x".repeat(99))).toHaveLength(40);
  });
  it("ranks exact, prefix, word start, contains", () => {
    expect(matchRank("gold", "gold")).toBe(0);
    expect(matchRank("goldenboy", "gold")).toBe(1);
    expect(matchRank("Bullet | Marble & Gold Leaf", "gold")).toBe(2);
    expect(matchRank("ungolden", "gold")).toBe(3);
    expect(matchRank("silver", "gold")).toBe(-1);
  });
  it("keeps best matches first, then the tie order", () => {
    const rows = [{ t: "ungold", m: 9 }, { t: "gold coin", m: 1 }, { t: "gold rush", m: 5 }, { t: "nope", m: 99 }];
    expect(rankBy(rows, (r) => [r.t], "gold", (a, b) => b.m - a.m).map((r) => r.t)).toEqual(["gold rush", "gold coin", "ungold"]);
  });
  it("links a listed item to its listing, an unlisted one to the market search", () => {
    const base = { id: "x", title: "Gold trail", kind: "trail", rar: "common", art: "", floor: null, listed: 0, listing: null };
    expect(itemHref(base)).toBe("/market?q=Gold%20trail");
    expect(itemHref({ ...base, listing: "abcdef123456" })).toBe("/market?listing=abcdef123456");
  });
});

describe("search server (local KV)", () => {
  let srv: typeof import("@/lib/server/search");
  let names: typeof import("@/lib/server/usernames");
  let kvMod: typeof import("@/lib/server/kv");
  beforeAll(async () => {
    process.env.KV_LOCAL_FILE = join(tmpdir(), `search-test-${Date.now()}.json`);
    kvMod = await import("@/lib/server/kv");
    names = await import("@/lib/server/usernames");
    srv = await import("@/lib/server/search");
  });
  const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20);

  it("fills the index once from names claimed before it existed, and follows renames", async () => {
    const s = kvMod.kv();
    await s.set("user:name:oldtimer", A); await s.set(`user:addr:${A}`, "oldtimer");
    await s.set(`user:meta:${A}`, JSON.stringify({ pfp: "", bio: "", flag: "", name: "Golden Boy" }));
    let rows = await srv.readUsers(s);
    expect(rows.map((r) => r.username)).toContain("oldtimer");
    expect(srv.searchPilots("golden", rows)).toEqual([{ username: "oldtimer", name: "Golden Boy", pfp: null, nft: false }]);

    expect((await names.claim("gold_rush", B)).ok).toBe(true);
    expect((await names.claim("newname", A)).ok).toBe(true); // rename: oldtimer is released
    rows = await srv.readUsers(s);
    expect(rows.map((r) => r.username).sort()).toEqual(["gold_rush", "newname"]);
    expect(srv.searchPilots(normQuery("@gold"), rows).map((p) => p.username)).toEqual(["gold_rush", "newname"]); // name then display name
    expect(srv.searchPilots(B, rows).map((p) => p.username)).toEqual(["gold_rush"]);
  });

  it("finds rockets by ticker, name or address, bigger first", () => {
    const c = (token: string, name: string, ticker: string, mcapUsd: number) => ({ token, name, ticker, icon: "", mcapUsd, graduated: false });
    const coins = [c("0x" + "1".repeat(40), "Digital Gold", "GOLD", 400_000), c("0x" + "2".repeat(40), "Golden Retriever", "GOLDEN", 38_000), c("0x" + "3".repeat(40), "Moon", "MOON", 1)];
    expect(srv.searchRockets("gold", coins).map((r) => r.ticker)).toEqual(["GOLD", "GOLDEN"]);
    expect(srv.searchRockets("retr", coins).map((r) => r.ticker)).toEqual(["GOLDEN"]);
    expect(srv.searchRockets("0x" + "3".repeat(40), coins).map((r) => r.ticker)).toEqual(["MOON"]);
  });

  it("finds items that are out, listed ones first with the floor", () => {
    const listed = new Map([["bullet--marble-gilt", { floor: 248000, n: 3, id: "abcdef123456" }]]);
    const hits = srv.searchItems("gold", listed);
    expect(hits[0]).toMatchObject({ id: "bullet--marble-gilt", floor: 248000, listed: 3, listing: "abcdef123456" });
    expect(srv.searchItems("aurora", new Map())).toEqual([]); // Series 2 isn't out
  });
});
