/** Trading Duel seasons (lib/duel/season): 12-week seasons from launch, SP math, leagues. Run: pnpm test:season */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SEASON_MS, SEASON_ONE_START, applySp, isStreakMilestone, leagueOf, leagueProgress, seasonAt, spDelta } from "../lib/duel/season.ts";

test("a season is 12 weeks from SEASON_ONE_START (launch)", () => {
  const W = 7 * 86_400_000;
  assert.equal(SEASON_MS, 12 * W);
  const s1 = seasonAt(SEASON_ONE_START + 1000);
  assert.equal(s1.n, 1);
  assert.equal(s1.id, "s1");
  assert.equal(s1.startsAt, SEASON_ONE_START);
  assert.equal(s1.endsAt, SEASON_ONE_START + 12 * W);
  assert.equal(seasonAt(SEASON_ONE_START + 12 * W - 1).n, 1);
  assert.equal(seasonAt(SEASON_ONE_START + 12 * W).n, 2);
  assert.equal(seasonAt(SEASON_ONE_START + 52 * W).n, 5);
  assert.equal(seasonAt(SEASON_ONE_START - 30 * 86_400_000).n, 1); // before launch reports Season 1
  assert.equal(seasonAt(SEASON_ONE_START - 30 * 86_400_000).startsAt, SEASON_ONE_START);
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
