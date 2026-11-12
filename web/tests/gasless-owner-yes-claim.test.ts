/** Owner-yes claim for normal rockets (docs/owner-yes-creator-claim.md): relay allowlist, signing, and fallbacks. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, recoverTypedDataAddress, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { anonLauncherAbi } from "../lib/abi";
import { ACTIVE_CHAIN, deployment } from "../lib/chains";
import { CLAIM_TYPES } from "../lib/anon";
import { checkGaslessActionRequest, isRelayableCall, partitionRelayableCalls, SEL, type ActionCall } from "../lib/trade/gaslessAction";
import {
  creatorClaimBySigAbi, creatorClaimDomain, MAX_OWNER_YES_TOKENS, ownerYesClaimCalls, ownerYesTokens, resetOwnerYesReady,
} from "../lib/claims/ownerYesClaim";

const me = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const helper = "0x00000000000000000000000000000000000000c1" as Address;
const tokA = "0x000000000000000000000000000000000000000a" as Address;
const tokB = "0x000000000000000000000000000000000000000b" as Address;
const tokC = "0x000000000000000000000000000000000000000c" as Address;
const NOW = 1_000_000;

const helperCall = (to: Address = me.address, at: Address = helper, tokens: Address[] = [tokA]): ActionCall => ({
  to: at,
  data: encodeFunctionData({ abi: creatorClaimBySigAbi, functionName: "claimCreatorFeesBySig",
    args: [{ owner: me.address, tokens, to, relayerFeeBps: 0n, deadline: BigInt(NOW + 120), sig: "0x11" as Hex }] }),
});
const selfClaim = (fn: "claimCreatorFees" | "claimCreatorTokenFees", token: Address, at: Address): ActionCall => ({
  to: at,
  data: encodeFunctionData({ abi: [{ type: "function", name: fn, stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }], outputs: [] }] as const, functionName: fn, args: [token] }),
});

/** Minimal PublicClient: FeeRouter.isClaimRouter(helper) and helper.nonces(owner). */
function fakePc(approved: boolean, nonce = 3n): PublicClient {
  return {
    readContract: async (a: { functionName: string }) => {
      if (a.functionName === "isClaimRouter") return approved;
      if (a.functionName === "nonces") return nonce;
      throw new Error("unexpected read " + a.functionName);
    },
  } as unknown as PublicClient;
}

const rows = [
  { token: tokA, claimable: 5n, tokenSide: { claimable: 0n } },
  { token: tokB, claimable: 0n, tokenSide: { claimable: 7n } },
  { token: tokC, claimable: 9n, tokenSide: null },
];

describe("owner-yes claim relay allowlist", () => {
  const d = deployment();
  const prev = d.creatorClaimHelper;
  beforeEach(() => { d.creatorClaimHelper = helper; resetOwnerYesReady(); });
  afterEach(() => { d.creatorClaimHelper = prev; resetOwnerYesReady(); });

  it("relays claimCreatorFeesBySig only at the configured helper", () => {
    expect(SEL.claimCreatorFeesBySig).toBe(helperCall().data.slice(0, 10));
    expect(isRelayableCall("anonClaim", helperCall())).toBe(true);
    expect(isRelayableCall("anonClaim", helperCall(me.address, "0x00000000000000000000000000000000000000c2"))).toBe(false);
    expect(isRelayableCall("trampPull", helperCall())).toBe(false);
    d.creatorClaimHelper = "0x0000000000000000000000000000000000000000";
    expect(isRelayableCall("anonClaim", helperCall())).toBe(false);
    d.creatorClaimHelper = undefined;
    expect(isRelayableCall("anonClaim", helperCall())).toBe(false);
  });

  it("the payout must be the signer's wallet, as for private claims", () => {
    const base = { kind: "anonClaim" as const, signer: me.address, fee: 0n, feeTo: "0x00000000000000000000000000000000000000ee" as Address };
    const o = { usdg: d.usdg, usdgDecimals: 6, nowSec: NOW, feeTo: base.feeTo };
    expect(() => checkGaslessActionRequest({ ...base, calls: [helperCall()] }, o)).not.toThrow();
    expect(() => checkGaslessActionRequest({ ...base, calls: [helperCall(other.address)] }, o)).toThrow(/payout must be the signer/);
  });

  it("drops a wallet rocket's own claim calls that the helper call already covers; keeps the rest blocked", () => {
    const fr = d.feeRouter, vault = "0x00000000000000000000000000000000000000bb" as Address;
    const calls = [
      selfClaim("claimCreatorFees", tokA, fr), selfClaim("claimCreatorFees", tokA, vault), selfClaim("claimCreatorTokenFees", tokA, fr),
      selfClaim("claimCreatorFees", tokC, fr), helperCall(),
    ];
    const { relayable, blocked } = partitionRelayableCalls("anonClaim", calls);
    expect(relayable).toEqual([helperCall()]);
    expect(blocked).toEqual([selfClaim("claimCreatorFees", tokC, fr)]);
    // without a helper call nothing is dropped (today's behavior)
    const plain = partitionRelayableCalls("anonClaim", calls.slice(0, 4));
    expect(plain.relayable).toHaveLength(0);
    expect(plain.blocked).toHaveLength(4);
  });

  it("private claims are unchanged next to the helper call", () => {
    const anon: ActionCall = { to: "0x00000000000000000000000000000000000000aa", data: encodeFunctionData({ abi: anonLauncherAbi, functionName: "claimManyBySig",
      args: [{ owner: me.address, tokens: [tokB], to: me.address, relayerFeeBps: 0n, deadline: BigInt(NOW + 120), sig: "0x11" as Hex }] }) };
    expect(partitionRelayableCalls("anonClaim", [anon, helperCall()]).relayable).toHaveLength(2);
  });
});

describe("owner-yes claim signing", () => {
  const d = deployment();
  const prev = d.creatorClaimHelper;
  beforeEach(() => { d.creatorClaimHelper = helper; resetOwnerYesReady(); });
  afterEach(() => { d.creatorClaimHelper = prev; resetOwnerYesReady(); });

  it("picks normal rockets with a balance on any side, skips private ones, caps the list", () => {
    expect(ownerYesTokens([{ token: tokA, claimable: 1n, tokenSide: null, anon: true }, ...rows])).toEqual([tokA, tokB].slice(0, MAX_OWNER_YES_TOKENS));
    expect(ownerYesTokens([{ token: tokA, claimable: 0n, tokenSide: { claimable: 0n } }])).toEqual([]);
    expect(ownerYesTokens(rows, 5)).toEqual([tokA, tokB, tokC]);
  });

  it("signs the existing Claim struct with the wallet key, paid to the wallet, at the helper's domain", async () => {
    const calls = await ownerYesClaimCalls(fakePc(true, 3n), rows, me.address, me);
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe(helper);
    const dec = decodeFunctionData({ abi: creatorClaimBySigAbi, data: calls[0].data });
    const c = dec.args[0] as { owner: Address; tokens: readonly Address[]; to: Address; relayerFeeBps: bigint; deadline: bigint; sig: Hex };
    expect(c.owner).toBe(me.address);
    expect(c.to).toBe(me.address);
    expect(c.relayerFeeBps).toBe(0n);
    expect(c.tokens.map((t) => t.toLowerCase())).toEqual([tokA, tokB]);
    const who = await recoverTypedDataAddress({ domain: creatorClaimDomain(ACTIVE_CHAIN.id, helper), types: CLAIM_TYPES, primaryType: "Claim",
      message: { owner: c.owner, tokens: [...c.tokens], to: c.to, relayerFeeBps: 0n, nonce: 3n, deadline: c.deadline }, signature: c.sig });
    expect(who).toBe(me.address);
  });

  it("does nothing until the owner approves the helper, without a helper, without the wallet key, or with another key", async () => {
    expect(await ownerYesClaimCalls(fakePc(false), rows, me.address, me)).toEqual([]);
    resetOwnerYesReady();
    expect(await ownerYesClaimCalls(fakePc(true), rows, me.address, null)).toEqual([]);
    expect(await ownerYesClaimCalls(fakePc(true), rows, me.address, other)).toEqual([]);
    d.creatorClaimHelper = undefined;
    expect(await ownerYesClaimCalls(fakePc(true), rows, me.address, me)).toEqual([]);
  });
});
