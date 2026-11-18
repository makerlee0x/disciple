export const runtime = "nodejs";
/**
 * Market admin (lib/server/market.ts). Privy session whose email is in ADMIN_EMAILS; unset ⇒ 503 (fail closed).
 * POST { op: "freeze", copy, reason } → freezes a copy (reported stolen or farmed): no listing, buying or trading; its listing comes down.
 * POST { op: "unfreeze", copy }
 * POST { op: "grant", wallet | username, items: [item ids] } → tradable test copies for that pilot (lib/server/collection grantTestCopies).
 * POST { op: "settle", listing, buyer, tx } → a payment landed but the copy didn't move (the buyer saw "still confirming"):
 *   check the transfer on the explorer first, then this moves the copy to the buyer and closes the listing.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { freezeCopy, settleSale, unfreezeCopy } from "@/lib/server/market";
import { grantTestCopies } from "@/lib/server/collection";
import { walletOf } from "@/lib/server/usernames";
import { authenticateAdmin, bearer, privyEnv } from "@/lib/server/privyAuth";

export const dynamic = "force-dynamic";
const out = (status: number, b: Record<string, unknown>) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export async function POST(req: Request) {
  const rl = await hitLimit(kv(), `mkt:admin:ip:${clientIp(req.headers)}`, 30, 60);
  if (!rl.ok) return out(429, { ok: false, reason: "Too many requests." });
  const a = await authenticateAdmin(bearer(req.headers), privyEnv(), process.env.ADMIN_EMAILS);
  if (!a.ok) return out(a.status, { ok: false, reason: a.reason });
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return out(400, { ok: false, reason: "Bad JSON" }); }
  const by = a.user.emails[0] ?? a.user.id;
  if (b.op === "freeze") { const r = await freezeCopy(str(b.copy), `${str(b.reason) || "frozen"} (by ${by})`); return out(r.ok ? 200 : 400, r); }
  if (b.op === "unfreeze") return out(200, await unfreezeCopy(str(b.copy)));
  if (b.op === "grant") {
    const w = /^0x[0-9a-fA-F]{40}$/.test(str(b.wallet)) ? str(b.wallet) : await walletOf(str(b.username).replace(/^@/, "").toLowerCase());
    if (!w || !/^0x[0-9a-fA-F]{40}$/.test(w)) return out(400, { ok: false, reason: "Need a wallet or a username." });
    const items = Array.isArray(b.items) ? b.items.filter((x): x is string => typeof x === "string") : [];
    if (!items.length) return out(400, { ok: false, reason: "Need item ids." });
    const r = await grantTestCopies(w, items);
    return out(r.ok ? 200 : 409, { wallet: w, ...r });
  }
  if (b.op === "settle") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(str(b.buyer))) return out(400, { ok: false, reason: "Need the buyer's wallet." });
    const r = await settleSale(str(b.listing), str(b.buyer), str(b.tx) || undefined);
    return out("ok" in r && r.ok === false ? 409 : 200, "ok" in r ? r : { ok: true, listing: r });
  }
  return out(400, { ok: false, reason: "Unknown action." });
}
