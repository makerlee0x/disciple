/** maker 2026-11-20: a new creator's claim first sweeps fees still booked to past creators (audit delta-2 D2-L8). */
import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, parseAbi, type Address } from "viem";
import { deployment } from "../lib/chains";
import { creatorClaimCalls, type ClaimRow } from "../lib/claims/creatorFees";
import { isRelayableCall } from "../lib/trade/gaslessAction";

const d = deployment();
const coin = "0x00000000000000000000000000000000000000c1" as Address;
const vault = "0x00000000000000000000000000000000000000f1" as Address;
const past = "0x00000000000000000000000000000000000000a1" as Address;
const other = "0x00000000000000000000000000000000000000ab" as Address;
const sweep = parseAbi(["function sweepPastCreatorFees_1311(address token, address past)", "function claimCreatorFees(address token)"]);
const caps = { creatorFees: true, creatorTokenFees: true, anonClaims: false } as Parameters<typeof creatorClaimCalls>[1];

describe("past-creator sweep", () => {
  it("sweeps FeeRouter and the vault before the claims, only where something is booked", () => {
    const row: ClaimRow = {
      token: coin, claimable: BigInt(30), tokenSide: null, vault, vaultClaimable: BigInt(20), baseClaimable: BigInt(10),
      past: [{ creator: past, base: BigInt(10), tok: BigInt(0), vault: BigInt(20) }, { creator: other, base: BigInt(0), tok: BigInt(0), vault: BigInt(5) }],
    };
    const calls = creatorClaimCalls([row], caps);
    const names = calls.map((c) => `${c.to.toLowerCase()}:${decodeFunctionData({ abi: sweep, data: c.data }).functionName}`);
    expect(names).toEqual([
      `${d.feeRouter.toLowerCase()}:sweepPastCreatorFees_1311`,
      `${vault}:sweepPastCreatorFees_1311`,
      `${vault}:sweepPastCreatorFees_1311`,
      `${d.feeRouter.toLowerCase()}:claimCreatorFees`,
      `${vault}:claimCreatorFees`,
    ]);
    const a = decodeFunctionData({ abi: sweep, data: calls[0].data }).args as readonly Address[];
    expect(a[1].toLowerCase()).toBe(past);
  });

  it("no past creators: no sweep calls", () => {
    const calls = creatorClaimCalls([{ token: coin, claimable: BigInt(1), tokenSide: null, baseClaimable: BigInt(1) }], caps);
    expect(calls).toHaveLength(1);
  });

  it("the sweep is relayable gasless on FeeRouter, the stack vault or the coin's own vault only", () => {
    const data = encodeFunctionData({ abi: sweep, functionName: "sweepPastCreatorFees_1311", args: [coin, past] });
    expect(isRelayableCall("anonClaim", { to: d.feeRouter, data })).toBe(true);
    expect(isRelayableCall("anonClaim", { to: other, data })).toBe(false);
    expect(isRelayableCall("anonClaim", { to: other, data }, new Set([other.toLowerCase()]))).toBe(true);
  });
});
