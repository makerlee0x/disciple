/**
 * POST /api/bundler — server-side proxy to the Alchemy RH-testnet bundler.
 * Alchemy answers 401 to browser requests (Origin header) from domains not allowlisted on the app, and this keeps the
 * key off the client. Only ERC-4337 methods are forwarded.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set([
  "eth_chainId", "eth_supportedEntryPoints", "eth_sendUserOperation", "eth_estimateUserOperationGas",
  "eth_getUserOperationReceipt", "eth_getUserOperationByHash", "rundler_maxPriorityFeePerGas",
  "alchemy_requestGasAndPaymasterAndData",
]);

export async function POST(req: Request) {
  const key = process.env.ALCHEMY_API_KEY || process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  if (!key) return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "bundler not configured" } }, { status: 503 });
  let body: { method?: string; id?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 }); }
  if (Array.isArray(body) || !body.method || !ALLOWED.has(body.method))
    return NextResponse.json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32601, message: "method not allowed" } }, { status: 400 });
  const r = await fetch(`https://robinhood-testnet.g.alchemy.com/v2/${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return new NextResponse(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
}
