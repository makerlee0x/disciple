export const runtime = "nodejs";
/**
 * Username registry stub (testnet).
 * GET  ?u=name            → { available, reason? }
 * GET  ?address=0x…       → { username | null }
 * POST { username, address, previous? } → { ok, reason? }
 *
 * Storage: in-memory Map, persisted best-effort to a JSON file (USERNAME_STORE_FILE or
 * /tmp/disciple-usernames.json). PRODUCTION NEEDS A DURABLE STORE (Postgres/KV) and a signed
 * message proving address ownership — this stub trusts the posted address.
 */
import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { RESERVED, USERNAME_RE } from "@/lib/profile";

export const dynamic = "force-dynamic";

const FILE = process.env.USERNAME_STORE_FILE || "/tmp/disciple-usernames.json";
type Store = Map<string, string>; // username → address (lowercase)
const g = globalThis as unknown as { __discipleUsernames?: Store; __discipleUsernamesLoaded?: boolean };
const store: Store = (g.__discipleUsernames ??= new Map());

async function load() {
  if (g.__discipleUsernamesLoaded) return;
  g.__discipleUsernamesLoaded = true;
  try {
    const j = JSON.parse(await fs.readFile(FILE, "utf8")) as Record<string, string>;
    for (const [k, v] of Object.entries(j)) store.set(k, v);
  } catch { /* first run */ }
}
async function save() {
  try { await fs.writeFile(FILE, JSON.stringify(Object.fromEntries(store))); } catch { /* read-only fs: memory only */ }
}
const norm = (u: unknown) => String(u ?? "").trim().toLowerCase().replace(/^@/, "");
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

export async function GET(req: Request) {
  await load();
  const url = new URL(req.url);
  const address = url.searchParams.get("address");
  if (address) {
    const a = address.toLowerCase();
    const hit = Array.from(store.entries()).find(([, v]) => v === a);
    return NextResponse.json({ username: hit?.[0] ?? null });
  }
  const u = norm(url.searchParams.get("u"));
  if (!USERNAME_RE.test(u)) return NextResponse.json({ available: false, reason: "3–20 chars: a–z, 0–9, underscore." });
  if (RESERVED.has(u)) return NextResponse.json({ available: false, reason: "That name is reserved." });
  return NextResponse.json({ available: !store.has(u), reason: store.has(u) ? "Username taken." : undefined });
}

export async function POST(req: Request) {
  await load();
  let body: { username?: string; address?: string; previous?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, reason: "Bad JSON" }, { status: 400 }); }
  const u = norm(body.username);
  const addr = String(body.address ?? "").toLowerCase();
  if (!USERNAME_RE.test(u) || RESERVED.has(u)) return NextResponse.json({ ok: false, reason: "Invalid username." }, { status: 400 });
  if (!isAddr(addr)) return NextResponse.json({ ok: false, reason: "Invalid address." }, { status: 400 });
  const owner = store.get(u);
  if (owner && owner !== addr) return NextResponse.json({ ok: false, reason: "Username taken." }, { status: 409 });
  // One username per address: release any previous name held by this address.
  for (const [k, v] of Array.from(store.entries())) if (v === addr && k !== u) store.delete(k);
  store.set(u, addr);
  await save();
  return NextResponse.json({ ok: true });
}
