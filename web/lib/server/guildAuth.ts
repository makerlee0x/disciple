import "server-only";
/**
 * Signed guild actions (create / join / leave): single-use nonce (lib/server/nonces, prefix guild:nonce, 10 min) + wallet
 * signature over guildActionMessage, verified like /api/profile/meta. Per-IP and per-wallet limits (lib/server/limits).
 */
import { NextResponse } from "next/server";
import { kv } from "./kv";
import { consumeNonce, issueNonce, nonceValid } from "./nonces";
import { verifyWalletSignature } from "./chat/identity";
import { clientIp, hitLimit } from "./limits";
import { guildActionMessage, type GuildAction } from "@/lib/guilds";
import type { GuildResult } from "./guildStore";

export const GUILD_NONCE_TTL = 600;
const PREFIX = "guild:nonce";
export const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const tooMany = (retry: number) => NextResponse.json({ ok: false, reason: "Too many requests, try again shortly." }, { status: 429, headers: { "retry-after": String(retry) } });

export async function guildNonce(req: Request, address: string) {
  const rl = await hitLimit(kv(), `guild:nonce:ip:${clientIp(req.headers)}`, 30, 60);
  if (!rl.ok) return tooMany(rl.retryAfterSec);
  const nonce = await issueNonce(kv(), PREFIX, address, GUILD_NONCE_TTL);
  return NextResponse.json({ nonce, ttlSec: GUILD_NONCE_TTL }, { headers: { "cache-control": "no-store" } });
}

export type GuildBody = { address?: unknown; guildId?: unknown; tag?: unknown; name?: unknown; nonce?: unknown; signature?: unknown; owner?: unknown };

/** Parse + rate-limit + verify. Returns the lower-case wallet and body, or an error response. */
export async function verifiedGuildAction(req: Request, action: GuildAction, fields: (b: GuildBody) => { guildId?: string; tag?: string; name?: string }):
  Promise<{ ok: true; addr: string; body: GuildBody; consume: () => Promise<boolean> } | { ok: false; res: NextResponse }> {
  const rl = await hitLimit(kv(), `guild:ip:${clientIp(req.headers)}`, 20, 60);
  if (!rl.ok) return { ok: false, res: tooMany(rl.retryAfterSec) };
  let body: GuildBody;
  try { body = await req.json(); } catch { return { ok: false, res: NextResponse.json({ ok: false, reason: "Bad JSON" }, { status: 400 }) }; }
  if (!body || typeof body !== "object") return { ok: false, res: NextResponse.json({ ok: false, reason: "Bad JSON" }, { status: 400 }) };
  const addr = String(body.address ?? "").toLowerCase();
  if (!isAddr(addr)) return { ok: false, res: NextResponse.json({ ok: false, reason: "Invalid address." }, { status: 400 }) };
  const rlA = await hitLimit(kv(), `guild:addr:${addr}`, 10, 60);
  if (!rlA.ok) return { ok: false, res: tooMany(rlA.retryAfterSec) };
  const nonce = String(body.nonce ?? "");
  const expired = () => NextResponse.json({ ok: false, reason: "Sign-in expired. Try again." }, { status: 401 });
  if (!(await nonceValid(kv(), PREFIX, nonce, addr))) return { ok: false, res: expired() };
  const owner = typeof body.owner === "string" ? body.owner : null;
  const who = await verifyWalletSignature(addr, guildActionMessage(action, addr, fields(body), nonce), String(body.signature ?? ""), owner);
  if (who !== addr) return { ok: false, res: NextResponse.json({ ok: false, reason: "Signature didn't match this wallet." }, { status: 401 }) };
  return { ok: true, addr, body, consume: () => consumeNonce(kv(), PREFIX, nonce, addr) };
}

export function guildResponse(r: GuildResult) {
  if (r.ok) return NextResponse.json({ ok: true, guild: r.guild });
  return NextResponse.json({ ok: false, reason: r.reason, ...(r.nextAllowedAt ? { nextAllowedAt: r.nextAllowedAt } : {}) }, { status: r.status });
}
