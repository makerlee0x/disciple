/** lib/feeRouteKeeper: which coins the route-creator-fees cron sends, and which simulated reverts are "nothing yet". */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KEEPER_LIMITS, codeHasSelector, gasLimitFor, isQuietRouteError, planJobs, rotate, routedTokensFromLogs } from "../lib/feeRouteKeeper";

const A = "0x" + "a".repeat(40), B = "0x" + "B".repeat(40), C = "0x" + "c".repeat(40);

test("only pool (1) and burn (2) coins are routed, once each, lowercased", () => {
  const out = routedTokensFromLogs([
    { args: { token: A, destination: 1 } },
    { args: { token: B, destination: 2n } },
    { args: { token: C, destination: 0 } },
    { args: { token: A, destination: 1 } },
    { args: { token: "0xnope", destination: 2 } },
  ]);
  assert.deepEqual(out, [A, B.toLowerCase()]);
});

test("NothingToRoute / AwaitingOrbit / PriceGuard are quiet; anything else is an error", () => {
  assert.equal(isQuietRouteError('The contract function "route" reverted. Error: NothingToRoute()'), true);
  assert.equal(isQuietRouteError("AwaitingOrbit()"), true);
  assert.equal(isQuietRouteError("PriceGuard()"), true);
  assert.equal(isQuietRouteError("NotClaimRouter()"), false);
});

test("rotate gives every coin a turn", () => {
  assert.deepEqual(rotate([1, 2, 3], 0), [1, 2, 3]);
  assert.deepEqual(rotate([1, 2, 3], 4), [2, 3, 1]);
  assert.deepEqual(rotate([], 7), []);
  assert.ok(KEEPER_LIMITS.MAX_JOBS_PER_RUN > 0 && KEEPER_LIMITS.MAX_JOBS_PER_RUN <= 50);
});

test("the cron is scheduled, authenticated, and simulates before sending", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const vercel = JSON.parse(readFileSync(join(here, "../vercel.json"), "utf8")) as { crons: { path: string }[] };
  assert.ok(vercel.crons.some((c) => c.path === "/api/cron/route-creator-fees"));
  const route = readFileSync(join(here, "../app/api/cron/route-creator-fees/route.ts"), "utf8");
  assert.match(route, /CRON_SECRET/);
  assert.match(route, /cron_not_configured/);
  assert.ok(route.indexOf("simulateContract") < route.indexOf("writeContract"), "simulate first");
  assert.match(route, /FEE_ROUTE_KEEPER_DISABLED/);
});

test("past creators of routed coins become routeWith jobs (audit CH-04)", async () => {
  const { pastCreatorKeys, splitPastKey } = await import("../lib/feeRouteKeeper");
  const routed = new Set([A]);
  const keys = pastCreatorKeys([
    { args: { token: A, previousCreator: B } },
    { args: { token: A, previousCreator: B } },
    { args: { token: C, previousCreator: B } },
    { args: { token: A, previousCreator: "0x" + "0".repeat(40) } },
  ], routed);
  assert.deepEqual(keys, [`${A}:${B.toLowerCase()}`]);
  assert.deepEqual(splitPastKey(keys[0]), { token: A, creator: B.toLowerCase() });
  const route = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../app/api/cron/route-creator-fees/route.ts"), "utf8");
  assert.match(route, /"CreatorTransferred"/);
  assert.match(route, /routeWith\(address,address\)/);
});

test("past-creator jobs are capped per coin and count toward the run limit, so one coin can't crowd out the rest", () => {
  const tokens = Array.from({ length: 30 }, (_, i) => "0x" + i.toString(16).padStart(40, "0"));
  const spam = Array.from({ length: 500 }, (_, i) => "0x" + (i + 1000).toString(16).padStart(40, "f"));
  const past = new Map([[tokens[0], spam]]);
  const { jobs, next, total } = planJobs(tokens, past, { withPast: true, start: 0 });
  assert.equal(jobs.length, KEEPER_LIMITS.MAX_JOBS_PER_RUN);
  assert.equal(jobs.filter((j) => j.fn === "routeWith").length, KEEPER_LIMITS.MAX_PAST_PER_COIN);
  assert.equal(total, tokens.length + KEEPER_LIMITS.MAX_PAST_PER_COIN);
  // the next run carries on where this one stopped, and every coin is reached within two runs
  const second = planJobs(tokens, past, { withPast: true, start: next });
  const routed = new Set([...jobs, ...second.jobs].filter((j) => j.fn === "route").map((j) => j.token));
  assert.equal(routed.size, tokens.length);
  // a harvest without routeWith gets no routeWith jobs at all
  assert.equal(planJobs(tokens, past, { withPast: false, start: 0 }).jobs.some((j) => j.fn === "routeWith"), false);
});

test("gas is capped per tx: over the cap is skipped, under it gets +20% but never past the cap", () => {
  assert.equal(gasLimitFor(KEEPER_LIMITS.GAS_PER_TX + BigInt(1)), null);
  assert.equal(gasLimitFor(BigInt(500_000)), BigInt(600_000));
  assert.equal(gasLimitFor(BigInt(1_400_000)), KEEPER_LIMITS.GAS_PER_TX);
  assert.ok(KEEPER_LIMITS.GAS_PER_RUN >= KEEPER_LIMITS.GAS_PER_TX);
});

test("routeWith is detected from the harvest bytecode", () => {
  assert.equal(codeHasSelector("0x6080abcd1234ef", "0xabcd1234"), true);
  assert.equal(codeHasSelector("0x6080", "0xabcd1234"), false);
  assert.equal(codeHasSelector(undefined, "0xabcd1234"), false);
});

test("the cron only routes launch-list pairs, estimates gas, and sends with the capped limit", () => {
  const route = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../app/api/cron/route-creator-fees/route.ts"), "utf8");
  assert.match(route, /launchPairsForChain/);
  assert.match(route, /not on the launch list/);
  assert.match(route, /estimateContractGas/);
  assert.match(route, /\.\.\.request, gas, nonce/);
  assert.match(route, /DEADLINE_MS/);
  assert.match(route, /GAS_PER_RUN/);
  assert.doesNotMatch(route, /for \(const c of past\.get\(token\)/, "no unbounded past-creator loop");
});
