// /create: one click = one launch (in-flight guard) + the real, plain launch error. npm run test:launch-guard
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LAUNCH_FAILED_REASON, LAUNCH_PENDING_MSG, launchErrorMessage } from "../lib/launchError";
import { LAUNCH_FAILED_MSG } from "../lib/launchImage";
import { CANCELLED_MSG } from "../lib/playerError";
import { NETWORK_MSG, PENDING_MSG, REJECTED_MSG } from "../lib/aa/relayOp";
import { ProtocolError } from "../lib/protocol-viem";

const JARGON = /on-?chain|relay|\btx\b|transaction|gas|paymaster|bundler|op id|userop|0x|HTTP|revert/i;
const quiet = <T,>(f: () => T): T => { const w = console.warn; console.warn = () => {}; try { return f(); } finally { console.warn = w; } };
const msg = (e: unknown) => quiet(() => launchErrorMessage(e));

test("cancelled in the wallet ⇒ Cancelled.", () => {
  assert.equal(msg(new Error("User rejected the request.")), CANCELLED_MSG);
});
test("still confirming ⇒ launch pending line (no invite to click again)", () => {
  assert.equal(msg(new ProtocolError("Timeout", PENDING_MSG)), LAUNCH_PENDING_MSG);
});
test("connection failure ⇒ the plain network line", () => {
  const e = Object.assign(new Error("HTTP request failed."), { name: "HttpRequestError" });
  assert.equal(msg(e), NETWORK_MSG);
});
test("specific plain copy passes through (not enough cash, wallet cap, First BOOST too big)", () => {
  for (const t of ["Not enough cash for the First BOOST: need $5.00, have $1.00.", "Wallet cap reached: one wallet can hold at most 7% before orbit."])
    assert.equal(msg(new ProtocolError("InsufficientBalance", t)), t);
});
test("generic failure ⇒ a short plain reason, else the old fallback; never the bare generic line", () => {
  assert.equal(msg(new ProtocolError("Estimate", REJECTED_MSG)), LAUNCH_FAILED_REASON("it failed the final check"));
  assert.equal(msg(new ProtocolError("Reverted", "UserOperation reverted 0xdeadbeef")), LAUNCH_FAILED_REASON("it was refused at the last step"));
  assert.equal(msg(new ProtocolError("Bundler", REJECTED_MSG)), LAUNCH_FAILED_REASON("the launch service is busy"));
  assert.equal(msg(new Error("eth_sendUserOperation: AA23 reverted")), LAUNCH_FAILED_MSG);
  for (const s of [LAUNCH_PENDING_MSG, LAUNCH_FAILED_REASON("it failed the final check"), LAUNCH_FAILED_REASON("it was refused at the last step"), LAUNCH_FAILED_REASON("the launch service is busy")])
    assert.doesNotMatch(s, JARGON, s);
});
test("create page: ref guard (sync), button disabled + pending label while launching", () => {
  const src = readFileSync(new URL("../app/create/page.tsx", import.meta.url), "utf8");
  assert.match(src, /if \(launchingRef\.current \|\| launchedRef\.current\) return;\n\s*launchingRef\.current = true;/);
  assert.match(src, /disabled=\{!file \|\| launching\}/);
  assert.match(src, /"Launching…"/);
  assert.match(src, /setMsg\(launchErrorMessage\(err\)\)/);
});
