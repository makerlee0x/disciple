export const runtime = "nodejs";
/**
 * Live catalogue admin (lib/server/catalog.ts). Privy session whose linked email is in ADMIN_EMAILS; unset ⇒ 503 (fail closed).
 * GET  → { me, catalog, series, drops, items: [{ id, kind, name, rar, series, drop, out, supply, base }], log }
 * POST { op: "save", base, catalog } → { ok, catalog } | { ok: false, reason, problems }   base = the version you edited
 * POST { op: "upload", name, type, data } → { ok, url }   data = base64 webp/png ≤ 3 MB, stored in Vercel Blob (BLOB_READ_WRITE_TOKEN)
 */
import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { DROPS, ITEMS, SERIES, isBaseItem, itemOut } from "@/lib/collection";
import { CATK, ensureCatalog, saveCatalog, supplyOf } from "@/lib/server/catalog";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { authenticateAdmin, bearer, privyEnv } from "@/lib/server/privyAuth";

export const dynamic = "force-dynamic";
const out = (status: number, b: Record<string, unknown>) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });

async function admin(req: Request) {
  const rl = await hitLimit(kv(), `catalog:admin:ip:${clientIp(req.headers)}`, 60, 60);
  if (!rl.ok) return { res: out(429, { error: "Too many requests, try again shortly." }) };
  const a = await authenticateAdmin(bearer(req.headers), privyEnv(), process.env.ADMIN_EMAILS);
  if (!a.ok) return { res: out(a.status, { error: a.reason }) };
  return { by: a.user.emails[0] ?? a.user.id };
}

export async function GET(req: Request) {
  const a = await admin(req); if (a.res) return a.res;
  const catalog = await ensureCatalog(kv(), true), now = Date.now();
  const supply = await supplyOf(ITEMS.map((i) => i.id), kv());
  const log = (await kv().zrange(CATK.log(), 30, true)).map((m) => { try { return JSON.parse(m); } catch { return null; } }).filter(Boolean);
  return out(200, {
    me: a.by, catalog, now, series: SERIES, drops: DROPS, log, blob: !!process.env.BLOB_READ_WRITE_TOKEN,
    items: ITEMS.map((i) => ({ id: i.id, kind: i.kind, name: i.name, rar: i.rar, series: i.series, drop: i.drop ?? null, out: itemOut(i, now), supply: supply[i.id] ?? 0, base: isBaseItem(i.id) })),
  });
}

const MAX_UPLOAD = 3 * 1024 * 1024;
export async function POST(req: Request) {
  const a = await admin(req); if (a.res) return a.res;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return out(400, { error: "We couldn't read that request. Try again." }); }
  if (body?.op === "save") {
    const r = await saveCatalog(body.catalog, Number(body.base), a.by!);
    return r.ok ? out(200, { ok: true, catalog: r.catalog }) : out(r.status, { ok: false, error: r.reason, problems: r.problems ?? [] });
  }
  if (body?.op === "upload") {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return out(503, { error: "Art upload needs Vercel Blob. Turn on a Blob store for this project in Vercel." });
    const name = String(body.name ?? ""), type = String(body.type ?? "");
    if (!/^[a-z0-9][a-z0-9-]{0,60}(--[a-z0-9-]{1,40})?(:bits)?$/.test(name)) return out(400, { error: "Name the file like the item id, e.g. needle--koi or trail-frost." });
    if (type !== "image/webp" && type !== "image/png") return out(400, { error: "Art must be .webp or .png." });
    const buf = Buffer.from(String(body.data ?? ""), "base64");
    if (!buf.length || buf.length > MAX_UPLOAD) return out(400, { error: "Art must be under 3 MB." });
    const webp = buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP", png = buf.subarray(1, 4).toString() === "PNG";
    if ((type === "image/webp" && !webp) || (type === "image/png" && !png)) return out(400, { error: "That file isn't the image type it says it is." });
    const file = `${name.replace(":bits", "-bits")}.${type === "image/webp" ? "webp" : "png"}`;
    const b = await put(`catalog/${file}`, buf, { access: "public", contentType: type, addRandomSuffix: true });
    return out(200, { ok: true, url: b.url });
  }
  return out(400, { error: "That action isn't available." });
}
