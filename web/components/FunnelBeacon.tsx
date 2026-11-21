"use client";
/**
 * Funnel beacon (mounted once in AppShell, client-only). Fires the browser-side funnel steps; every call is
 * fire-and-forget and fails silently (lib/funnelClient.ts). Only listens to events the app already sends:
 *  - land: first page view in this browser; return_d1: back on the UTC day after landing
 *  - signin: the account is ready to trade (onWallet + canTransact; no change to lib/wallet.ts)
 *  - fund: first time the cash balance read on a trade screen is above $0 (disciple:cash)
 *  - first_trade: first BOOST or DUMP that lands (disciple:fillreceipt)
 *  - first_share: the first share anywhere, caught at the three ways the app shares (so new share buttons count without
 *    edits): the phone share sheet (navigator.share resolves), an X post link (x.com/twitter.com intent, opened or
 *    clicked), or a copied DISCIPLE link (clipboard text with disciple.vip, /r/, /vs/, /d/ or ?r=/?ref=). Copying a
 *    contract address doesn't count. The wrappers call the real function first and never change what it returns.
 * first_launch fires from the create page on a successful launch; first_play from the flight sim, duel and royale.
 */
import { useEffect } from "react";
import { canTransact, onWallet } from "@/lib/wallet";
import { maybeTrackReturn, trackFunnel } from "@/lib/funnelClient";

const INTENT = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/intent\//i;
const OUR_LINK = /disciple\.vip|\/(?:r|vs|d)\/[^\s/]+|[?&]r(?:ef)?=/i;

/** Wraps the share paths for first_share; returns the undo. Every wrapper is best-effort and transparent. */
function watchShares(): () => void {
  const shared = () => trackFunnel("first_share");
  const undo: (() => void)[] = [];
  const own = new Set<object>();
  /** put a method back: re-assign it if it was the object's own, otherwise drop our shadow so the prototype's shows */
  const restore = (o: object, k: string, f: unknown) => { if (own.has(o)) (o as Record<string, unknown>)[k] = f; else delete (o as Record<string, unknown>)[k]; };
  try {
    const nav = navigator as Navigator & { share?: (d?: ShareData) => Promise<void> };
    const share = nav.share;
    if (typeof share === "function") {
      if (Object.prototype.hasOwnProperty.call(nav, "share")) own.add(nav);
      nav.share = function (this: Navigator, d?: ShareData) { const p = share.call(this, d); p.then(shared, () => {}); return p; };
      undo.push(() => restore(nav, "share", share));
    }
  } catch { /* leave it */ }
  try {
    const clip = navigator.clipboard, write = clip?.writeText;
    if (clip && typeof write === "function") {
      if (Object.prototype.hasOwnProperty.call(clip, "writeText")) own.add(clip);
      clip.writeText = function (this: Clipboard, t: string) { const p = write.call(this, t); if (OUR_LINK.test(String(t))) p.then(shared, () => {}); return p; };
      undo.push(() => restore(clip, "writeText", write));
    }
  } catch { /* leave it */ }
  try {
    const open = window.open;
    window.open = function (this: Window, ...a: Parameters<Window["open"]>) { const w = open.apply(this, a); if (INTENT.test(String(a[0] ?? ""))) shared(); return w; } as Window["open"];
    undo.push(() => { window.open = open; });
  } catch { /* leave it */ }
  const onClick = (e: MouseEvent) => { const a = (e.target as Element | null)?.closest?.("a[href]"); if (a && INTENT.test(a.getAttribute("href") ?? "")) shared(); };
  document.addEventListener("click", onClick, true);
  undo.push(() => document.removeEventListener("click", onClick, true));
  return () => undo.forEach((f) => { try { f(); } catch { /* ignore */ } });
}

export default function FunnelBeacon() {
  useEffect(() => {
    maybeTrackReturn();
    trackFunnel("land");
    const offWallet = onWallet((a) => { if (a && canTransact()) trackFunnel("signin"); });
    const onCash = (e: Event) => { const usd = Number((e as CustomEvent<{ usd?: number | null }>).detail?.usd); if (usd > 0) trackFunnel("fund"); };
    const onFill = () => trackFunnel("first_trade");
    const offShares = watchShares();
    window.addEventListener("disciple:cash", onCash);
    window.addEventListener("disciple:fillreceipt", onFill);
    return () => { offWallet(); offShares(); window.removeEventListener("disciple:cash", onCash); window.removeEventListener("disciple:fillreceipt", onFill); };
  }, []);
  return null;
}
