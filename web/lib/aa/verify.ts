/**
 * Smart-account / EOA signature check shared by chat login and username claims (server), kept free of
 * `server-only` so it can be unit-tested with a fake client.
 * Order:
 *  1. viem verifyMessage: EOA ecrecover, ERC-1271 (deployed MAv2 / LightAccount), ERC-6492 (counterfactual MAv2).
 *  2. Only if that fails AND the account is NOT deployed: legacy owner shortcut — `owner` signed keccak(msg) raw and the
 *     factory-predicted address for that owner (MAv2 SemiModular, else LightAccount v2, salt 0) equals `addr`.
 *     A deployed account is never accepted via the shortcut (its owner may have rotated; 1271 is the source of truth).
 */
import { keccak256, parseAbi, recoverMessageAddress, stringToBytes, type Address, type Hex } from "viem";
import { LIGHT_ACCOUNT_V2_FACTORY, MAV2_FACTORY } from "./constants";

const mav2FactoryAbi = parseAbi(["function getAddressSemiModular(address owner, uint256 salt) view returns (address)"]);
const laFactoryAbi = parseAbi(["function getAddress(address owner, uint256 salt) view returns (address)"]);
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

/** The slice of a viem PublicClient this needs (tests pass a fake). */
export type VerifyClient = {
  verifyMessage(a: { address: Address; message: string; signature: Hex }): Promise<boolean>;
  getCode(a: { address: Address }): Promise<Hex | undefined>;
  readContract(a: { address: Address; abi: unknown; functionName: string; args: readonly unknown[] }): Promise<unknown>;
};

/** Returns the lowercase address if `sig` proves `addr` signed `msg`, else null. */
export async function verifyAccountSignature(pc: VerifyClient, addr: string, msg: string, sigIn: string, owner?: string | null): Promise<string | null> {
  const sig = sigIn as Hex;
  if (!isAddr(addr) || !/^0x[0-9a-fA-F]+$/.test(sig)) return null;
  const a = addr.toLowerCase();
  if (await pc.verifyMessage({ address: addr as Address, message: msg, signature: sig }).catch(() => false)) return a;
  if (!owner || !isAddr(owner)) return null;
  const code = await pc.getCode({ address: addr as Address }).catch(() => "0x" as Hex);
  if (code && code !== "0x") return null; // deployed: only a real ERC-1271 signature counts
  const rec = await recoverMessageAddress({ message: { raw: keccak256(stringToBytes(msg)) }, signature: sig }).catch(() => null);
  if (!rec || rec.toLowerCase() !== owner.toLowerCase()) return null;
  const [mav2, la] = await Promise.all([
    pc.readContract({ address: MAV2_FACTORY, abi: mav2FactoryAbi, functionName: "getAddressSemiModular", args: [rec, BigInt(0)] }).catch(() => null),
    pc.readContract({ address: LIGHT_ACCOUNT_V2_FACTORY, abi: laFactoryAbi, functionName: "getAddress", args: [rec, BigInt(0)] }).catch(() => null),
  ]);
  return [mav2, la].some((p) => typeof p === "string" && p.toLowerCase() === a) ? a : null;
}
