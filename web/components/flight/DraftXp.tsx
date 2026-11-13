"use client";
/**
 * Drafting XP reporter (lib/xp DRAFT). The engine fires `disciple:slingshot` { wingmen, at } when the Draft meter fills; on a
 * live coin with a signed-in pilot this posts it to /api/xp/draft (Privy session, no signature) and answers the engine with
 * `disciple:slingshotxp` { state: "confirming" | "capped" | "off", xp, paidToday, perDay } so it can show the right tag.
 * The cron pays it later only if the fills back it up. Simulator, replays and signed-out pilots get "off" (no XP).
 */
import { useEffect } from "react";
import { privyAccessToken } from "@/lib/aa/sessionState";
import { onWallet } from "@/lib/walletState";
import { DRAFT } from "@/lib/xp";

const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const reply = (detail: Record<string, unknown>) => dispatchEvent(new CustomEvent("disciple:slingshotxp", { detail: { xp: DRAFT.xp, perDay: DRAFT.perDay, ...detail } }));

export default function DraftXp({ coin }: { coin: string | null }) {
  useEffect(() => {
    let wallet: string | null = null;
    const offWallet = onWallet((a) => { wallet = a ? a.toLowerCase() : null; });
    const on = async (e: Event) => {
      const d = (e as CustomEvent<{ wingmen?: unknown; at?: unknown }>).detail || {};
      const wingmen = Array.isArray(d.wingmen) ? d.wingmen.filter(isAddr) : [];
      if (!isAddr(coin) || !wallet || !wingmen.length) { reply({ state: "off" }); return; }
      const token = await privyAccessToken();
      if (!token) { reply({ state: "off" }); return; }
      try {
        const r = await fetch("/api/xp/draft", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ wallet, coin, wingmen, at: typeof d.at === "number" ? d.at : Date.now() }) });
        const j = (await r.json().catch(() => null)) as { ok?: boolean; capped?: boolean; paidToday?: number; queuedToday?: number } | null;
        if (!r.ok || !j?.ok) { reply({ state: "off" }); return; }
        reply({ state: j.capped ? "capped" : "confirming", paidToday: j.paidToday ?? 0, queuedToday: j.queuedToday ?? 0 });
      } catch { reply({ state: "off" }); }
    };
    addEventListener("disciple:slingshot", on);
    return () => { removeEventListener("disciple:slingshot", on); offWallet(); };
  }, [coin]);
  return null;
}
