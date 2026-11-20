// Climb (solo Turbo): the level ladder and the unlock rule.   pnpm test:climb
import { test } from "node:test";
import assert from "node:assert/strict";
const R = await import("../lib/climb/rules");

test("ladder: five levels, fuel and gear climb, gear caps at 50x, goals are 1/3/5/7.5/10% of fuel", () => {
  assert.deepEqual(R.CLIMB_LEVELS.map((l) => l.fuel), [12, 33, 77, 333, 1000]);
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

test("goals are checked on the rounded-down screen number: +$0.1196 shows +$0.119 and misses; +$0.12 clears", () => {
  assert.equal(R.unlockAfter(1, 1, 0.1196), 1);
  assert.equal(R.unlockAfter(1, 1, 0.12), 2);
  assert.equal(R.unlockAfter(1, 1, 0.1204), 2);
});

test("levels scale with the balance: level 5 = 83% of the balance (the rest backs the NUKE line), same % goals; tiny or no balance uses the $1,200 ladder", () => {
  const k = R.climbLevelsFor(1000);
  assert.equal(k[4].fuel, 833.33); assert.equal(k[4].goal, 83.33);
  assert.equal(R.climbLevelsFor(1200)[4].fuel, 1000);
  assert.equal(k[0].fuel, 10); assert.equal(k[0].goal, 0.1);
  const t = R.climbLevelsFor(20);
  assert.equal(t[4].fuel, 16.66); assert.equal(t[0].fuel, 2);   // $2 floor
  assert.equal(R.climbLevelsFor(100)[0].fuel, 2); assert.equal(R.climbLevelsFor(100)[0].goal, 0.02);
  assert.deepEqual(R.climbLevelsFor(0).map((l) => l.fuel), [12, 33, 77, 333, 1000]);
  // unlocks use the scaled ladder's $ goals
  assert.equal(R.unlockAfter(1, 1, 0.1, k), 2);
});

test("stake per round: cap is the margin at 50x (cash covers 1.2x the stake), presets 25% / 50% / MAX, $2 floor", () => {
  assert.equal(R.climbStakeCap(1200), 1000);
  assert.deepEqual(R.climbStakePresets(1200), [250, 500, 1000]);
  assert.equal(R.climbStakeCap(0), 1000);            // play money with nothing in it: the $1,200 ladder
  assert.equal(R.climbStakeCap(0, true), 2);         // real money: the real balance, $2 floor
  assert.equal(R.climbStakeCap(5.95, true), 4.95);
  for (const b of [6, 20, 100, 1200, 5000]) { const c = R.climbStakeCap(b, true); assert.ok(c === 2 || Math.ceil(c * 120) / 100 <= b + 1e-9, `cap ${c} on ${b}`); }
  assert.equal(R.stakeFor({ c: 5000 }, 1200), 1000);  // custom clamps to the cap
  assert.equal(R.stakeFor({ c: 0.5 }, 1200), 2);
  assert.equal(R.stakeFor({ p: 1 }, 100, true), 41);     // half of $83.33, rounded down to whole dollars
});

test("every level flies the stake, keeps its gear and its % goal", () => {
  const L = R.climbLevelsAt(100);
  assert.deepEqual(L.map((l) => l.fuel), [100, 100, 100, 100, 100]);
  assert.deepEqual(L.map((l) => l.gear), [10, 20, 30, 40, 50]);
  assert.deepEqual(L.map((l) => l.goal), [1, 3, 5, 7.5, 10]);
  assert.equal(R.unlockAfter(1, 1, 10, L), 5);           // beating level 5's $ goal at the same stake jumps there
});
