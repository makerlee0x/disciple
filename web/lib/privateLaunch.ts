/**
 * Private launches (AnonLauncher v2) — client side.
 *  - Stealth meta keys (spend/view) are derived from ONE deterministic owner signature over stealthSeedHash(account,
 *    chain) (Privy owner signs silently). Same owner + account ⇒ same keys on every device; held in memory only.
 *  - Each launch gets a fresh ERC-5564 stealth owner; AnonLauncher announces (ephemeralPubKey, viewTag‖token).
 *  - The dashboard finds the user's private coins by scanning Announcement(caller = a launcher) logs with the view key.
 */
import { parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { ACTIVE_CHAIN, deployment } from "./chains";
import { ANON_ADDONS, anonLaunchers, checkStealthAddress, generateStealthAddress, stealthKeysFromSignature, stealthPrivateKey, stealthSeedHash, type StealthKeys } from "./anon";
import { aaOwnerSign, aaAddress } from "./aa/session";

const cache = new Map<string, StealthKeys>();
/** The signed-in account's stealth keys (one silent owner signature per page load). Throws when not in smart mode. */
export async function myStealthKeys(): Promise<StealthKeys> {
  const acct = await aaAddress();
  if (!acct) throw new Error("Sign in to launch privately.");
  const k = `${ACTIVE_CHAIN.id}:${acct.toLowerCase()}`;
  const hit = cache.get(k); if (hit) return hit;
  const s = await aaOwnerSign(stealthSeedHash(acct, ACTIVE_CHAIN.id));
  if (!s) throw new Error("Sign in to launch privately.");
  const keys = stealthKeysFromSignature(s.sig);
  cache.set(k, keys);
  return keys;
}

/** Fresh stealth owner for one launch. */
export async function newStealthOwner(): Promise<{ stealthOwner: Address; ephemeralPubKey: Hex; viewTag: Hex }> {
  const keys = await myStealthKeys();
  const s = generateStealthAddress(keys.spendPub, keys.viewPub);
  return { stealthOwner: s.stealthAddress, ephemeralPubKey: s.ephemeralPubKey, viewTag: s.viewTag };
}

const ANNOUNCEMENT = parseAbiItem("event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)");
export type MyStealthCoin = { token: Address; stealthAddress: Address; ephemeralPubKey: Hex; launcher: Address };

/** Coins whose launch announcement belongs to `keys` (both launchers). metadata = viewTag(1) ‖ token(20). */
export async function myStealthCoins(pc: PublicClient, keys: StealthKeys): Promise<MyStealthCoin[]> {
  const a = ANON_ADDONS[ACTIVE_CHAIN.id];
  if (!a) return [];
  const logs = await pc.getLogs({ address: a.announcer, event: ANNOUNCEMENT, args: { schemeId: BigInt(1), caller: anonLaunchers(ACTIVE_CHAIN.id) }, fromBlock: deployment().fromBlock, toBlock: "latest" });
  const out: MyStealthCoin[] = [];
  for (const l of logs) {
    const md = (l.args.metadata ?? "0x") as Hex, eph = l.args.ephemeralPubKey as Hex;
    if (md.length < 2 + 42) continue;
    const viewTag = md.slice(0, 4) as Hex, token = ("0x" + md.slice(4, 44)) as Address;
    const sa = checkStealthAddress(keys.spendPub, keys.viewPriv, eph, viewTag);
    if (sa && sa.toLowerCase() === String(l.args.stealthAddress).toLowerCase())
      out.push({ token: token.toLowerCase() as Address, stealthAddress: sa, ephemeralPubKey: eph, launcher: String(l.args.caller).toLowerCase() as Address });
  }
  return out;
}

/** Stealth private key for one of our coins (signs its EIP-712 Claim). */
export const stealthKeyFor = (keys: StealthKeys, eph: Hex) => stealthPrivateKey(keys.spendPriv, keys.viewPriv, eph);
