export const runtime = "nodejs";
/** GET → { supply, minted, price, limit, candyMachine, lut } for /mint. minted = every disciple so far (null = unknown). */
import { NextResponse } from "next/server";
import { liveMachine, mintedCount } from "@/lib/server/nft/machine";
import { DISCIPLE_SUPPLY, MINT_LIMIT, MINT_PRICE_SOL } from "@/lib/nft/config";

export const dynamic = "force-dynamic";
export async function GET() {
  const [minted, live] = await Promise.all([mintedCount().catch(() => null), liveMachine()]);
  return NextResponse.json({ supply: DISCIPLE_SUPPLY, minted, price: MINT_PRICE_SOL, limit: MINT_LIMIT, candyMachine: live?.candyMachine ?? null, lut: live?.lut ?? null },
    { headers: { "cache-control": "public, max-age=10, s-maxage=10" } });
}
