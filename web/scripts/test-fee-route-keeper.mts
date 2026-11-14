/** lib/feeRouteKeeper: which coins the route-creator-fees cron sends, and which simulated reverts are "nothing yet". */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_ROUTES_PER_RUN, isQuietRouteError, rotate, routedTokensFromLogs } from "../lib/feeRouteKeeper";

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
  assert.ok(MAX_ROUTES_PER_RUN > 0 && MAX_ROUTES_PER_RUN <= 50);
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
  assert.match(route, /"routeWith"/);
});
