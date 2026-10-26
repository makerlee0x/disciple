/**
 * Private launches (AnonLauncher add-on; core stack unchanged).
 * UI copy says "private", never "anonymous" / "fully anonymous": the wallet that pays the launch fee and the creator
 * buy is still visible on-chain, and bundlers / our backend see request metadata.
 *
 * Launchers on RH testnet 46630:
 *   v5 (default)  0x73a2…C509  new private launches on the v5 stack (launchAnon(…, maxFee)); claimMany / claimManyBySig pay
 *                              BOTH sides. Also a one-tap session target (buildCreateSession anonLauncher).
 *   legacy        0x06f3…a527  the v4-stack v2 launcher (per FLOW's v5 env note); older coins only. The v1 launcher
 *                              0xe564…f359 is no longer listed (its coins live on the superseded v3/v4 launchpads).
 * Each coin's launcher = Launchpad.creatorOf(token) (the launcher is the on-chain creator), so pending / stealthOwnerOf /
 * claims / EIP-712 signatures always go to that address (a v1 coin sent to v2 reverts NotStealthOwner).
 */
import { concat, keccak256, toBytes, toHex, hexToBigInt, numberToHex, pad, type Hex, type Address } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1";

export type AnonAddons = { anonLauncher: Address; anonLauncherLegacy: Address; marketLens: Address; announcer: Address; v2DeployBlock: bigint };
/** Add-ons for RH testnet 46630 (contracts/deployments/rh-testnet-46630.json contracts.AnonLauncher / MarketLens, v5). */
export const ANON_ADDONS: Record<number, AnonAddons> = {
  46630: {
    anonLauncher: "0x73a2a6e049aa21A5C440F3bc358dE37FE3f7C509", // v5 contracts.AnonLauncher
    anonLauncherLegacy: "0x06f31a8877c8e025cc55faffb20cba8486cca527", // v4-stack AnonLauncher v2
    marketLens: "0xD89da17E3aEe9a7b1CBa359666F0fEb5382421Fa", // v5 contracts.MarketLens
    announcer: "0x55649E01B5Df198D18D95b5cc5051630cfD45564", // ERC-5564 singleton (= AnonLauncher(v5).announcer())
    v2DeployBlock: BigInt(142064537), // v5 AnonLauncher creation block (tx 0x853e696d…6c0b)
  },
};
/** Every AnonLauncher this chain still lists (current first). */
export const anonLaunchers = (chainId: number): Address[] => {
  const a = ANON_ADDONS[chainId];
  return a ? [a.anonLauncher, a.anonLauncherLegacy] : [];
};
export const isLegacyLauncher = (chainId: number, addr: string) =>
  !!ANON_ADDONS[chainId] && addr.toLowerCase() === ANON_ADDONS[chainId].anonLauncherLegacy.toLowerCase();

export const PRIVATE_COPY =
  "Private launch: the coin's creator on-chain is a one-time stealth address, not your wallet. " +
  "Only you can claim its creator fees. The wallet that pays the launch fee and First BOOST is still visible on-chain.";
/** Back-compat alias (old name). */
export const PSEUDONYMOUS_COPY = PRIVATE_COPY;

/** ERC-5564 scheme 1 (secp256k1): sender side. */
export function generateStealthAddress(spendPub: Hex, viewPub: Hex) {
  const eph = secp256k1.utils.randomPrivateKey();
  const ephemeralPubKey = toHex(secp256k1.getPublicKey(eph, true));
  const h = keccak256(toHex(secp256k1.getSharedSecret(eph, viewPub.slice(2), true)));
  const P = secp256k1.ProjectivePoint.fromHex(spendPub.slice(2)).add(
    secp256k1.ProjectivePoint.BASE.multiply(hexToBigInt(h) % secp256k1.CURVE.n),
  );
  return {
    stealthAddress: publicKeyToAddress(toHex(P.toRawBytes(false))),
    ephemeralPubKey,
    viewTag: h.slice(0, 4) as Hex,
  };
}

/** ERC-5564 scheme 1: recipient derives the stealth private key (used to sign EIP-712 claims). */
export function stealthPrivateKey(spendPriv: Hex, viewPriv: Hex, ephemeralPubKey: Hex): Hex {
  const h = keccak256(toHex(secp256k1.getSharedSecret(viewPriv.slice(2), ephemeralPubKey.slice(2), true)));
  return pad(numberToHex((hexToBigInt(spendPriv) + hexToBigInt(h)) % secp256k1.CURVE.n), { size: 32 });
}

/** ERC-5564 scheme 1: recipient check. Returns the stealth address when (ephemeralPubKey, viewTag) is ours, else null. */
export function checkStealthAddress(spendPub: Hex, viewPriv: Hex, ephemeralPubKey: Hex, viewTag?: Hex): Address | null {
  try {
    const h = keccak256(toHex(secp256k1.getSharedSecret(viewPriv.slice(2), ephemeralPubKey.slice(2), true)));
    if (viewTag && h.slice(0, 4).toLowerCase() !== viewTag.toLowerCase()) return null;
    const P = secp256k1.ProjectivePoint.fromHex(spendPub.slice(2)).add(
      secp256k1.ProjectivePoint.BASE.multiply(hexToBigInt(h) % secp256k1.CURVE.n),
    );
    return publicKeyToAddress(toHex(P.toRawBytes(false)));
  } catch { return null; }
}

export type StealthKeys = { spendPriv: Hex; viewPriv: Hex; spendPub: Hex; viewPub: Hex };
/** Message whose owner signature seeds the private-launch keys (deterministic: same owner + account ⇒ same keys). */
export const stealthSeedHash = (account: Address, chainId: number) =>
  keccak256(toBytes(`DISCIPLE private launch keys v1\nchain:${chainId}\naccount:${account.toLowerCase()}`));
const scalar = (seed: Hex, label: string): Hex => {
  const n = secp256k1.CURVE.n;
  const v = (hexToBigInt(keccak256(concat([seed, toHex(label)]))) % (n - BigInt(1))) + BigInt(1);
  return pad(numberToHex(v), { size: 32 });
};
/** Spend/view key pair from a deterministic owner signature (kept in memory only, never stored or sent). */
export function stealthKeysFromSignature(sig: Hex): StealthKeys {
  const seed = keccak256(sig);
  const spendPriv = scalar(seed, "spend"), viewPriv = scalar(seed, "view");
  return {
    spendPriv, viewPriv,
    spendPub: toHex(secp256k1.getPublicKey(spendPriv.slice(2), true)),
    viewPub: toHex(secp256k1.getPublicKey(viewPriv.slice(2), true)),
  };
}

export const CLAIM_TYPES = {
  Claim: [
    { name: "owner", type: "address" },
    { name: "tokens", type: "address[]" },
    { name: "to", type: "address" },
    { name: "relayerFeeBps", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** EIP-712 domain of ONE launcher (v1 and v2 share name/version; verifyingContract differs ⇒ sign per coin's launcher). */
export const claimDomain = (chainId: number, verifyingContract: Address) =>
  ({ name: "DISCIPLE AnonLauncher", version: "1", chainId, verifyingContract }) as const;
