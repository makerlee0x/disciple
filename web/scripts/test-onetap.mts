// Unit tests for lib/aa/oneTap.ts (permissions, session-key eligibility, expiry label).  pnpm test:onetap
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi } from "viem";
import { P_REFERRAL, TRY_ATTRIBUTE, fmtSessionExpiry, sessionEligible, sessionPermissions } from "../lib/aa/oneTap";

const TRADE = BigInt(639); // SDK TRADE_PERMS
const REG = "0x633be77ee01aafb35297950d88168ca052e1f9ac" as const;
const A = "0x1111111111111111111111111111111111111111" as const;
const abi = parseAbi(["function approve(address,uint256)", "function tryAttribute(address,address)", "function transfer(address,uint256)", "function mint(address,uint256)"]);

test("P_REFERRAL = 1<<10, only added when referral attribution is on", () => {
  assert.equal(P_REFERRAL, BigInt(1024));
  assert.equal(sessionPermissions(TRADE, false), TRADE);
  assert.equal(sessionPermissions(TRADE, true), TRADE | BigInt(1024));
});
test("eligibility: trades yes; transfer/mint/ETH no; tryAttribute only with flag + registry", () => {
  const approve = { to: A, data: encodeFunctionData({ abi, functionName: "approve", args: [A, BigInt(1)] }) };
  const attr = { to: REG as `0x${string}`, data: encodeFunctionData({ abi, functionName: "tryAttribute", args: [A, A] }) };
  assert.equal(attr.data.slice(0, 10), TRY_ATTRIBUTE);
  assert.equal(sessionEligible([approve], { referral: false }), true);
  assert.equal(sessionEligible([{ to: A, data: encodeFunctionData({ abi, functionName: "transfer", args: [A, BigInt(1)] }) }], { referral: true, registry: REG }), false);
  assert.equal(sessionEligible([{ to: A, data: encodeFunctionData({ abi, functionName: "mint", args: [A, BigInt(1)] }) }], { referral: false }), false);
  assert.equal(sessionEligible([{ ...approve, value: BigInt(1) }], { referral: false }), false);
  assert.equal(sessionEligible([attr, approve], { referral: false, registry: REG }), false);
  assert.equal(sessionEligible([attr, approve], { referral: true, registry: REG }), true);
  assert.equal(sessionEligible([{ ...attr, to: A }], { referral: true, registry: REG }), false);
  assert.equal(sessionEligible([], { referral: true }), false);
});
test("expiry label: 24h session shows ~24h left and the NEXT day's date (regression: looked like 'until now')", () => {
  const now = Date.UTC(2026, 9, 16, 19, 43, 15); // Fri 2:43:15 PM CT
  const validUntil = now / 1000 + 86400;          // seconds, as stored on-chain
  const s = fmtSessionExpiry(validUntil, now, "en-US", "America/Chicago");
  assert.match(s, /^24h left \(until Sat, Oct 17/);
  assert.match(s, /2:43 PM\)$/);
});
test("expiry label: partial hours, minutes, expired", () => {
  const now = 1_800_000_000_000;
  assert.match(fmtSessionExpiry(now / 1000 + 5400, now, "en-US", "UTC"), /^1h 30m left/);
  assert.match(fmtSessionExpiry(now / 1000 + 300, now, "en-US", "UTC"), /^5m left/);
  assert.equal(fmtSessionExpiry(now / 1000 - 1, now), "expired");
  // a ms value passed by mistake would read ~55,000 years ahead — guard by making sure seconds round-trip sanely
  assert.doesNotMatch(fmtSessionExpiry(now / 1000 + 86400, now, "en-US", "UTC"), /\d{5,}h/);
});
