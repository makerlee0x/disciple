// Unit tests for the combined Rewards section (pure, no RPC): type mapping from fee routes, dollar sums, the
// this-week window, the history feed, and the one-op claim-everything call list.   pnpm test:rewards
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeFunctionData, parseAbi, type Address } from "viem";
import {
  claimAllCalls, feeRouteEarnings, groupHistory, MAX_CLAIM_CALLS, priceEarnings, REWARD_LABEL, selectClaimCalls, sendClaimAll, summarize, usdOf, WEEK_SEC,
  type FeeRouteLog, type Prices,
} from "../lib/claims/rewards";
import { anonLauncherAbi, feeRouterAbi, launchpadAbi } from "../lib/abi";
import { deployment } from "../lib/chains";
import { encodeCalls } from "../lib/aa/core";
import { accountCalls } from "../lib/aa/gasPolicy";
import { checkCalls, PolicyError, type PolicyCfg } from "../lib/aa/policy";
import type { Caps } from "../lib/claims/capabilities";
import type { Asset } from "../lib/claims/common";

const A = (n: number) => (`0x${n.toString(16).padStart(40, "0")}`) as Address;
const ME = A(7), OTHER = A(8), TOKEN = A(20), TOKEN2 = A(21), PRIV = A(22), LAUNCHER = A(30), USDG = A(6), WETH = A(9);
const E18 = BigInt(10) ** BigInt(18), E6 = BigInt(10) ** BigInt(6);
const ZERO = BigInt(0);
const route = (o: Partial<FeeRouteLog>): FeeRouteLog => ({
  token: TOKEN, feeToken: USDG, creator: OTHER, creatorShare: ZERO, creatorTaxAmount: ZERO,
  referralPayee: A(0), referralShare: ZERO, kolPayee: A(0), kolShare: ZERO, ...o,
} as FeeRouteLog);
const ALL: Caps = { creatorFees: true, referrerFees: true, creatorTokenFees: true, crew: true, referralGate: true, anonClaims: true };
const asset = (address: Address, decimals: number, usd: number | null): Asset => ({ address, symbol: "X", decimals, usd } as Asset);

test("labels: one word per type", () => {
  assert.deepEqual(REWARD_LABEL, { referral: "Referral", creator: "Creator", crew: "Crew" });
});

test("feeRouteEarnings: referral + KOL share paid to me count as Referral", () => {
  assert.deepEqual(feeRouteEarnings(route({ referralPayee: ME, referralShare: BigInt(5) }), ME), [{ kind: "referral", raw: BigInt(5) }]);
  assert.deepEqual(feeRouteEarnings(route({ referralPayee: ME, referralShare: BigInt(5), kolPayee: ME, kolShare: BigInt(3) }), ME), [{ kind: "referral", raw: BigInt(8) }]);
  assert.deepEqual(feeRouteEarnings(route({ kolPayee: ME, kolShare: BigInt(3) }), ME), [{ kind: "referral", raw: BigInt(3) }]);
  // someone else's referral: nothing
  assert.deepEqual(feeRouteEarnings(route({ referralPayee: OTHER, referralShare: BigInt(5) }), ME), []);
  // address case doesn't matter
  assert.equal(feeRouteEarnings(route({ referralPayee: ME.toUpperCase().replace("0X", "0x") as Address, referralShare: BigInt(1) }), ME).length, 1);
});

test("feeRouteEarnings: creator share + creator tax count as Creator (wallet and private rockets)", () => {
  assert.deepEqual(feeRouteEarnings(route({ creator: ME, creatorShare: BigInt(10), creatorTaxAmount: BigInt(2) }), ME), [{ kind: "creator", raw: BigInt(12) }]);
  assert.deepEqual(feeRouteEarnings(route({ creator: OTHER, creatorShare: BigInt(10) }), ME), []);
  // private rocket: creator on the route is the launcher; it's mine when the token is in myPrivate
  const mine = new Map([[PRIV.toLowerCase(), LAUNCHER.toLowerCase()]]);
  assert.deepEqual(feeRouteEarnings(route({ token: PRIV, creator: LAUNCHER, creatorShare: BigInt(4) }), ME, mine), [{ kind: "creator", raw: BigInt(4) }]);
  assert.deepEqual(feeRouteEarnings(route({ token: TOKEN2, creator: LAUNCHER, creatorShare: BigInt(4) }), ME, mine), []);
  // both at once (I referred my own rocket's trader)
  const both = feeRouteEarnings(route({ creator: ME, creatorShare: BigInt(1), referralPayee: ME, referralShare: BigInt(2) }), ME);
  assert.deepEqual(both.map((x) => x.kind).sort(), ["creator", "referral"]);
});

test("usdOf: decimals + price, null when unpriced", () => {
  const p: Prices = new Map([[USDG.toLowerCase(), { usd: 1, decimals: 6 }], [WETH.toLowerCase(), { usd: 2500, decimals: 18 }], [TOKEN.toLowerCase(), { usd: null, decimals: 18 }]]);
  assert.equal(usdOf(BigInt(1_500_000), USDG, p), 1.5);
  assert.equal(usdOf(E18 / BigInt(1000), WETH, p), 2.5);
  assert.equal(usdOf(E18, TOKEN, p), null);
  assert.equal(usdOf(E18, A(99), p), null);
  // large 18-dec amount keeps precision
  assert.ok(Math.abs((usdOf(BigInt("123456789123456789123456"), WETH, p) ?? 0) - 123456.789123456789 * 2500) < 1e-3);
});

test("priceEarnings: drops unpriced or undated rows", () => {
  const p: Prices = new Map([[USDG.toLowerCase(), { usd: 1, decimals: 6 }]]);
  const { entries, dropped } = priceEarnings([
    { kind: "referral", asset: USDG, raw: BigInt(2) * E6, block: BigInt(1), ts: 100 },
    { kind: "creator", asset: TOKEN, raw: E18, block: BigInt(2), ts: 100 },
    { kind: "crew", asset: USDG, raw: E6, block: BigInt(3) },
  ], p);
  assert.deepEqual(entries, [{ kind: "referral", ts: 100, usd: 2 }]);
  assert.equal(dropped, 2);
});

test("summarize: total = claimable + claimed, split by type, unpriced left out", () => {
  const now = 1_800_000_000;
  const s = summarize(
    [{ kind: "referral", usd: 10 }, { kind: "creator", usd: 5 }, { kind: "crew", usd: null }, { kind: "crew", usd: 0 }],
    [{ kind: "referral", usd: 20 }, { kind: "crew", usd: 1.25 }],
    [], now,
  );
  assert.equal(s.totalUsd, 36.25);
  assert.equal(s.claimableUsd, 15);
  assert.deepEqual(s.byKind, { referral: { earnedUsd: 30, claimableUsd: 10 }, creator: { earnedUsd: 5, claimableUsd: 5 }, crew: { earnedUsd: 1.25, claimableUsd: 0 } });
});

test("summarize: this week = history in the last 7 days only", () => {
  const now = 1_800_000_000;
  const s = summarize([], [], [
    { kind: "referral", ts: now - 60, usd: 1 },
    { kind: "creator", ts: now - WEEK_SEC + 1, usd: 2 },
    { kind: "crew", ts: now - WEEK_SEC, usd: 4 }, // exactly 7 days ago: out
    { kind: "referral", ts: now - 30 * 86400, usd: 8 },
    { kind: "referral", ts: now + 3600, usd: 16 }, // clock skew far ahead: out
  ], now);
  assert.equal(s.weekUsd, 3);
});

test("groupHistory: one row per type per day, newest first, summed", () => {
  const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10); // fixed zone for the test
  const t = Date.UTC(2026, 9, 24, 12) / 1000;
  const rows = groupHistory([
    { kind: "referral", ts: t - 3600, usd: 1 }, { kind: "referral", ts: t, usd: 2 },
    { kind: "creator", ts: t - 600, usd: 5 }, { kind: "referral", ts: t - 86400, usd: 4 }, { kind: "crew", ts: t - 2 * 86400, usd: 0 },
  ], day);
  assert.deepEqual(rows.map((r) => [r.kind, r.day, r.usd, r.count]), [
    ["referral", "2026-10-24", 3, 2], ["creator", "2026-10-24", 5, 1], ["referral", "2026-10-23", 4, 1],
  ]);
  assert.equal(rows[0].from, t - 3600);
  assert.equal(rows[0].to, t);
  assert.equal(groupHistory(Array.from({ length: 60 }, (_, i) => ({ kind: "crew" as const, ts: t - i * 86400, usd: 1 })), day).length, 40);
});

const rocket = (token: Address, claimable: bigint, tok: bigint, extra: Record<string, unknown> = {}) => ({
  token, claimable, tokenSide: { asset: asset(token, 18, 0.01), claimable: tok, claimed: ZERO }, anon: false, launcher: undefined, stealth: undefined, ...extra,
}) as never;

test("claimAllCalls: every type in one list, zeros skipped, tagged by type", () => {
  const fr = deployment().feeRouter;
  const calls = claimAllCalls({
    referral: [{ asset: asset(USDG, 6, 1), claimable: E6 } as never, { asset: asset(WETH, 18, 2500), claimable: ZERO } as never],
    creator: [rocket(TOKEN, BigInt(5), BigInt(7)), rocket(TOKEN2, ZERO, ZERO), rocket(PRIV, BigInt(3), ZERO, { anon: true, launcher: LAUNCHER })],
    crew: [{ token: TOKEN, pending: BigInt(9) }, { token: TOKEN2, pending: ZERO }],
  }, ALL, ME);
  assert.deepEqual(calls.map((c) => c.kind), ["referral", "creator", "creator", "creator", "crew"]);
  const dec = calls.map((c) => {
    for (const abi of [feeRouterAbi, anonLauncherAbi, launchpadAbi] as const) {
      try { const d = decodeFunctionData({ abi, data: c.data }); return [c.to.toLowerCase(), d.functionName, ...(d.args as unknown[]).map((a) => (Array.isArray(a) ? a.map(String).join(",") : String(a)).toLowerCase())]; } catch { /* next */ }
    }
    return ["?"];
  });
  assert.deepEqual(dec, [
    [fr.toLowerCase(), "claimReferrerFees", USDG.toLowerCase()],
    [fr.toLowerCase(), "claimCreatorFees", TOKEN.toLowerCase()],
    [fr.toLowerCase(), "claimCreatorTokenFees", TOKEN.toLowerCase()],
    [LAUNCHER.toLowerCase(), "claimMany", PRIV.toLowerCase(), ME.toLowerCase()],
    [deployment().launchpad.toLowerCase(), "claim", TOKEN.toLowerCase()],
  ]);
});

test("claimAllCalls: types the deployment doesn't have are left out", () => {
  const input = { referral: [{ asset: asset(USDG, 6, 1), claimable: E6 } as never], creator: [rocket(TOKEN, BigInt(5), BigInt(7))], crew: [{ token: TOKEN, pending: BigInt(9) }] };
  const none: Caps = { creatorFees: false, referrerFees: false, creatorTokenFees: false, crew: false, referralGate: false, anonClaims: false };
  assert.deepEqual(claimAllCalls(input, none, ME), []);
  assert.deepEqual(claimAllCalls(input, { ...none, crew: true }, ME).map((c) => c.kind), ["crew"]);
  // stealth-owned private rockets are not in the plain list (they need the stealth signature first)
  assert.deepEqual(claimAllCalls({ referral: [], crew: [], creator: [rocket(PRIV, BigInt(3), ZERO, { anon: true, launcher: LAUNCHER, stealth: { owner: OTHER } })] }, ALL, ME), []);
});

test("selectClaimCalls: failed dry runs dropped, list capped", () => {
  const c = (n: number) => ({ to: A(n), data: "0x" as const });
  const r = selectClaimCalls([c(1), c(2), c(3)], [true, false, true]);
  assert.deepEqual(r.send.map((x) => x.to), [A(1), A(3)]);
  assert.equal(r.skipped, 1);
  assert.equal(r.deferred, 0);
  const many = Array.from({ length: MAX_CLAIM_CALLS + 5 }, (_, i) => c(i + 1));
  const capped = selectClaimCalls(many, many.map(() => true));
  assert.equal(capped.send.length, MAX_CLAIM_CALLS);
  assert.equal(capped.deferred, 5);
});

test("sendClaimAll: one wallet call for the whole list (one op), refuses an empty list", async () => {
  const seen: unknown[][] = [];
  const calls = [{ to: A(1), data: "0x01" as const, kind: "referral" as const }, { to: A(2), data: "0x02" as const, kind: "crew" as const }];
  const r = await sendClaimAll(calls, async (cs) => { seen.push(cs); return { txHash: "0xabc" }; });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], [{ to: A(1), data: "0x01" }, { to: A(2), data: "0x02" }]);
  assert.deepEqual(r, { txHash: "0xabc" });
  await assert.rejects(sendClaimAll([], async () => ({})), /Nothing to claim yet\./);
});

test("one op: the claim list encodes into a single executeBatch with every call in order", () => {
  const calls = claimAllCalls({ referral: [{ asset: asset(USDG, 6, 1), claimable: E6 } as never], creator: [rocket(TOKEN, BigInt(5), ZERO)], crew: [{ token: TOKEN, pending: BigInt(9) }] }, ALL, ME);
  const d = decodeFunctionData({ abi: parseAbi(["function executeBatch(address[] dest, uint256[] value, bytes[] func)"]), data: encodeCalls(calls) });
  assert.equal(d.functionName, "executeBatch");
  const [to, , data] = d.args as readonly [readonly Address[], readonly bigint[], readonly `0x${string}`[]];
  assert.deepEqual(to.map((x, i) => [x.toLowerCase(), data[i].toLowerCase()]), calls.map((c) => [c.to.toLowerCase(), c.data.toLowerCase()]));
  // the relayer's gas policy reads the same op as one batch of these calls
  const mav2 = encodeFunctionData({ abi: parseAbi(["function executeBatch((address target, uint256 value, bytes data)[] calls)"]), functionName: "executeBatch", args: [calls.map((c) => ({ target: c.to, value: BigInt(0), data: c.data }))] });
  assert.equal(accountCalls(mav2)?.length, calls.length);
});

test("session policy: referral, creator and crew claims stay one-tap; a private-rocket claim moves the op to an owner signature", async () => {
  const d = deployment();
  const cfg: PolicyCfg = { launchpad: d.launchpad, router: A(2), trampWallManager: A(3), mintable: [], defaultLimit: BigInt(10) ** BigInt(30), feeRouter: d.feeRouter, usdgDepositNotifier: A(5), usdg: USDG };
  const st = () => ({ expiresAt: Date.now() + 60_000, spent: {} });
  const pcNoCurve = { readContract: async () => { throw new Error("not a curve"); } } as never;
  const fees = claimAllCalls({ referral: [{ asset: asset(USDG, 6, 1), claimable: E6 } as never], creator: [rocket(TOKEN, BigInt(5), BigInt(1))], crew: [] }, ALL, ME);
  await checkCalls(pcNoCurve, cfg, st(), fees, ME);
  const crew = claimAllCalls({ referral: [], creator: [], crew: [{ token: TOKEN, pending: BigInt(9) }] }, ALL, ME);
  await checkCalls(pcNoCurve, cfg, st(), [...fees, ...crew], ME);
  const priv = claimAllCalls({ referral: [], crew: [], creator: [rocket(PRIV, BigInt(3), ZERO, { anon: true, launcher: LAUNCHER })] }, ALL, ME);
  await assert.rejects(checkCalls(pcNoCurve, cfg, st(), [...fees, ...crew, ...priv], ME), PolicyError);
});

test("copy: Rewards strings are plain words, dollars only (static scan of ProfileClaims)", async () => {
  const { readFileSync } = await import("node:fs");
  const { JARGON } = await import("../lib/aa/relayOp");
  const src = readFileSync(new URL("../components/claims/ProfileClaims.tsx", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("const T = {"), src.indexOf("} as const;"));
  const strings = Array.from(block.matchAll(/:\s*"([^"]+)"/g), (m) => m[1]);
  assert.ok(strings.length >= 10);
  for (const s of strings) {
    assert.ok(!JARGON.test(s), `jargon: ${s}`);
    assert.ok(!/\b(ETH|gas|fees?|batch|wei)\b/i.test(s), `crypto/fee word: ${s}`);
  }
  // raw error text never reaches the player: errors go through claimErrorText
  assert.ok(!/\{(?:e|err)\.message\}/.test(src));
});
