"use client";
/**
 * Funnel beacon (mounted once in AppShell, client-only). Fires the browser-side funnel steps; every call is
 * fire-and-forget and fails silently (lib/funnelClient.ts). Only listens to events the app already sends:
 *  - land: first page view in this browser; return_d1: back on the UTC day after landing
 *  - signin: the account is ready to trade (onWallet + canTransact; no change to lib/wallet.ts)
 *  - fund: first time the cash balance read on a trade screen is above $0 (disciple:cash)
 *  - first_trade: first BOOST or DUMP that lands (disciple:fillreceipt)
 * first_launch fires from the create page on a successful launch.
 */
import { useEffect } from "react";
import { canTransact, onWallet } from "@/lib/wallet";
import { maybeTrackReturn, trackFunnel } from "@/lib/funnelClient";

export default function FunnelBeacon() {
  useEffect(() => {
    maybeTrackReturn();
    trackFunnel("land");
    const offWallet = onWallet((a) => { if (a && canTransact()) trackFunnel("signin"); });
    const onCash = (e: Event) => { const usd = Number((e as CustomEvent<{ usd?: number | null }>).detail?.usd); if (usd > 0) trackFunnel("fund"); };
    const onFill = () => trackFunnel("first_trade");
    window.addEventListener("disciple:cash", onCash);
    window.addEventListener("disciple:fillreceipt", onFill);
    return () => { offWallet(); window.removeEventListener("disciple:cash", onCash); window.removeEventListener("disciple:fillreceipt", onFill); };
  }, []);
  return null;
}
