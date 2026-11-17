// Launch rocket (maker 2026-11-16): any skin/trail that's out, or one you own, goes on a coin; nothing unreleased; shuffle.
//   pnpm test:coin-look
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLASSIC, launchPool, lookAllowed, parseLook, shuffleLook, lookFromCopy, lookArt } from "../lib/coinLook";
import { ITEMS, itemOut } from "../lib/collection";

const now = Date.now();
test("the launch pool only holds released, non-prestige items", () => {
  const p = launchPool(now);
  assert.ok(p.skins.length > 0 && p.trails.length > 0);
  for (const i of [...p.skins, ...p.trails]) { assert.ok(itemOut(i, now), `${i.id} is out`); assert.ok(!i.prestige, `${i.id} isn't prestige`); }
  const unreleased = ITEMS.filter((i) => (i.kind === "skin" || i.kind === "trail") && !itemOut(i, now));
  assert.ok(unreleased.length > 0, "Series 2 / Afterburn aren't out yet");
  for (const i of unreleased) assert.ok(!p.skins.concat(p.trails).some((x) => x.id === i.id), `${i.id} must not be offered`);
});
test("unreleased items are refused unless owned; classic is always fine", () => {
  const none = new Set<string>();
  assert.equal(lookAllowed(CLASSIC, "skin", none, now), true);
  const s2 = ITEMS.find((i) => i.kind === "skin" && !itemOut(i, now))!;
  assert.equal(lookAllowed(s2.id, "skin", none, now), false);
  assert.equal(lookAllowed(s2.id, "skin", new Set([s2.id]), now), true);
  assert.equal(lookAllowed("trail-halo", "trail", none, now), false, "prestige trail needs owning");
  assert.equal(lookAllowed("bullet--nebula", "trail", none, now), false, "wrong slot");
});
test("shuffle picks from the pool and moves off the current pick", () => {
  const p = launchPool(now), opts = { skins: [{ id: CLASSIC }, ...p.skins], trails: p.trails };
  for (let k = 0; k < 50; k++) {
    const l = shuffleLook(opts, { skin: p.skins[0].id, trail: p.trails[0].id });
    assert.notEqual(l.skin, CLASSIC); assert.notEqual(l.skin, p.skins[0].id);
    assert.ok(p.skins.some((x) => x.id === l.skin) && p.trails.some((x) => x.id === l.trail));
  }
});
test("a stamped look round-trips; junk doesn't", () => {
  const l = lookFromCopy("needle--walnut-brass", "trail-ember", { serial: 812, burn: 0.04, seed: 410 });
  assert.deepEqual(parseLook(JSON.parse(JSON.stringify(l))), l);
  assert.equal(parseLook({ skin: "nope", trail: "trail-gold" }), null);
  assert.deepEqual(parseLook({ skin: CLASSIC, trail: "trail-gold", serial: 9 }), { skin: CLASSIC, trail: "trail-gold" });
  assert.equal(lookArt(l).hull, "needle"); assert.equal(lookArt(null).src, null);
});
