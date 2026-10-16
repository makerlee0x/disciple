/**
 * Pseudonymous launches v0 (add-on contracts; core stack unchanged).
 * UI copy MUST say "pseudonymous", never "anonymous": the payer of the launch fee / creator buy is
 * still visible on-chain, and sponsors/bundlers/our backend see request metadata.
 */
import { keccak256, toHex, hexToBigInt, numberToHex, pad, type Hex, type Address } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1";

/** Add-ons for RH testnet 46630 — AnonLauncher/MarketLens from web-bundle @ 27e92d8; announcer is the ERC-5564 singleton (on-chain AnonLauncher.announcer()). */
export const ANON_ADDONS: Record<number, { anonLauncher: Address; marketLens: Address; announcer: Address }> = {
  46630: {
    anonLauncher: "0xd38e9DB3790e4587f97D0541943CF5a0239F1870",
    marketLens: "0x4683F586aD2F70443f74f40751D202494EC9d0Ed",
    announcer: "0x55649E01B5Df198D18D95b5cc5051630cfD45564",
  },
};

export const PSEUDONYMOUS_COPY =
  "Pseudonymous creator: the coin's creator is a one-time stealth address, not your wallet. " +
  "This is NOT anonymous — the wallet that pays the launch fee and creator buy is visible on-chain.";

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

export const claimDomain = (chainId: number, verifyingContract: Address) =>
  ({ name: "DISCIPLE AnonLauncher", version: "1", chainId, verifyingContract }) as const;
