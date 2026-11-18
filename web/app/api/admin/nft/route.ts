export const runtime = "nodejs";
/**
 * /admin/mint backend (ADMIN_EMAILS). GET → { minted, takenNumbers: every minted disciple's #, unnamed, candyMachine }.
 * POST { candyMachine: "<address>" | null, lut? } → saves / clears the live machine (+ lookup table) that /mint mints from.
 */
import { NextResponse } from "next/server";
import { authenticateAdmin, bearer, privyEnv } from "@/lib/server/privyAuth";
import { mintedItems } from "@/lib/server/nft/chain";
import { liveMachine, setLiveMachine } from "@/lib/server/nft/machine";
import { isSolAddress } from "@/lib/nft/config";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const out = (s: number, b: unknown) => NextResponse.json(b, { status: s, headers: { "cache-control": "no-store" } });

export async function GET(req: Request) {
  const a = await authenticateAdmin(bearer(req.headers), privyEnv(), process.env.ADMIN_EMAILS);
  if (!a.ok) return out(a.status, { error: a.reason });
  const m = await mintedItems();
  if (!m) return out(503, { error: "Solana reads are off: set HELIUS_API_KEY in Vercel." });
  const live = await liveMachine();
  return out(200, { minted: m.count, used: m.items, unknown: m.unknown, takenNumbers: m.numbers, unnamed: m.unnamed, candyMachine: live?.candyMachine ?? null, lut: live?.lut ?? null });
}
export async function POST(req: Request) {
  const a = await authenticateAdmin(bearer(req.headers), privyEnv(), process.env.ADMIN_EMAILS);
  if (!a.ok) return out(a.status, { error: a.reason });
  let b: { candyMachine?: unknown; lut?: unknown };
  try { b = await req.json(); } catch { return out(400, { error: "Bad JSON" }); }
  const id = b?.candyMachine === null ? null : String(b?.candyMachine ?? "");
  const lut = b?.lut ? String(b.lut) : null;
  if (id !== null && !isSolAddress(id)) return out(400, { error: "Not a Solana address." });
  if (lut !== null && !isSolAddress(lut)) return out(400, { error: "Lookup table isn't a Solana address." });
  await setLiveMachine(id ? { candyMachine: id, lut } : null);
  const live = await liveMachine();
  return out(200, { ok: true, candyMachine: live?.candyMachine ?? null, lut: live?.lut ?? null });
}
