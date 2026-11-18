export const runtime = "nodejs";
/**
 * Solana JSON-RPC proxy for /mint and /admin/mint, so the Helius key never reaches the browser. Only the methods a
 * Candy Machine mint / setup needs; per-IP limit. Single requests only (no batches).
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { heliusUrl } from "@/lib/server/nft/chain";

export const dynamic = "force-dynamic";
const ALLOWED = new Set([
  "getLatestBlockhash", "getAccountInfo", "getMultipleAccounts", "getBalance", "getMinimumBalanceForRentExemption",
  "sendTransaction", "simulateTransaction", "getSignatureStatuses", "getSlot", "getBlockHeight", "getRecentPrioritizationFees",
  "getFeeForMessage", "getEpochInfo", "getGenesisHash", "isBlockhashValid", "getTransaction",
]);
export async function POST(req: Request) {
  const url = heliusUrl();
  if (!url) return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "rpc not configured" } }, { status: 503 });
  const rl = await hitLimit(kv(), `solrpc:ip:${clientIp(req.headers)}`, 240, 60);
  if (!rl.ok) return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: 429, message: "Too many requests" } }, { status: 429 });
  let b: { method?: unknown; id?: unknown };
  try { b = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (!b || Array.isArray(b) || typeof b.method !== "string" || !ALLOWED.has(b.method))
    return NextResponse.json({ jsonrpc: "2.0", id: (b as { id?: unknown })?.id ?? null, error: { code: -32601, message: "method not allowed" } }, { status: 403 });
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b), cache: "no-store", signal: AbortSignal.timeout(20000) });
  return new NextResponse(await r.text(), { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
