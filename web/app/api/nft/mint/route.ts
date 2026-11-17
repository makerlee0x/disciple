export const runtime = "nodejs";
/** GET → { supply, minted, price, limit, candyMachine, lut } for /mint. minted = every disciple so far (null = unknown). */
import { NextResponse } from "next/server";
import { liveMachine, mintedCount } from "@/lib/server/nft/machine";
import { heliusKeyShape, lastReadError, mintedItems, solanaConfigured } from "@/lib/server/nft/chain";
import { DISCIPLE_SUPPLY, MINT_LIMIT, MINT_PRICE_SOL } from "@/lib/nft/config";

export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  // ?authorities=1 → how many minted disciples each update authority controls (who can change their metadata)
  if (new URL(req.url).searchParams.get("authorities")) {
    const m = await mintedItems();
    return NextResponse.json(m ? { minted: m.count, authorities: m.authorities } : { error: lastReadError || "reads off" }, { headers: { "cache-control": "no-store" } });
  }
  const [minted, live] = await Promise.all([mintedCount().catch(() => null), liveMachine()]);
  return NextResponse.json({ supply: DISCIPLE_SUPPLY, minted, price: MINT_PRICE_SOL, limit: MINT_LIMIT, candyMachine: live?.candyMachine ?? null, lut: live?.lut ?? null,
    // reads: "off" = no HELIUS_API_KEY in this deployment; "error: …" = Helius answered with an error
    reads: !solanaConfigured() ? "off" : minted === null ? `error: ${lastReadError || "unknown"} (key: ${heliusKeyShape()})` : "ok" },
    { headers: { "cache-control": "public, max-age=10, s-maxage=10" } });
}
