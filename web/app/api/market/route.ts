export const runtime = "nodejs";
/**
 * Market and trade offers (lib/server/market.ts). The market (list, buy) is website-only: requests from the iPhone app
 * (its user agent carries "DiscipleApp/") are refused. Trade offers work everywhere.
 *
 * GET                      → { ok, listings, sales }            open listings (filters: item, kind, rar, series, trak=1, sort)
 * GET ?listing=<id>        → { ok, listing, sales }             one listing and its item's price history
 * GET ?terms=<id>&signer=  → { ok, terms, treasury, quote }     what to sign to buy it (seller's share, 7% to the treasury, network fee)
 * GET ?mine=1  (Bearer)    → { ok, listings, offers }           your listings and trade offers
 * GET ?pilot=<name|0x…>    → { ok, wallet }                     who a trade offer goes to
 * POST (Bearer) { op: "list", copy, price } | { op: "unlist", listing } | { op: "offer", to, give, want }
 *             | { op: "accept" | "decline" | "cancel", offer } | { op: "buy", listing, request }  (buy also needs privy-id-token)
 */
import { NextResponse } from "next/server";
import { isNativeAppUa } from "@/lib/native";
import type { MarketFilter, MarketSort } from "@/lib/market";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import {
  answerOffer, buyListing, buyTerms, listCopy, listingById, listings, makeOffer, myListings, offersOf, resolvePilot, salesOf, unlist,
  type BuyDeps,
} from "@/lib/server/market";
import { authenticate, bearer, privyEnv } from "@/lib/server/privyAuth";
import { ensureCatalog } from "@/lib/server/catalog";

export const dynamic = "force-dynamic";
const out = (status: number, b: Record<string, unknown>) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const hex = (v: unknown) => (typeof v === "string" && /^[a-f0-9]{12,16}$/.test(v) ? v : "");
const ids = (v: unknown) => (Array.isArray(v) ? v.slice(0, 20).map(hex).filter(Boolean) : []);
const APP_ONLY = "The market is on the website. Open disciple.vip to buy and sell.";
const ID_TOKEN_RE = /^[A-Za-z0-9_\-.]+$/;
function identityToken(req: Request): string | null {
  const h = req.headers.get("privy-id-token");
  if (h && ID_TOKEN_RE.test(h)) return h;
  const m = /(?:^|;\s*)privy-id-token=([^;]+)/.exec(req.headers.get("cookie") ?? "");
  return m && ID_TOKEN_RE.test(m[1]) ? m[1] : null;
}

async function who(req: Request) {
  const auth = await authenticate(bearer(req.headers), privyEnv());
  if (!auth.ok) return { res: out(auth.status, { ok: false, reason: "Sign in first." }) };
  const wallets = auth.user.wallets.map((x) => x.toLowerCase());
  const want = req.headers.get("x-wallet");
  const wallet = isAddr(want) && wallets.includes(want.toLowerCase()) ? want.toLowerCase() : wallets[0];
  if (!wallet) return { res: out(403, { ok: false, reason: "Your account needs a wallet." }) };
  return { wallet };
}

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `mkt:get:ip:${clientIp(req.headers)}`, 120, 60);
  if (!rl.ok) return out(429, { ok: false, reason: "Too many requests, try again shortly." });
  await ensureCatalog().catch(() => null);
  const q = new URL(req.url).searchParams;
  try {
    if (q.get("mine")) {
      const a = await who(req); if (a.res) return a.res;
      const [mine, offers] = await Promise.all([myListings(a.wallet), offersOf(a.wallet)]);
      return out(200, { ok: true, listings: mine, offers });
    }
    const pilot = q.get("pilot");
    if (pilot) { const w = await resolvePilot(pilot.slice(0, 64)); return w ? out(200, { ok: true, wallet: w }) : out(404, { ok: false, reason: "We couldn't find that pilot." }); }
    const lid = hex(q.get("listing"));
    if (lid) {
      const l = await listingById(lid);
      return l ? out(200, { ok: true, listing: l, sales: await salesOf(l.item, 30) }) : out(404, { ok: false, reason: "No such listing." });
    }
    const tid = hex(q.get("terms"));
    if (tid) {
      if (isNativeAppUa(req.headers.get("user-agent"))) return out(403, { ok: false, reason: APP_ONLY });
      const terms = await buyTerms(tid);
      if ("ok" in terms) return out(409, terms);
      const signer = q.get("signer");
      const { quoteGaslessWithdraw, marketTreasury } = await import("@/lib/server/gaslessWithdrawRelay");
      const treasury = marketTreasury();
      const quote = treasury
        ? await quoteGaslessWithdraw(isAddr(signer) ? { signer } : {}, { extraWithdraws: 1 }).catch((e) => ({ error: (e as Error).message }))
        : { error: "no treasury" };
      if ("error" in quote) return out(503, { ok: false, reason: "Buying is switched off right now. Try again later." });
      return out(200, { ok: true, terms, treasury, quote });
    }
    const sort = (["new", "price-asc", "price-desc", "burn-asc"] as const).find((x) => x === q.get("sort")) as MarketSort | undefined;
    const f: MarketFilter = {
      item: q.get("item") ?? undefined, kind: (["skin", "trail", "tag", "flourish"] as const).find((x) => x === q.get("kind")),
      rar: (["common", "uncommon", "rare", "epic", "legendary", "mythic"] as const).find((x) => x === q.get("rar")),
      series: q.get("series") ? Number(q.get("series")) : undefined, trak: q.get("trak") === "1", sort,
    };
    const [rows, sales] = await Promise.all([listings(f), salesOf(f.item, 20)]);
    return out(200, { ok: true, listings: rows, sales });
  } catch (e) {
    console.error("[market:get]", e);
    return out(503, { ok: false, reason: "The market isn't answering. Try again." });
  }
}

export async function POST(req: Request) {
  const rl = await hitLimit(kv(), `mkt:post:ip:${clientIp(req.headers)}`, 40, 60);
  if (!rl.ok) return out(429, { ok: false, reason: "Too many requests, try again shortly." });
  const a = await who(req); if (a.res) return a.res;
  await ensureCatalog().catch(() => null);
  let b: { op?: unknown; copy?: unknown; price?: unknown; listing?: unknown; offer?: unknown; to?: unknown; give?: unknown; want?: unknown; request?: unknown };
  try { b = await req.json(); } catch { return out(400, { ok: false, reason: "Bad JSON" }); }
  const app = isNativeAppUa(req.headers.get("user-agent"));
  try {
    if (b.op === "list") {
      if (app) return out(403, { ok: false, reason: APP_ONLY });
      const r = await listCopy(a.wallet, hex(b.copy), Number(b.price)); return out(r.ok ? 200 : 409, r);
    }
    if (b.op === "unlist") { const r = await unlist(a.wallet, hex(b.listing)); return out(r.ok ? 200 : 409, r); }
    if (b.op === "offer") { const r = await makeOffer(a.wallet, typeof b.to === "string" ? b.to : "", ids(b.give), ids(b.want)); return out(r.ok ? 200 : 409, r); }
    if (b.op === "accept" || b.op === "decline" || b.op === "cancel") { const r = await answerOffer(a.wallet, hex(b.offer), b.op); return out(r.ok ? 200 : 409, r); }
    if (b.op === "buy") {
      if (app) return out(403, { ok: false, reason: APP_ONLY });
      const idToken = identityToken(req);
      if (!idToken) return out(401, { ok: false, reason: "Sign in again to pay." });
      const relay = await import("@/lib/server/gaslessWithdrawRelay");
      const deps: BuyDeps = {
        parse: (raw) => relay.parseMarketBuyRequest(raw),
        treasury: () => relay.marketTreasury(),
        networkFee: async (signer) => BigInt((await relay.quoteGaslessWithdraw({ signer }, { extraWithdraws: 1 })).fee),
        relay: async (raw) => { const r = await relay.relayMarketBuy(raw, { idToken }); return { success: r.success, txHash: r.txHash }; },
      };
      const r = await buyListing(a.wallet, hex(b.listing), b.request, deps);
      return out(r.ok ? 200 : r.pending ? 202 : 409, r);
    }
    return out(400, { ok: false, reason: "Unknown action." });
  } catch (e) {
    console.error("[market]", e);
    return out(500, { ok: false, reason: "Something broke. Try again." });
  }
}
