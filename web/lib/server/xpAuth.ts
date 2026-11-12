import "server-only";
/** Signed-request check shared by POST /api/shop/buy and POST /api/xp/prestige (same pattern as /api/x/connect). */
import { kv } from "./kv";
import { consumeNonce, nonceValid } from "./nonces";
import { verifyWalletSignature } from "./chat/identity";
import { XP_NONCE_PREFIX } from "./xp";

const isAddr = (a: string) => /^0x[0-9a-f]{40}$/.test(a);

export type SignedBody = { address?: unknown; nonce?: unknown; signature?: unknown; owner?: unknown };

/** The verified wallet (lowercase), or a reason + status. Consumes the nonce on success. */
export async function verifySigned(body: SignedBody, message: (addr: string, nonce: string) => string): Promise<{ ok: true; wallet: string } | { ok: false; reason: string; status: number }> {
  const addr = String(body?.address ?? "").toLowerCase();
  if (!isAddr(addr)) return { ok: false, reason: "Invalid address.", status: 400 };
  const nonce = String(body.nonce ?? "");
  if (!(await nonceValid(kv(), XP_NONCE_PREFIX, nonce, addr))) return { ok: false, reason: "Sign-in expired. Try again.", status: 401 };
  const owner = typeof body.owner === "string" ? body.owner : null;
  const who = await verifyWalletSignature(addr, message(addr, nonce), String(body.signature ?? ""), owner);
  if (who !== addr) return { ok: false, reason: "Signature didn't match this wallet.", status: 401 };
  if (!(await consumeNonce(kv(), XP_NONCE_PREFIX, nonce, addr))) return { ok: false, reason: "Sign-in expired. Try again.", status: 401 };
  return { ok: true, wallet: addr };
}
