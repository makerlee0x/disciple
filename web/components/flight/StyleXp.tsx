"use client";
/**
 * Style XP reporter (lib/xp STYLE). The engine fires `disciple:stylefill` { mult, at } when a boost fills mid-trick; on a live
 * coin with a signed-in pilot this posts it to /api/xp/style (Privy session, no signature) and answers the engine with
 * `disciple:stylexp` { state: "confirming" | "capped" | "off", xp } for its tag. The cron pays it later only if the wallet's own
 * fill backs it. Simulator, replays and signed-out pilots get "off" (the callout still shows, no XP).
 */
import { useEffect } from "react";
import { privyAccessToken } from "@/lib/aa/sessionState";
import { onWallet } from "@/lib/walletState";
import { styleXp } from "@/lib/xp";

const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const reply = (detail: Record<string, unknown>) => dispatchEvent(new CustomEvent("disciple:stylexp", { detail }));

export default function StyleXp({ coin }: { coin: string | null }) {
  useEffect(() => {
    let wallet: string | null = null;
    const offWallet = onWallet((a) => { wallet = a ? a.toLowerCase() : null; });
    const on = async (e: Event) => {
      const d = (e as CustomEvent<{ mult?: unknown; at?: unknown }>).detail || {};
      const mult = Math.max(1, Math.floor(Number(d.mult) || 1));
      if (!isAddr(coin) || !wallet) { reply({ state: "off" }); return; }
      const token = await privyAccessToken();
      if (!token) { reply({ state: "off" }); return; }
      try {
        const r = await fetch("/api/xp/style", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ wallet, coin, mult, at: typeof d.at === "number" ? d.at : Date.now() }) });
        const j = (await r.json().catch(() => null)) as { ok?: boolean; capped?: boolean } | null;
        if (!r.ok || !j?.ok) { reply({ state: "off" }); return; }
        reply({ state: j.capped ? "capped" : "confirming", xp: styleXp(mult) });
      } catch { reply({ state: "off" }); }
    };
    addEventListener("disciple:stylefill", on);
    return () => { removeEventListener("disciple:stylefill", on); offWallet(); };
  }, [coin]);
  return null;
}
