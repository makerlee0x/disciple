import "server-only";
import { createPublicKey, verify } from "crypto";
import { b58decode } from "@/lib/nft/base58";

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/** True when `sigB58` is `wallet`'s ed25519 signature over the UTF-8 message (what solana:signMessage produces). */
export function verifySolSignature(wallet: string, message: string, sigB58: string): boolean {
  const pk = b58decode(wallet), sig = b58decode(sigB58);
  if (!pk || pk.length !== 32 || !sig || sig.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(pk)]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(sig));
  } catch { return false; }
}
