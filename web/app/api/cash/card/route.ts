export const runtime = "nodejs";
/**
 * POST (Bearer, x-wallet?) { usd } → { ok, address, chain, asset, outUsd }   where the card checkout pays: a Relay deposit
 * address that turns USDC on Base into USDG cash in the signed-in pilot's own wallet (lib/server/cardDeposit).
 * Mainnet only: Relay has no Robinhood Chain testnet route.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { authenticate, bearer, privyEnv } from "@/lib/server/privyAuth";
import { BASE_ID, BASE_USDC, CardDepositError, cardDepositAddress } from "@/lib/server/cardDeposit";

export const dynamic = "force-dynamic";
export const maxDuration = 20;
const out = (status: number, b: Record<string, unknown>) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

export async function POST(req: Request) {
  if (process.env.NEXT_PUBLIC_CHAIN_ID !== "4663") return out(409, { ok: false, reason: "Card checkout is mainnet only." });
  const rl = await hitLimit(kv(), `cash:card:ip:${clientIp(req.headers)}`, 10, 60);
  if (!rl.ok) return out(429, { ok: false, reason: "Too many requests, try again shortly." });
  const auth = await authenticate(bearer(req.headers), privyEnv());
  if (!auth.ok) return out(auth.status, { ok: false, reason: "Sign in first." });
  const wallets = auth.user.wallets.map((x) => x.toLowerCase());
  // the cash must land in a wallet this login owns: never fall back to another one
  const want = req.headers.get("x-wallet");
  const wallet = isAddr(want) && wallets.includes(want.toLowerCase()) ? want.toLowerCase() : null;
  if (!wallet) return out(403, { ok: false, reason: "That cash address isn't on this login." });
  const b = (await req.json().catch(() => ({}))) as { usd?: unknown };
  try {
    const d = await cardDepositAddress(wallet, Number(b.usd));
    return out(200, { ok: true, address: d.address, chain: `eip155:${BASE_ID}`, asset: BASE_USDC, outUsd: d.outUsd });
  } catch (e) {
    if (e instanceof CardDepositError) return out(e.status, { ok: false, reason: e.message });
    console.error("[cash:card]", e);
    return out(503, { ok: false, reason: "Card checkout isn't available right now." });
  }
}
