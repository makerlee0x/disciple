import "server-only";
/**
 * Each player's Lighter trading key, encrypted at rest in KV (AES-256-GCM, key = sha256(LIGHTER_KEY_SECRET)).
 * The key can only trade and change settings on the player's own Lighter account; it can't withdraw to another
 * address without the player's wallet signature. Players can revoke it from Lighter any time.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { kv, type Kv } from "@/lib/server/kv";
import type { LighterConfig } from "./config";

export interface LighterPlayer {
  account: number;
  keyIndex: number;
  pub: string;
  enc: string;            // encrypted private key
  keyReady: boolean;      // ChangePubKey landed
  tier?: string;          // tier we moved the account to
  approvedFee?: number;   // partner fee units the player approved (0 = none yet)
  approvedExpiry?: number;
  lev?: Record<string, number>; // market id → leverage set on Lighter
  pending?: { kind: "key" | "approve" | "withdraw"; txType: number; txInfo: string; message: string; at: number; to?: string; usd?: number;
    /** a re-key of a ready account: the new key, swapped in only once Lighter took the signed ChangePubKey */
    next?: { account: number; keyIndex: number; pub: string; enc: string } };
}

const k = (cfg: LighterConfig, pid: string) => `lighter:${cfg.network}:player:${pid.toLowerCase()}`;
const aes = (secret: string) => {
  if (secret.length < 16) throw new Error("LIGHTER_KEY_SECRET is not set (16+ chars).");
  return createHash("sha256").update(`disciple-lighter:${secret}`).digest();
};
export function seal(secret: string, plain: string): string {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", aes(secret), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}
export function open(secret: string, sealed: string): string {
  const [iv, tag, ct] = sealed.split(".").map((s) => Buffer.from(s, "base64url"));
  const d = createDecipheriv("aes-256-gcm", aes(secret), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

export async function getPlayer(cfg: LighterConfig, pid: string, s: Kv = kv()): Promise<LighterPlayer | null> {
  const raw = await s.get(k(cfg, pid)); return raw ? (JSON.parse(raw) as LighterPlayer) : null;
}
export async function putPlayer(cfg: LighterConfig, pid: string, p: LighterPlayer, s: Kv = kv()) { await s.set(k(cfg, pid), JSON.stringify(p)); }
