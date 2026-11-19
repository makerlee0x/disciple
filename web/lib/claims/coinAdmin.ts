/**
 * Rewards panel, one rocket you host (maker 2026-11-19): coin info, where its creator fees pay, transfer creator.
 *
 *   coin info     Launchpad.metaOf(token) → imageURI / description / socialsURI (name + ticker can't change on-chain)
 *                 wallet coins: Launchpad.updateMetadata (msg.sender = creator, sent from the wallet)
 *                 private coins: AnonLauncher.updateMetadataBySig, signed by the stealth owner, relayed (anonCreatorMeta)
 *   pays to       CreatorFeeHarvest.setCreatorFeeRecipient(token, recipient) / creatorFeeRecipientOf(token, creator)
 *                 (hook rebuild, 2026-11-19). Every creator fee claim then pays the pick. Missing on an older stack ⇒
 *                 readPayTo answers { supported: false } and the panel hides Pays to. Lock / burn coins have nothing to pay.
 *                 Private coins (AnonLauncher.setPayee) launch burn / lock only, so they never show Pays to.
 *   transfer      wallet coins: Launchpad.transferCreator; private coins: AnonLauncher.transferCreatorBySig, relayed
 *                 (anonTransferCreator). Unclaimed fees go to the new creator (maker 2026-11-19).
 *   gasless       (players hold USDG only, maker 2026-11-19) wallet coins sign instead: Launchpad.updateMetadataBySig /
 *                 transferCreatorBySig ("DISCIPLE Launchpad" v1) and CreatorFeeHarvest.setCreatorFeeRecipientBySig
 *                 ("DISCIPLE CreatorFeeHarvest" v1), each with the contract's sigNonces(creator); the relayer sends them
 *                 (creatorEdit) and the network fee is paid in USDG.
 */
import { encodeFunctionData, parseAbi, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import { anonLauncherAbi, launchpadAbi } from "../abi";
import { ACTIVE_CHAIN, deployment } from "../chains";
import { claimDomain, TRANSFER_TYPES } from "../anon";
import { execCalls, gaslessSigner } from "../wallet";
import { clientGaslessMode } from "../aa/sponsorshipMode";
import { sendGaslessAction } from "../trade/gaslessActionClient";
import { lc } from "./common";
import type { CreatorRocket } from "./creatorFees";

export type CoinLinks = { twitter?: string; telegram?: string; website?: string };
export type CoinMeta = { imageURI: string; description: string; links: CoinLinks };
type Row = Pick<CreatorRocket, "token" | "anon" | "launcher" | "stealth" | "routed">;

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const payToAbi = parseAbi([
  "function setCreatorFeeRecipient(address token, address recipient)",
  "function creatorFeeRecipientOf(address token, address creator) view returns (address)",
]);
const sigAbi = parseAbi([
  "function sigNonces(address signer) view returns (uint256)",
  "function updateMetadataBySig(address token, string imageURI, string description, string socialsURI, uint256 deadline, bytes sig)",
  "function transferCreatorBySig(address token, address newCreator, uint256 deadline, bytes sig)",
  "function setCreatorFeeRecipientBySig(address token, address recipient, uint256 deadline, bytes sig)",
]);
const LAUNCHPAD_TRANSFER_TYPES = {
  TransferCreator: [
    { name: "token", type: "address" }, { name: "newCreator", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
} as const;
const PAY_TO_TYPES = {
  SetCreatorFeeRecipient: [
    { name: "token", type: "address" }, { name: "recipient", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
} as const;
const sigDomain = (name: string, verifyingContract: Address) => ({ name, version: "1", chainId: ACTIVE_CHAIN.id, verifyingContract });
/** The signed-in wallet, when wallet-coin edits go by signature (gasless mode). */
function gaslessCreator(): LocalAccount | null {
  if (!clientGaslessMode()) return null;
  const w = gaslessSigner();
  if (!w) throw new Error("Sign in to continue.");
  return w;
}
export const METADATA_TYPES = {
  UpdateMetadata: [
    { name: "token", type: "address" }, { name: "imageURI", type: "string" }, { name: "description", type: "string" },
    { name: "socialsURI", type: "string" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
} as const;

/** socialsURI is the launch form's JSON ({ twitter, telegram, website }); anything else reads as no links. */
export function parseSocials(s: string): CoinLinks {
  try {
    const j = JSON.parse(s || "{}") as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    return { twitter: str(j.twitter), telegram: str(j.telegram), website: str(j.website) };
  } catch { return {}; }
}
export function socialsURI(l: CoinLinks): string {
  const o = Object.fromEntries(Object.entries(l).map(([k, v]) => [k, (v ?? "").trim()]).filter(([, v]) => v));
  return Object.keys(o).length ? JSON.stringify(o) : "";
}

export async function readCoinMeta(pc: PublicClient, token: Address): Promise<CoinMeta> {
  const m = await pc.readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "metaOf", args: [token] }) as unknown as readonly unknown[];
  // metaOf(token) → (name, ticker, imageURI, description, socialsURI, creator, creatorTaxBps, launchedAt)
  return { imageURI: String(m[2] ?? ""), description: String(m[3] ?? ""), links: parseSocials(String(m[4] ?? "")) };
}

/** The stealth key (or the wallet itself, for a wallet-owned private launch) that signs for a private coin. */
async function ownerAccount(r: Row): Promise<LocalAccount> {
  const { privateKeyToAccount } = await import("viem/accounts");
  if (r.stealth) {
    const { myStealthKeys, stealthKeyFor } = await import("../privateLaunch");
    const acct = privateKeyToAccount(stealthKeyFor(await myStealthKeys(), r.stealth.ephemeralPubKey));
    if (lc(acct.address) !== lc(r.stealth.owner)) throw new Error("This rocket's private key isn't on this login.");
    return acct;
  }
  const w = gaslessSigner();
  if (!w) throw new Error("Sign in to continue.");
  return w;
}
const ownerAddr = (r: Row, me: Address) => (r.stealth ? r.stealth.owner : me);
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 1800);

export async function saveCoinMeta(pc: PublicClient, me: Address, r: Row, m: CoinMeta): Promise<Hex> {
  const soc = socialsURI(m.links);
  const w = !r.anon ? gaslessCreator() : null;
  if (w) {
    const pad = deployment().launchpad;
    const nonce = await pc.readContract({ address: pad, abi: sigAbi, functionName: "sigNonces", args: [w.address] });
    const dl = deadline();
    const sig = await w.signTypedData({ domain: sigDomain("DISCIPLE Launchpad", pad), types: METADATA_TYPES, primaryType: "UpdateMetadata",
      message: { token: r.token, imageURI: m.imageURI, description: m.description, socialsURI: soc, nonce, deadline: dl } });
    const data = encodeFunctionData({ abi: sigAbi, functionName: "updateMetadataBySig", args: [r.token, m.imageURI, m.description, soc, dl, sig] });
    return (await sendGaslessAction("creatorEdit", [{ to: pad, data }], pc)).txHash;
  }
  if (!r.anon) {
    const res = await execCalls([{ to: deployment().launchpad, data: encodeFunctionData({ abi: launchpadAbi, functionName: "updateMetadata", args: [r.token, m.imageURI, m.description, soc] }) }]);
    return res.txHash;
  }
  const launcher = r.launcher!;
  const acct = await ownerAccount(r);
  const nonce = await pc.readContract({ address: launcher, abi: anonLauncherAbi, functionName: "nonces", args: [ownerAddr(r, me)] }) as bigint;
  const dl = deadline();
  const sig = await acct.signTypedData({ domain: claimDomain(ACTIVE_CHAIN.id, launcher), types: METADATA_TYPES, primaryType: "UpdateMetadata",
    message: { token: r.token, imageURI: m.imageURI, description: m.description, socialsURI: soc, nonce, deadline: dl } });
  const data = encodeFunctionData({ abi: anonLauncherAbi, functionName: "updateMetadataBySig", args: [r.token, m.imageURI, m.description, soc, dl, sig] });
  return (await sendGaslessAction("anonCreatorMeta", [{ to: launcher, data }], pc)).txHash;
}

export async function transferCreatorTo(pc: PublicClient, me: Address, r: Row, to: Address): Promise<Hex> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to) || lc(to) === lc(ZERO)) throw new Error("Pick who gets the rocket.");
  const w = !r.anon ? gaslessCreator() : null;
  if (w) {
    const pad = deployment().launchpad;
    const nonce = await pc.readContract({ address: pad, abi: sigAbi, functionName: "sigNonces", args: [w.address] });
    const dl = deadline();
    const sig = await w.signTypedData({ domain: sigDomain("DISCIPLE Launchpad", pad), types: LAUNCHPAD_TRANSFER_TYPES, primaryType: "TransferCreator",
      message: { token: r.token, newCreator: to, nonce, deadline: dl } });
    const data = encodeFunctionData({ abi: sigAbi, functionName: "transferCreatorBySig", args: [r.token, to, dl, sig] });
    return (await sendGaslessAction("creatorEdit", [{ to: pad, data }], pc)).txHash;
  }
  if (!r.anon) {
    const res = await execCalls([{ to: deployment().launchpad, data: encodeFunctionData({ abi: launchpadAbi, functionName: "transferCreator", args: [r.token, to] }) }]);
    return res.txHash;
  }
  const launcher = r.launcher!;
  const acct = await ownerAccount(r);
  const nonce = await pc.readContract({ address: launcher, abi: anonLauncherAbi, functionName: "nonces", args: [ownerAddr(r, me)] }) as bigint;
  const dl = deadline();
  const sig = await acct.signTypedData({ domain: claimDomain(ACTIVE_CHAIN.id, launcher), types: TRANSFER_TYPES, primaryType: "TransferCreator",
    message: { token: r.token, newOwner: to, nonce, deadline: dl } });
  const data = encodeFunctionData({ abi: anonLauncherAbi, functionName: "transferCreatorBySig", args: [r.token, to, dl, sig] });
  return (await sendGaslessAction("anonTransferCreator", [{ to: launcher, data }], pc)).txHash;
}

export type PayTo = { supported: false } | { supported: true; to: Address; self: boolean };
/** Where this rocket's creator fees pay. Unsupported on a stack without the recipient (older harvest), on private coins
 *  and on lock / burn coins. */
export async function readPayTo(pc: PublicClient, me: Address, r: Row): Promise<PayTo> {
  const harvest = deployment().creatorFeeHarvest;
  if (r.anon || r.routed || !harvest || lc(harvest) === lc(ZERO)) return { supported: false };
  try {
    const to = await pc.readContract({ address: harvest, abi: payToAbi, functionName: "creatorFeeRecipientOf", args: [r.token, me] });
    return { supported: true, to, self: lc(to) === lc(me) || lc(to) === lc(ZERO) };
  } catch { return { supported: false }; }
}
/** `to` = null (or your own wallet) pays you again. */
export async function setPayTo(me: Address, r: Row, to: Address | null, pc?: PublicClient): Promise<Hex> {
  const harvest = deployment().creatorFeeHarvest!;
  const pick = !to || lc(to) === lc(me) ? ZERO : to;
  const w = gaslessCreator();
  if (w) {
    const client = pc ?? (await import("../protocol-viem")).publicClient();
    const nonce = await client.readContract({ address: harvest, abi: sigAbi, functionName: "sigNonces", args: [w.address] });
    const dl = deadline();
    const sig = await w.signTypedData({ domain: sigDomain("DISCIPLE CreatorFeeHarvest", harvest), types: PAY_TO_TYPES, primaryType: "SetCreatorFeeRecipient",
      message: { token: r.token, recipient: pick, nonce, deadline: dl } });
    const data = encodeFunctionData({ abi: sigAbi, functionName: "setCreatorFeeRecipientBySig", args: [r.token, pick, dl, sig] });
    return (await sendGaslessAction("creatorEdit", [{ to: harvest, data }], client)).txHash;
  }
  const res = await execCalls([{ to: harvest, data: encodeFunctionData({ abi: payToAbi, functionName: "setCreatorFeeRecipient", args: [r.token, pick] }) }]);
  return res.txHash;
}
