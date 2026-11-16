export const runtime = "nodejs";
/**
 * Rocket collection (lib/server/collection.ts).
 * GET ?wallet=0x… → { ok, collection, shop }   anyone's collection is public (it's what they fly); shop is today's stock.
 * GET ?proof=1 → { ok, proof }   today's and tomorrow's roll-seed hashes and the last 7 days' revealed seeds.
 * POST { op: "open", crate } | { op: "buy", item } | { op: "equip", skin, trail, tag?, flourish? } | { op: "scrap", copy } | { op: "tradeup", copies }  with the Privy session (Bearer), like
 *   the duel API, so opening a crate needs no wallet signature. Optional x-wallet picks one of the account's wallets.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { authenticate, bearer, privyEnv } from "@/lib/server/privyAuth";
import { buyItem, collectionOf, equip, openCrate, rollProof, scrapCopy, tradeUp } from "@/lib/server/collection";
import { shopStock } from "@/lib/collection";

export const dynamic = "force-dynamic";
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const id = (v: unknown) => (typeof v === "string" && /^[a-z0-9-]{1,48}$/.test(v) ? v : "");
const out = (status: number, b: Record<string, unknown>) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });

export async function GET(req: Request) {
  const w = new URL(req.url).searchParams.get("wallet");
  const rl = await hitLimit(kv(), `col:get:ip:${clientIp(req.headers)}`, 120, 60);
  if (!rl.ok) return out(429, { ok: false, reason: "Too many requests, try again shortly." });
  const shop = shopStock(Date.now());
  if (new URL(req.url).searchParams.get("proof")) { try { return out(200, { ok: true, proof: await rollProof() }); } catch (e) { return out(503, { ok: false, reason: (e as Error).message }); } }
  if (!isAddr(w)) return out(200, { ok: true, collection: null, shop });
  try { return out(200, { ok: true, collection: await collectionOf(w), shop }); }
  catch (e) { return out(503, { ok: false, reason: (e as Error).message }); }
}

export async function POST(req: Request) {
  const rl = await hitLimit(kv(), `col:post:ip:${clientIp(req.headers)}`, 60, 60);
  if (!rl.ok) return out(429, { ok: false, reason: "Too many requests, try again shortly." });
  const auth = await authenticate(bearer(req.headers), privyEnv());
  if (!auth.ok) return out(auth.status, { ok: false, reason: "Sign in to use your Hangar." });
  const wallets = auth.user.wallets.map((x) => x.toLowerCase());
  const want = req.headers.get("x-wallet");
  const wallet = isAddr(want) && wallets.includes(want.toLowerCase()) ? want.toLowerCase() : wallets[0];
  if (!wallet) return out(403, { ok: false, reason: "Your account needs a wallet." });
  let b: { op?: unknown; crate?: unknown; item?: unknown; skin?: unknown; trail?: unknown; tag?: unknown; flourish?: unknown; copy?: unknown; copies?: unknown };
  try { b = await req.json(); } catch { return out(400, { ok: false, reason: "Bad JSON" }); }
  try {
    if (b.op === "open") { const r = await openCrate(wallet, id(b.crate)); return out(r.ok ? 200 : 409, r); }
    if (b.op === "buy") { const r = await buyItem(wallet, id(b.item)); return out(r.ok ? 200 : 409, r); }
    if (b.op === "equip") { const r = await equip(wallet, id(b.skin), id(b.trail), id(b.tag), id(b.flourish)); return out(r.ok ? 200 : 409, r); }
    if (b.op === "scrap") { const r = await scrapCopy(wallet, id(b.copy)); return out(r.ok ? 200 : 409, r); }
    if (b.op === "tradeup") { const r = await tradeUp(wallet, Array.isArray(b.copies) ? b.copies.slice(0, 20).map(id).filter(Boolean) : []); return out(r.ok ? 200 : 409, r); }
    return out(400, { ok: false, reason: "Unknown action." });
  } catch (e) {
    console.error("[collection]", e);
    return out(500, { ok: false, reason: "Something broke. Try again." });
  }
}
