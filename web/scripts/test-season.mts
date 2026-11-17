/** Trading Duel seasons (lib/duel/season): month boundaries, SP math, leagues. Run: pnpm test:season */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applySp, isStreakMilestone, leagueOf, leagueProgress, seasonAt, spDelta } from "../lib/duel/season.ts";

test("a season is one UTC month, Season 1 is Nov 2026", () => {
  assert.deepEqual(seasonAt(Date.parse("2026-11-17T02:00:00Z")).n, 1);
  assert.equal(seasonAt(Date.parse("2026-11-17T02:00:00Z")).id, "2026-11");
  assert.equal(seasonAt(Date.parse("2026-12-01T00:00:00Z")).n, 2);
  assert.equal(seasonAt(Date.parse("2027-11-30T23:59:59Z")).n, 13);
  assert.equal(seasonAt(Date.parse("2026-10-01T00:00:00Z")).n, 1); // before launch reports Season 1
  const s = seasonAt(Date.parse("2026-11-17T02:00:00Z"));
  assert.equal(s.endsAt, Date.parse("2026-12-01T00:00:00Z"));
});

test("season points: wins, streak bonus capped, draws, losses floored at 0", () => {
  assert.equal(spDelta(1, 0), 30);
  assert.equal(spDelta(1, 2), 40);
  assert.equal(spDelta(1, 50), 55);
  assert.equal(spDelta(0.5, 4), 10);
  assert.equal(spDelta(0, 4), -15);
  assert.equal(applySp(10, -15), 0);
  assert.equal(applySp(100, 30), 130);
});

test("leagues and progress", () => {
  assert.equal(leagueOf(0).id, "rookie");
  assert.equal(leagueOf(99).id, "rookie");
  assert.equal(leagueOf(100).id, "bronze");
  assert.equal(leagueOf(5000).id, "champion");
  const p = leagueProgress(175);
  assert.equal(p.league.id, "bronze"); assert.equal(p.next?.id, "silver"); assert.equal(p.pct, 0.5);
  assert.equal(leagueProgress(1800).next, null);
  assert.deepEqual([1, 2, 3, 4, 5, 9, 10, 15].filter(isStreakMilestone), [3, 5, 10, 15]);
});
