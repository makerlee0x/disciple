"use client";
/**
 * "Sold" (maker 2026-11-18: sellers need to hear their market item sold, "otherwise how would they know"). When a pilot
 * opens the site (or comes back to the tab) and one of their listings sold since they last looked, a toast names it and
 * what landed in Cash. View opens the Flight log. Push alerts (kind "market") cover the times they aren't here.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { privyAccessToken } from "@/lib/aa/sessionState";
import { IS_STATIC_PREVIEW, withBase } from "@/lib/base-path";
import { itemById } from "@/lib/collection";
import { sellerCents, type Listing } from "@/lib/market";
import { TOPBAR_POPOVER_EVENT } from "./WelcomeToast";

const SEEN = (w: string) => `disciple.sold.seen.${w}`;
const EVERY_MS = 60_000;
type Sold = { name: string; usd: number; more: number };

export default function SoldToast({ wallet }: { wallet: string | null }) {
  const [sold, setSold] = useState<Sold | null>(null);
  useEffect(() => {
    if (!wallet || IS_STATIC_PREVIEW) return;
    const w = wallet.toLowerCase();
    let alive = true, last = 0;
    const check = async () => {
      if (document.visibilityState !== "visible" || Date.now() - last < EVERY_MS) return;
      last = Date.now();
      const t = await privyAccessToken().catch(() => null);
      if (!t || !alive) return;
      const j = await fetch(withBase("/api/market?mine=1"), { cache: "no-store", headers: { authorization: `Bearer ${t}`, "x-wallet": w } })
        .then((r) => r.json()).catch(() => null) as { ok?: boolean; listings?: Listing[] } | null;
      if (!alive || !j?.ok) return;
      let seen = 0;
      try { seen = Number(localStorage.getItem(SEEN(w)) || 0); } catch { return; }
      const fresh = (j.listings ?? []).filter((l) => l.state === "sold" && l.seller.toLowerCase() === w && (l.soldAt ?? 0) > seen).sort((a, b) => (b.soldAt ?? 0) - (a.soldAt ?? 0));
      const newest = Math.max(seen, ...fresh.map((l) => l.soldAt ?? 0), seen ? 0 : Date.now());
      try { localStorage.setItem(SEEN(w), String(newest)); } catch { /* storage blocked */ }
      // first look on this browser: start the clock, don't replay old sales
      if (!seen || !fresh.length) return;
      setSold({ name: itemById(fresh[0].item)?.name ?? "Your item", usd: fresh.reduce((s, l) => s + sellerCents(l.price), 0) / 100, more: fresh.length - 1 });
    };
    void check();
    const onVis = () => void check();
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; document.removeEventListener("visibilitychange", onVis); };
  }, [wallet]);
  useEffect(() => {
    if (!sold) return;
    const t = setTimeout(() => setSold(null), 10_000);
    const hide = () => setSold(null);
    addEventListener(TOPBAR_POPOVER_EVENT, hide);
    return () => { clearTimeout(t); removeEventListener(TOPBAR_POPOVER_EVENT, hide); };
  }, [sold]);
  if (!sold) return null;
  return (
    <div className="am-toast" role="status" data-testid="sold-toast">
      <div className="am-tbody">
        <b>Sold: {sold.name}{sold.more > 0 ? ` +${sold.more}` : ""}</b>
        <span>${sold.usd.toFixed(2)} landed in your Cash.</span>
        <div className="am-tacts">
          <Link href="/profile#hg-log" className="r2-gold" onClick={() => setSold(null)}>View</Link>
          <button type="button" className="r2-btn" onClick={() => setSold(null)}>Close</button>
        </div>
      </div>
    </div>
  );
}
