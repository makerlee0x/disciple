/** Sponsorship is disabled on every chain. No signer, quote, RPC, or env dependency. */
import { NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(_req: Request) {
  return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "gas sponsorship disabled" } }, { status: 410 });
}
