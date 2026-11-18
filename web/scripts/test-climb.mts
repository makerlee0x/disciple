// Climb (solo Turbo): the level ladder and the unlock rule.   pnpm test:climb
import { test } from "node:test";
import assert from "node:assert/strict";
const R = await import("../lib/climb/rules");

test("ladder: five levels, fuel and gear climb, gear caps at 50x, goals are 1/3/5/7.5/10% of fuel", () => {
  assert.deepEqual(R.CLIMB_LEVELS.map((l) => l.fuel), [12, 33, 77, 333, 1200]);
  assert.deepEqual(R.CLIMB_LEVELS.map((l) => l.gear), [10, 20, 30, 40, 50]);
  assert.ok(R.CLIMB_LEVELS.every((l) => l.gear <= R.CLIMB_MAX_GEAR));
  assert.deepEqual(R.CLIMB_LEVELS.map((l) => Math.round(l.goal / l.fuel * 1000) / 10), [1, 3, 5, 7.5, 10]);
  assert.equal(R.CLIMB_FREE, 6);
});

test("one clear unlocks the next level; a miss or a loss changes nothing", () => {
  assert.equal(R.unlockAfter(1, 1, 0.12), 2);
  assert.equal(R.unlockAfter(1, 1, 0.11), 1);
  assert.equal(R.unlockAfter(3, 3, -10), 3);
  assert.equal(R.unlockAfter(5, 5, 120), 6);   // free mode
});

test("dollar skips: $7 on level 1 is past level 3's $3.85, so level 3 unlocks", () => {
  assert.equal(R.unlockAfter(1, 1, 7), 3);
  assert.equal(R.unlockAfter(1, 1, 30), 4);
  assert.equal(R.unlockAfter(1, 1, 150), 5);   // beating level 5's goal opens level 5, not free mode
  assert.equal(R.unlockAfter(2, 2, 1), 3);
});

test("levels never go down, and replaying a lower level can't lose one", () => {
  assert.equal(R.unlockAfter(4, 1, 0.5), 4);
  assert.equal(R.unlockAfter(6, 2, 0), 6);
  assert.equal(R.unlockAfter(0, 1, 0), 1);
  assert.equal(R.unlockAfter(99, 1, 0), 6);
});

test("test out: a hit unlocks that level", () => {
  assert.equal(R.unlockAfterTest(1, 4, 25), 4);
  assert.equal(R.unlockAfterTest(1, 4, 24), 3);   // missed level 4, but $24 is past level 3's $3.85
  assert.equal(R.unlockAfterTest(1, 5, 130), 5);
  assert.equal(R.unlockAfterTest(1, 4, -5), 1);
});

test("goals are checked in cents, like the screen: +$0.1196 shows +$0.12 and clears level 1", () => {
  assert.equal(R.unlockAfter(1, 1, 0.1196), 2);
  assert.equal(R.unlockAfter(1, 1, 0.114), 1);
});

test("levels scale with the balance: level 5 = the balance, same % goals; tiny or no balance uses the $1,200 ladder", () => {
  const k = R.climbLevelsFor(1000);
  assert.equal(k[4].fuel, 1000); assert.equal(k[4].goal, 100);
  assert.equal(k[0].fuel, 10); assert.equal(k[0].goal, 0.1);
  const t = R.climbLevelsFor(20);
  assert.equal(t[4].fuel, 20); assert.equal(t[0].fuel, 2);   // $2 floor
  assert.equal(R.climbLevelsFor(100)[0].fuel, 2); assert.equal(R.climbLevelsFor(100)[0].goal, 0.02);
  assert.deepEqual(R.climbLevelsFor(0).map((l) => l.fuel), [12, 33, 77, 333, 1200]);
  // unlocks use the scaled ladder's $ goals
  assert.equal(R.unlockAfter(1, 1, 0.1, k), 2);
});
