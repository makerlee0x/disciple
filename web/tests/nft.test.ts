import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "crypto";
import { b58decode, b58encode } from "@/lib/nft/base58";
import { verifySolSignature } from "@/lib/server/nft/solSig";
import { DISCIPLE_COLLECTION, DISCIPLE_TREASURY, METADATA_BASE, REVEALED_BASE, holderLinkMessage, isSolAddress, itemIndex, revealedNumber } from "@/lib/nft/config";

describe("base58", () => {
  it("round-trips Solana addresses", () => {
    for (const a of [DISCIPLE_COLLECTION, DISCIPLE_TREASURY, "11111111111111111111111111111111"]) {
      const b = b58decode(a)!;
      expect(b.length).toBe(32);
      expect(b58encode(b)).toBe(a);
    }
  });
  it("keeps leading zero bytes and rejects bad characters", () => {
    expect(b58encode(new Uint8Array([0, 0, 1]))).toBe("112");
    expect(b58decode("0OIl")).toBeNull();
  });
});

describe("verifySolSignature", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const wallet = b58encode(raw);
  const msg = holderLinkMessage("0xAbC0000000000000000000000000000000000001", "sol", wallet, "n1");
  const sig = b58encode(sign(null, Buffer.from(msg, "utf8"), privateKey));
  it("accepts the wallet's own signature", () => expect(verifySolSignature(wallet, msg, sig)).toBe(true));
  it("rejects another message, another wallet, junk", () => {
    expect(verifySolSignature(wallet, msg + " ", sig)).toBe(false);
    expect(verifySolSignature(DISCIPLE_TREASURY, msg, sig)).toBe(false);
    expect(verifySolSignature(wallet, msg, "abc")).toBe(false);
  });
  it("lower-cases the profile in the message", () => expect(msg).toContain("Profile: 0xabc0000000000000000000000000000000000001"));
});

describe("drop items", () => {
  it("reads the item index from a drop uri", () => {
    expect(itemIndex(`${METADATA_BASE}181.json`)).toBe(181);
    expect(itemIndex(`${METADATA_BASE}0.json`)).toBe(0);
    expect(itemIndex(`${METADATA_BASE}777.json`)).toBeNull();
    expect(itemIndex("https://example.com/181.json")).toBeNull();
    expect(revealedNumber(`${REVEALED_BASE}505.json`)).toBe(505);
    expect(revealedNumber(`${REVEALED_BASE}777.json`)).toBeNull();
    expect(revealedNumber(`${METADATA_BASE}505.json`)).toBeNull();
  });
  it("checks Solana addresses", () => {
    expect(isSolAddress(DISCIPLE_COLLECTION)).toBe(true);
    expect(isSolAddress("0x00")).toBe(false);
  });
});
