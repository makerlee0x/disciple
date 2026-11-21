/**
 * Money flow: Claim all on the Rewards panel (lib/claims/rewards claimAllCalls). Who signs: the player, one gasless
 * action (a Permit2 fee permit when there is a fee). Who pays gas: the relayer, fee in USDG (free when the wallet can't cover it). Where the money goes:
 * the contract pays the creator / referrer / holder, never the relayer. This pins that every call Claim all builds is
 * one the gasless relay accepts as a public claim (kind anonClaim), on the right contract, paying the right wallet.
 */
import { describe, expect, it } from "vitest";
import { decodeFunctionData, parseAbi, type Address } from "viem";
import { deployment } from "../lib/chains";
import { claimAllCalls, selectClaimCalls, MAX_CLAIM_CALLS } from "../lib/claims/rewards";
import { creatorClaimCalls } from "../lib/claims/creatorFees";
import { checkGaslessActionRequest, isRelayableCall, parseGaslessActionRequest } from "../lib/trade/gaslessAction";
import type { Caps } from "../lib/claims/capabilities";
import type { Asset } from "../lib/claims/common";

const A = (n: number) => (`0x${n.toString(16).padStart(40, "0")}`) as Address;
const ME = A(7), TOKEN = A(20), TOKEN2 = A(21), PRIV = A(22), LAUNCHER = A(30), USDG = A(6), WETH = A(9), VAULT = A(40), HOOK = A(41), PAST = A(42);
const ZERO = BigInt(0), E6 = BigInt(1_000_000);
const ALL: Caps = { creatorFees: true, referrerFees: true, creatorTokenFees: true, crew: true, referralGate: true, anonClaims: true };
const asset = (address: Address, decimals: number, usd: number | null) => ({ address, symbol: "X", decimals, usd }) as Asset;
const rocket = (token: Address, claimable: bigint, tok: bigint, extra: Record<string, unknown> = {}) => ({
  token, claimable, tokenSide: { asset: asset(token, 18, 0.01), claimable: tok, claimed: ZERO }, anon: false, ...extra,
}) as never;
const d = deployment();
const abi = parseAbi([
  "function claimCreatorFees(address token)",
  "function claimCreatorTokenFees(address token)",
  "function claimReferrerFeesFor_2143(address referrer, address quote)",
  "function claimReferrerFeesFor(address referrer, address quote, address[] settleTokens)",
  "function claimFor(address token, address holder)",
  "function sweepPastCreatorFees_1311(address token, address pastCreator)",
]);
const dec = (c: { to: Address; data: `0x${string}` }) => {
  const x = decodeFunctionData({ abi, data: c.data });
  return [c.to.toLowerCase(), x.functionName, ...(x.args as readonly unknown[]).map((a) => String(a).toLowerCase())];
};

describe("Claim all: one list, every type, nothing that pays zero", () => {
  const calls = claimAllCalls({
    referral: [{ asset: asset(USDG, 6, 1), claimable: E6 } as never, { asset: asset(WETH, 18, 2500), claimable: ZERO } as never],
    creator: [rocket(TOKEN, BigInt(5), BigInt(7)), rocket(TOKEN2, ZERO, ZERO), rocket(PRIV, BigInt(3), ZERO, { anon: true, launcher: LAUNCHER })],
    crew: [{ token: TOKEN, pending: BigInt(9) }, { token: TOKEN2, pending: ZERO }],
  }, ALL, ME);

  it("referral (For me), creator quote + token side, crew (For me); zeros and private rockets left out", () => {
    expect(calls.map((c) => c.kind)).toEqual(["referral", "creator", "creator", "crew"]);
    expect(calls.map(dec)).toEqual([
      [d.feeRouter.toLowerCase(), "claimReferrerFeesFor_2143", ME, USDG],
      [d.feeRouter.toLowerCase(), "claimCreatorFees", TOKEN],
      [d.feeRouter.toLowerCase(), "claimCreatorTokenFees", TOKEN],
      [d.launchpad.toLowerCase(), "claimFor", TOKEN, ME],
    ]);
  });

  it("every call is a public claim the gasless relay accepts; free passes, a USDG fee needs its signed permit", () => {
    for (const c of calls) expect(isRelayableCall("anonClaim", { to: c.to, data: c.data }), c.kind).toBe(true);
    const req = (fee: bigint) => parseGaslessActionRequest({ kind: "anonClaim", signer: ME, fee, feeTo: A(99), calls: calls.map(({ to, data }) => ({ to, data })) });
    const ctx = { usdg: d.usdg, usdgDecimals: 6, nowSec: 1_000, feeTo: A(99) };
    expect(() => checkGaslessActionRequest(req(ZERO), ctx)).not.toThrow();
    expect(() => checkGaslessActionRequest(req(BigInt(1200)), ctx)).toThrow(/fee permit required/);
  });

  it("the relayer can't be swapped in as the payee: a referral claim for someone else is a different call", () => {
    const theirs = claimAllCalls({ referral: [{ asset: asset(USDG, 6, 1), claimable: E6 } as never], creator: [], crew: [] }, ALL, A(8));
    expect(dec(theirs[0])[2]).toBe(A(8));
    expect(theirs[0].data).not.toBe(calls[0].data);
  });
});

describe("creator claims on lp-accrue curves, the pool hook, and a creator handover", () => {
  it("vault part goes to the coin's CurveFeeVault, hook part to the coin's hook, past creators swept first", () => {
    const row = rocket(TOKEN, BigInt(10), ZERO, {
      vault: VAULT, vaultClaimable: BigInt(4), baseClaimable: BigInt(3), hook: { hook: HOOK, quote: BigInt(3), token: ZERO },
      past: [{ creator: PAST, base: BigInt(1), tok: ZERO, vault: BigInt(1) }],
    });
    const out = creatorClaimCalls([row], ALL, ME).map(dec);
    expect(out).toEqual([
      [d.feeRouter.toLowerCase(), "sweepPastCreatorFees_1311", TOKEN, PAST],
      [VAULT, "sweepPastCreatorFees_1311", TOKEN, PAST],
      [d.feeRouter.toLowerCase(), "claimCreatorFees", TOKEN],
      [VAULT, "claimCreatorFees", TOKEN],
      [HOOK, "claimCreatorFees", TOKEN],
    ]);
    // the coin's own vault and hook are read on-chain and passed in as known contracts
    const known = new Set([VAULT, HOOK].map((x) => x.toLowerCase()));
    for (const c of creatorClaimCalls([row], ALL, ME)) expect(isRelayableCall("anonClaim", c, known), dec(c).join(" ")).toBe(true);
    // without the coin's own vault/hook read on-chain, those two are refused (no relaying to an unknown contract)
    expect(isRelayableCall("anonClaim", creatorClaimCalls([row], ALL, ME)[4])).toBe(false);
  });

  it("a deployment without a fee type leaves those calls out", () => {
    const none: Caps = { creatorFees: false, referrerFees: false, creatorTokenFees: false, crew: false, referralGate: false, anonClaims: false };
    const input = { referral: [{ asset: asset(USDG, 6, 1), claimable: E6 } as never], creator: [rocket(TOKEN, BigInt(5), BigInt(7))], crew: [{ token: TOKEN, pending: BigInt(9) }] };
    expect(claimAllCalls(input, none, ME)).toEqual([]);
  });
});

describe("selectClaimCalls: one bad claim can't sink the rest", () => {
  it("drops calls whose dry run failed and caps the list, counting what's left for next time", () => {
    const many = Array.from({ length: MAX_CLAIM_CALLS + 3 }, (_, i) => ({ to: A(i + 1), data: "0x" as const }));
    const ok = many.map((_, i) => i !== 1);
    const r = selectClaimCalls(many, ok);
    expect(r.send).toHaveLength(MAX_CLAIM_CALLS);
    expect(r.send.some((c) => c.to === A(2))).toBe(false);
    expect(r.skipped).toBe(1);
    expect(r.deferred).toBe(2);
  });
});
