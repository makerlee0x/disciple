/**
 * Owner-yes claim for normal (wallet-launched) rockets — docs/owner-yes-creator-claim.md.
 *
 * Same pattern as a private launch (AnonLauncher.claimManyBySig / CurveFeeVault.claimManyAsStealthBySig): the owner
 * signs the existing EIP-712 Claim struct (lib/anon CLAIM_TYPES) and the gasless relayer submits it. The contract is
 * CreatorClaimBySig ("DISCIPLE CreatorClaim" v1), which pulls through the existing claim-router functions
 * (FeeRouter.claimCreatorFeesFor / claimCreatorTokenFeesFor_15, CurveFeeVault.claimCreatorFeesToRouter) and pays the
 * wallet that signed. Offered only when the helper address is configured AND FeeRouter.isClaimRouter(helper) is true
 * (the later owner step setClaimRouter). Otherwise nothing here runs and claims behave as before.
 */
import { encodeFunctionData, parseAbi, type Address, type LocalAccount, type PublicClient } from "viem";
import type { Call } from "../aa/core";
import { CLAIM_TYPES } from "../anon";
import { ACTIVE_CHAIN, deployment } from "../chains";

const ZERO = BigInt(0);
const lc = (a: string) => a.toLowerCase();
/** One signed call per claim, up to this many rockets (~230k gas each worst case, inside the 800k action tx limit). */
export const MAX_OWNER_YES_TOKENS = 2;

export const creatorClaimBySigAbi = parseAbi([
  "struct ClaimReq { address owner; address[] tokens; address to; uint256 relayerFeeBps; uint256 deadline; bytes sig; }",
  "function claimCreatorFeesBySig(ClaimReq c) returns (address creator)",
  "function nonces(address owner) view returns (uint256)",
  "function claimDigest(address owner, address[] tokens, address to, uint256 relayerFeeBps, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "event CreatorClaimedBySig(address indexed token, address indexed creator, address to, uint256 quoteAmount, uint256 tokenAmount)",
  "error BadSignature()",
  "error NothingToClaim()",
  "error Expired()",
]);
const isClaimRouterAbi = parseAbi(["function isClaimRouter(address router) view returns (bool)"]);

export const creatorClaimDomain = (chainId: number, verifyingContract: Address) =>
  ({ name: "DISCIPLE CreatorClaim", version: "1", chainId, verifyingContract }) as const;

/** Configured helper address, or null (env NEXT_PUBLIC_<NET>_CREATOR_CLAIM_HELPER unset). */
export function creatorClaimHelper(): Address | null {
  const h = deployment().creatorClaimHelper;
  return h && !/^0x0{40}$/i.test(h) ? h : null;
}

let ready: { key: string; p: Promise<boolean> } | null = null;
/** Helper configured and approved by the FeeRouter owner (isClaimRouter). Cached per page load; a failed read is false. */
export function ownerYesReady(pc: PublicClient): Promise<boolean> {
  const h = creatorClaimHelper();
  if (!h) return Promise.resolve(false);
  const key = `${lc(deployment().feeRouter)}:${lc(h)}`;
  if (!ready || ready.key !== key) {
    const p = (pc.readContract({ address: deployment().feeRouter, abi: isClaimRouterAbi, functionName: "isClaimRouter", args: [h] }) as Promise<boolean>)
      .then((x) => x === true, () => false);
    ready = { key, p };
    p.then((x) => { if (!x && ready?.p === p) ready = null; }); // re-check next time after a no (owner may approve later)
  }
  return ready.p;
}
/** Test hook. */
export function resetOwnerYesReady() { ready = null; }

export type OwnerYesRow = {
  token: Address; claimable: bigint; anon?: boolean;
  tokenSide: { claimable: bigint } | null;
};
/** Normal (non-private) rockets with something on any side, capped at MAX_OWNER_YES_TOKENS. */
export function ownerYesTokens(rows: OwnerYesRow[], max = MAX_OWNER_YES_TOKENS): Address[] {
  const out: Address[] = [];
  for (const r of rows) {
    if (r.anon) continue;
    if (r.claimable <= ZERO && !(r.tokenSide && r.tokenSide.claimable > ZERO)) continue;
    if (out.some((t) => lc(t) === lc(r.token))) continue;
    out.push(r.token);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The signed CreatorClaimBySig call for `me`'s normal rockets (paid to `me`, relayer fee 0 — the relay charges its
 * usual USDG fee). Empty when the helper is not ready, there is no wallet key to sign with (not gasless mode), the
 * key is not `me`, or nothing is claimable.
 */
export async function ownerYesClaimCalls(pc: PublicClient, rows: OwnerYesRow[], me: Address, signer: LocalAccount | null | undefined): Promise<Call[]> {
  const h = creatorClaimHelper();
  if (!h || !signer || lc(signer.address) !== lc(me)) return [];
  const tokens = ownerYesTokens(rows);
  if (!tokens.length) return [];
  if (!(await ownerYesReady(pc))) return [];
  const nonce = await pc.readContract({ address: h, abi: creatorClaimBySigAbi, functionName: "nonces", args: [me] }) as bigint;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const sig = await signer.signTypedData({ domain: creatorClaimDomain(ACTIVE_CHAIN.id, h), types: CLAIM_TYPES, primaryType: "Claim",
    message: { owner: me, tokens, to: me, relayerFeeBps: ZERO, nonce, deadline } });
  return [{ to: h, data: encodeFunctionData({ abi: creatorClaimBySigAbi, functionName: "claimCreatorFeesBySig", args: [{ owner: me, tokens, to: me, relayerFeeBps: ZERO, deadline, sig }] }) }];
}
