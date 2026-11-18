// Lifetime points (lib/server/lifetime): finished seasons sealed once, plus this season; never reset.
//   pnpm test:lifetime   (local KV file in /tmp, no network)
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.KV_REST_API_URL;
process.env.KV_LOCAL_FILE = join(tmpdir(), `lifetime-test-${process.pid}.json`);
const L = await import("../lib/server/lifetime");
const M = await import("../lib/server/seasonModes");
const { kv } = await import("../lib/server/kv");
const { SEASON_MS, SEASON_ONE_START } = await import("../lib/duel/season");

const a = "0x" + "a".repeat(40), b = "0x" + "b".repeat(40), c = "0x" + "c".repeat(40);

test("addLife: finished seasons + this season, sorted, zero rows dropped", () => {
  const r = L.addLife({ [a]: 1000, [b]: 200 }, [{ wallet: b, pts: 900 }, { wallet: c, pts: 50 }, { wallet: "0x0", pts: 0 }]);
  assert.deepEqual(r.map((x) => [x.wallet, x.pts, x.season]), [[b, 1100, 900], [a, 1000, 0], [c, 50, 50]]);
});

test("a season reset keeps lifetime points: season 1 is sealed into lifetime once season 2 starts", async () => {
  const s = kv();
  const in1 = SEASON_ONE_START + 1000, in2 = SEASON_ONE_START + SEASON_MS + 1000, in3 = SEASON_ONE_START + 2 * SEASON_MS + 1000;
  // season 1: a clears climb level 3 (300 SP) and wins a royale (50); rockets SP only in the snapshot
  await M.awardClimbClear(a, 3, 40_000, s, in1);
  await M.awardRoyale(a, 1, s, in1);
  await L.snapSeason("s1", [{ wallet: a, by: { climb: 300, royale: 50, rockets: 40 } }, { wallet: b, by: { rockets: 25 } }], s);
  assert.deepEqual(await L.finishedLife(1, s), {}, "nothing finished during season 1");
  const life2 = await L.finishedLife(2, s);
  assert.deepEqual(life2, { [a]: 390, [b]: 25 });
  // read again: sealed once, not added twice
  assert.deepEqual(await L.finishedLife(2, s), life2);
  // season 2: b climbs; season SP starts at 0 again, lifetime keeps growing
  await M.awardClimbClear(b, 2, 30_000, s, in2);
  assert.equal((await M.modeSp("climb", 100, s, in2))[b], 200);
  assert.equal((await M.modeSp("climb", 100, s, in2))[a], undefined, "season points reset");
  await L.snapSeason("s2", [{ wallet: b, by: { climb: 200 } }], s);
  const life3 = await L.finishedLife(3, s);
  assert.deepEqual(life3, { [a]: 390, [b]: 225 });
  void in3;
});
