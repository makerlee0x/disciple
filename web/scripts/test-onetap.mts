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

import { SESSION_POLICY_MODULE_ID, cachedSessionUsable } from "../lib/aa/oneTap";
test("policy version: defaults to v5 1.4.1", () => assert.equal(SESSION_POLICY_MODULE_ID, `disciple.session-policy.${process.env.NEXT_PUBLIC_SESSION_POLICY_VERSION || "1.4.1"}`));
test("cached session on an old policy (1.1.0) or without a policy is treated as OFF ⇒ reinstall", () => {
  const NEW = "0x0399d58C802CfEfE0A559Fe9bBC147Ad92212bE2" as const, OLD = "0x476a7ed0775f6c7720c9157e4dade639424218cc" as const;
  const now = 1_800_000_000_000;
  const s = { account: A, entityId: 7, key: ("0x" + "1".repeat(64)) as `0x${string}`, validUntil: now / 1000 + 86400, maxSlippageBps: 500, policy: NEW };
  assert.equal(cachedSessionUsable(s, { account: A, policy: NEW.toLowerCase() as `0x${string}`, nowMs: now }), true);
  assert.equal(cachedSessionUsable({ ...s, policy: OLD }, { account: A, policy: NEW, nowMs: now }), false);
  assert.equal(cachedSessionUsable({ ...s, policy: undefined }, { account: A, policy: NEW, nowMs: now }), false);
  assert.equal(cachedSessionUsable(s, { account: REG, policy: NEW, nowMs: now }), false);
  assert.equal(cachedSessionUsable({ ...s, validUntil: now / 1000 + 30 }, { account: A, policy: NEW, nowMs: now }), false);
  assert.equal(cachedSessionUsable(s, { account: A, policy: "", nowMs: now }), false);
});

test("AUDIT #148 M-1: app session TTL = 24h - 10 min, matches the SDK clamp (never the full on-chain 24h max)", async () => {
  const { SESSION_TTL_MS, SESSION_TTL_SKEW_MARGIN_SEC } = await import("../lib/aa/policy");
  const sk = await import("@disciple/session-keys");
  assert.equal(SESSION_TTL_SKEW_MARGIN_SEC, 600);
  assert.equal(SESSION_TTL_MS / 1000, 86400 - 600);
  assert.equal(SESSION_TTL_MS / 1000, sk.SAFE_MAX_TTL_SEC);
  assert.equal(SESSION_TTL_SKEW_MARGIN_SEC, sk.SESSION_TTL_SKEW_MARGIN_SEC);
  assert.ok(SESSION_TTL_MS / 1000 < sk.MAX_TTL_SEC);
  // client clock 10 min ahead of the chain: the install still satisfies validUntil - block.timestamp <= 24h
  const chain = 1_800_000_000, client = chain + 600;
  const s = sk.buildCreateSession({ modules: { policy: A, singleSigner: A }, targets: { router: A, launchpad: A, trampWallManager: A },
    sessionSigner: A, caps: [{ token: A, cap: BigInt(1) }], ttlSec: SESSION_TTL_MS / 1000, now: client });
  assert.ok(s.validUntil - chain <= sk.MAX_TTL_SEC);
});

import { tradeSelectors, policyHasUsdgSwaps } from "../lib/aa/oneTap";
import { toFunctionSelector } from "viem";
import { discipleRouterAbi } from "../lib/abi";
test("1.4.1 session selectors: USDG<->pair swaps on, launchWithUsdg off (P_LAUNCH not in TRADE_PERMS)", () => {
  const sel = (name: string) => toFunctionSelector(discipleRouterAbi.find((f) => f.type === "function" && f.name === name) as never);
  assert.equal(sel("swapQuoteToUsdg"), "0xa4d85470");
  assert.equal(sel("swapUsdgToQuote"), "0xfa71c4e8");
  assert.equal(sel("launchWithUsdg"), "0x9c05e6c5");
  const v141 = tradeSelectors("1.4.1"), v140 = tradeSelectors("1.4.0"), v130 = tradeSelectors("1.3.0");
  assert.equal(v141.has("0xa4d85470") && v141.has("0xfa71c4e8"), true);
  assert.equal(v140.has("0xa4d85470") || v140.has("0xfa71c4e8") || v130.has("0xfa71c4e8"), false, "swaps are 1.4.1-only");
  assert.equal(v141.has("0x9c05e6c5"), false, "launchWithUsdg needs P_LAUNCH ⇒ owner signer");
  assert.equal(policyHasUsdgSwaps("1.4.0"), false);
  assert.equal(policyHasUsdgSwaps("1.4.1"), true);
});
test("router-only selectors are session-eligible only on the session's router", () => {
  const R = "0x688160633b22012717661545df6299d3d3174ad2" as const, X = "0x00000000000000000000000000000000000000aa" as const;
  const swap = encodeFunctionData({ abi: discipleRouterAbi, functionName: "swapUsdgToQuote", args: [X, BigInt(1), BigInt(1), X, BigInt(1)] });
  const launch = encodeFunctionData({ abi: discipleRouterAbi, functionName: "launchWithUsdg", args: [{ name: "a", ticker: "A", imageURI: "", description: "", socialsURI: "", quote: X, creatorTaxBps: BigInt(0), creatorBuyQuoteIn: BigInt(0), creatorBuyMinTokensOut: BigInt(0), deadline: BigInt(0) }, 0, BigInt(0), BigInt(0)] });
  const v = process.env.NEXT_PUBLIC_SESSION_POLICY_VERSION || "1.4.1";
  if (policyHasUsdgSwaps(v)) assert.equal(sessionEligible([{ to: R, data: swap }], { referral: false, router: R }), true);
  assert.equal(sessionEligible([{ to: X, data: swap }], { referral: false, router: R }), false);
  assert.equal(sessionEligible([{ to: R, data: launch }], { referral: false, router: R }), false);
});
