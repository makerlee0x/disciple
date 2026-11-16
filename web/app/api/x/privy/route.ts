export const runtime = "nodejs";
/**
 * Link X from the iPhone app. POST { address, nonce, signature, owner? } with `Authorization: Bearer <Privy access token>`
 * → { ok, link? , reason? }.
 *
 * In the app, X's own sign-in page inside the web view can't reuse the X login you already have in Safari, and often
 * refuses outright (maker 2026-11-16: "x connect didnt work"). So the app links X to the Privy account instead
 * (usePrivy().linkTwitter), which runs in iOS's system sign-in sheet (mobile/ios/App/App/DiscipleNative.swift
 * NativeAuthPlugin). Privy has then verified the X account through X's OAuth; this route reads it from Privy's API
 * (twitter_oauth: subject = X user id, username) and stores the same link as /api/x/callback does.
 * Two proofs: the wallet signature + single-use nonce (same message as /api/x/connect) proves the wallet, and the Privy
 * access token proves the X account belongs to the signed-in player.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { consumeNonce, nonceValid } from "@/lib/server/nonces";
import { verifyWalletSignature } from "@/lib/server/chat/identity";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { authenticate, bearer, privyEnv } from "@/lib/server/privyAuth";
import { X_NONCE_PREFIX, saveLink } from "@/lib/server/xLink";
import { X_RESULT_COPY, xConnectMessage } from "@/lib/xLink";

export const dynamic = "force-dynamic";
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const out = (status: number, j: Record<string, unknown>) => NextResponse.json(j, { status, headers: { "cache-control": "no-store" } });

export async function POST(req: Request) {
  const rl = await hitLimit(kv(), `x:privy:ip:${clientIp(req.headers)}`, 10, 60);
  if (!rl.ok) return out(429, { ok: false, reason: "Too many requests, try again shortly." });
  let body: { address?: unknown; nonce?: unknown; signature?: unknown; owner?: unknown };
  try { body = await req.json(); } catch { return out(400, { ok: false, reason: "Bad JSON" }); }
  const addr = String(body?.address ?? "").toLowerCase();
  if (!isAddr(addr)) return out(400, { ok: false, reason: "Invalid address." });
  const nonce = String(body.nonce ?? "");
  if (!(await nonceValid(kv(), X_NONCE_PREFIX, nonce, addr))) return out(401, { ok: false, reason: "Sign-in expired. Try again." });
  const owner = typeof body.owner === "string" ? body.owner : null;
  const who = await verifyWalletSignature(addr, xConnectMessage(addr, nonce), String(body.signature ?? ""), owner);
  if (who !== addr) return out(401, { ok: false, reason: "Signature didn't match this wallet." });
  // fresh: the X account was linked to the Privy user moments ago
  const a = await authenticate(bearer(req.headers), privyEnv(), undefined, undefined, true);
  if (!a.ok) return out(a.status, { ok: false, reason: a.reason });
  if (!a.user.x) return out(409, { ok: false, reason: X_RESULT_COPY.error, error: "no_x" });
  if (!(await consumeNonce(kv(), X_NONCE_PREFIX, nonce, addr))) return out(401, { ok: false, reason: "Sign-in expired. Try again." });
  const r = await saveLink(addr, a.user.x.id, a.user.x.username);
  if (!r.ok) return out(409, { ok: false, reason: r.reason === "taken" ? X_RESULT_COPY.taken : X_RESULT_COPY.error });
  return out(200, { ok: true, link: r.link });
}
