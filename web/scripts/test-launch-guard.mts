// Quick Launch (/create): one click = one launch (in-flight guard, rebuilt from #231) + the real, plain launch error.
// Run: npm run test:launch-guard
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LAUNCHED_LABEL, LAUNCHING_LABEL, LAUNCH_FAILED_REASON, LAUNCH_PENDING_MSG, LAUNCH_REASON, launchErrorMessage, launchStillConfirming,
} from "../lib/launchError";
import * as launchImage from "../lib/launchImage";
import { CANCELLED_MSG } from "../lib/playerError";
import { PENDING_MSG, REJECTED_MSG } from "../lib/aa/relayOp";
import { ProtocolError } from "../lib/protocol-viem";

const JARGON = /on-?chain|relay|\btx\b|transaction|gas|paymaster|bundler|op id|userop|0x|HTTP|revert/i;
const quiet = <T,>(f: () => T): T => { const w = console.warn; console.warn = () => {}; try { return f(); } finally { console.warn = w; } };
const msg = (e: unknown) => quiet(() => launchErrorMessage(e));
const page = readFileSync(new URL("../app/create/page.tsx", import.meta.url), "utf8");

test("the four button lines are exactly the approved-for-review wording", () => {
  assert.equal(LAUNCHING_LABEL, "Launching…");
  assert.equal(LAUNCHED_LABEL, "Launched");
  assert.equal(LAUNCH_PENDING_MSG, "Your launch is still confirming. Give it a minute before trying again.");
  assert.equal(LAUNCH_FAILED_REASON("reason"), "Launch didn't go through (reason). Try again.");
});
test("the old 'Nothing was spent' failure line and the old 'Launch Rocket' label are gone", () => {
  assert.equal("LAUNCH_FAILED_MSG" in launchImage, false);
  assert.doesNotMatch(page, /Nothing was spent|LAUNCH_FAILED_MSG/);
  assert.doesNotMatch(page, /Launch Rocket/);
});
test("cancelled in the wallet ⇒ Cancelled.", () => {
  assert.equal(msg(new Error("User rejected the request.")), CANCELLED_MSG);
});
test("still confirming ⇒ launch pending line (no invite to click again)", () => {
  assert.equal(msg(new ProtocolError("Timeout", PENDING_MSG)), LAUNCH_PENDING_MSG);
});
test("connection failure before sending ⇒ failure line with a plain reason", () => {
  const e = Object.assign(new Error("HTTP request failed."), { name: "HttpRequestError" });
  assert.equal(msg(e), LAUNCH_FAILED_REASON(LAUNCH_REASON.network));
});
test("specific plain copy passes through (not enough cash, wallet cap)", () => {
  for (const t of ["Not enough cash for the First BOOST: need $5.00, have $1.00.", "Wallet cap reached: one wallet can hold at most 7% before orbit."])
    assert.equal(msg(new ProtocolError("InsufficientBalance", t)), t);
});
test("generic failure ⇒ failure line with a short plain reason, never the old line", () => {
  assert.equal(msg(new ProtocolError("Estimate", REJECTED_MSG)), LAUNCH_FAILED_REASON("it failed the final check"));
  assert.equal(msg(new ProtocolError("Reverted", "UserOperation reverted 0xdeadbeef")), LAUNCH_FAILED_REASON("it was refused at the last step"));
  assert.equal(msg(new ProtocolError("Bundler", REJECTED_MSG)), LAUNCH_FAILED_REASON("the launch service is busy"));
  assert.equal(msg(new Error("eth_sendUserOperation: AA23 reverted")), LAUNCH_FAILED_REASON("something unexpected went wrong"));
  for (const s of [LAUNCHING_LABEL, LAUNCHED_LABEL, LAUNCH_PENDING_MSG, ...Object.values(LAUNCH_REASON).map(LAUNCH_FAILED_REASON)])
    assert.doesNotMatch(s, JARGON, s);
});
test("still confirming keeps the lock; only a definite failure releases it", () => {
  assert.equal(launchStillConfirming(new ProtocolError("Timeout", PENDING_MSG)), true);
  assert.equal(launchStillConfirming(Object.assign(new Error("receipt timeout"), { code: "Timeout", extra: { unclear: true } })), true);
  assert.equal(launchStillConfirming(new Error(PENDING_MSG)), true);
  for (const e of [new Error("User rejected the request."), new ProtocolError("Reverted", "reverted"), new ProtocolError("Estimate", REJECTED_MSG),
    new ProtocolError("Bundler", REJECTED_MSG), new ProtocolError("InsufficientBalance", "Not enough cash."), Object.assign(new Error("HTTP request failed."), { name: "HttpRequestError" })])
    assert.equal(launchStillConfirming(e), false, e.message);
});
test("Quick Launch page wiring: sync ref guard, lock kept after success / while confirming, button disabled + labels", () => {
  assert.match(page, /if \(launchingRef\.current \|\| keepLockedRef\.current\) return;\n\s*launchingRef\.current = true;/);
  assert.match(page, /finally \{\n\s*if \(!keepLockedRef\.current\) \{ launchingRef\.current = false; setLaunching\(false\); \}/);
  assert.match(page, /const res = await client\.launchCoin\([\s\S]*?\}\);\n\s*keepLockedRef\.current = true;/);
  assert.match(page, /if \(launchStillConfirming\(err\)\) keepLockedRef\.current = true;/);
  assert.match(page, /setMsg\(launchErrorMessage\(err\)\)/);
  assert.match(page, /disabled=\{launching\}\n\s*aria-busy=\{launching\}/);
  assert.match(page, /\{launching \? \(launchDone \? LAUNCHED_LABEL : LAUNCHING_LABEL\) : "Light the engines"\}/);
});
