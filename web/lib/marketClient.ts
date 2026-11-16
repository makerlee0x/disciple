"use client";
/** Browser side of /api/market (lib/server/market.ts). Writes carry the Privy session; nothing throws. */
import { useCallback, useEffect, useState } from "react";
import { privyAccessToken, privyIdentityToken } from "@/lib/aa/sessionState";
import { withBase, IS_STATIC_PREVIEW } from "@/lib/base-path";
import { COLLECTION_CHANGED_EVENT } from "@/lib/collectionClient";
import type { Listing, MarketAction, MarketFilter, Offer, Sale } from "@/lib/market";

export const MARKET_CHANGED_EVENT = "disciple:market-changed";
const changed = () => { dispatchEvent(new Event(MARKET_CHANGED_EVENT)); dispatchEvent(new Event(COLLECTION_CHANGED_EVENT)); };

export function useMarket(f: MarketFilter) {
  const [rows, setRows] = useState<Listing[] | null>(null);
  const [sales, setSales] = useState<Sale[]>([]);
  const key = JSON.stringify(f);
  const load = useCallback(() => {
    if (IS_STATIC_PREVIEW) return;
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(JSON.parse(key) as Record<string, unknown>)) if (v != null && v !== "" && v !== false) q.set(k, v === true ? "1" : String(v));
    fetch(withBase(`/api/market?${q}`), { cache: "no-store" }).then((r) => r.json())
      .then((j: { ok?: boolean; listings?: Listing[]; sales?: Sale[] }) => { if (j?.ok) { setRows(j.listings ?? []); setSales(j.sales ?? []); } else setRows([]); })
      .catch(() => setRows([]));
  }, [key]);
  useEffect(() => { load(); addEventListener(MARKET_CHANGED_EVENT, load); return () => removeEventListener(MARKET_CHANGED_EVENT, load); }, [load]);
  return { rows, sales, reload: load };
}

export async function listingDetail(id: string): Promise<{ listing: Listing; sales: Sale[] } | null> {
  try { const j = await (await fetch(withBase(`/api/market?listing=${id}`), { cache: "no-store" })).json(); return j?.ok ? { listing: j.listing, sales: j.sales ?? [] } : null; } catch { return null; }
}

/** Your listings and trade offers (signed in). */
export function useMine(wallet: string | null) {
  const [mine, setMine] = useState<{ listings: Listing[]; offers: Offer[] } | null>(null);
  const load = useCallback(async () => {
    if (!wallet || IS_STATIC_PREVIEW) return;
    const t = await privyAccessToken().catch(() => null);
    if (!t) return;
    fetch(withBase("/api/market?mine=1"), { cache: "no-store", headers: { authorization: `Bearer ${t}`, "x-wallet": wallet } }).then((r) => r.json())
      .then((j: { ok?: boolean; listings?: Listing[]; offers?: Offer[] }) => { if (j?.ok) setMine({ listings: j.listings ?? [], offers: j.offers ?? [] }); })
      .catch(() => {});
  }, [wallet]);
  useEffect(() => { void load(); const f = () => void load(); addEventListener(MARKET_CHANGED_EVENT, f); return () => removeEventListener(MARKET_CHANGED_EVENT, f); }, [load]);
  return { mine, reload: load };
}

export async function findPilot(v: string): Promise<string | null> {
  try { const j = await (await fetch(withBase(`/api/market?pilot=${encodeURIComponent(v)}`), { cache: "no-store" })).json(); return j?.ok ? j.wallet : null; } catch { return null; }
}

export type MarketResult = { ok: boolean; reason?: string; pending?: boolean; listing?: Listing; offer?: Offer };
async function post(wallet: string, a: MarketAction, extra: Record<string, string> = {}): Promise<MarketResult> {
  try {
    const t = await privyAccessToken();
    if (!t) return { ok: false, reason: "Sign in first." };
    const r = await fetch(withBase("/api/market"), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t}`, "x-wallet": wallet, ...extra }, body: JSON.stringify(a) });
    const j = (await r.json().catch(() => null)) as MarketResult | null;
    if (j?.ok) changed();
    return { ok: !!j?.ok, reason: j?.reason ?? (j?.ok ? undefined : "Couldn't reach the market. Try again."), pending: j?.pending, listing: j?.listing, offer: j?.offer };
  } catch { return { ok: false, reason: "Couldn't reach the market. Try again." }; }
}
export const marketAction = (wallet: string, a: Exclude<MarketAction, { op: "buy" }>) => post(wallet, a);

/** The network fee a buy adds on top of the price, raw USDG (for the confirm line). */
export async function buyQuote(id: string): Promise<{ priceRaw: bigint; networkRaw: bigint; decimals: number; seller: string } | { error: string }> {
  try {
    const { gaslessSigner } = await import("@/lib/wallet");
    const owner = gaslessSigner();
    if (!owner) return { error: "Sign in to buy." };
    const j = await (await fetch(withBase(`/api/market?terms=${id}&signer=${owner.address}`), { cache: "no-store" })).json();
    if (!j?.ok) return { error: j?.reason ?? "Couldn't price that. Try again." };
    return { priceRaw: BigInt(j.terms.priceRaw), networkRaw: BigInt(j.quote.fee), decimals: j.terms.decimals, seller: j.terms.seller };
  } catch { return { error: "Couldn't price that. Try again." }; }
}

/**
 * Buy a listing: one silent signature from your Disciple wallet (the same gasless USDG transfer the Cash panel uses). It pays
 * the seller the price minus 7% and covers the 7% and the network fee, then the server moves the copy to you.
 */
export async function buyListing(id: string): Promise<MarketResult> {
  try {
    const { gaslessSigner } = await import("@/lib/wallet");
    const owner = gaslessSigner();
    if (!owner) return { ok: false, reason: "Sign in to buy." };
    const j = await (await fetch(withBase(`/api/market?terms=${id}&signer=${owner.address}`), { cache: "no-store" })).json();
    if (!j?.ok) return { ok: false, reason: j?.reason ?? "That listing is gone." };
    const [{ parseWithdrawQuote, signGaslessWithdraw }, { publicClient }, { bigintToDecimal }] = await Promise.all([
      import("@/lib/trade/gaslessWithdrawClient"), import("@/lib/protocol-viem"), import("@/lib/trade/gaslessPermit2"),
    ]);
    const q = parseWithdrawQuote(j.quote);
    const net = q.fee, fee = net + BigInt(j.terms.feeRaw), amount = BigInt(j.terms.priceRaw) + net;
    const req = await signGaslessWithdraw(publicClient() as never, owner, { amount, destination: j.terms.seller, quote: { ...q, fee } });
    const idToken = await privyIdentityToken().catch(() => null);
    return post(owner.address, { op: "buy", listing: id, request: JSON.parse(JSON.stringify(req, bigintToDecimal)) }, idToken ? { "privy-id-token": idToken } : {});
  } catch (e) {
    const { playerError } = await import("@/lib/playerError");
    return { ok: false, reason: playerError(e) };
  }
}
