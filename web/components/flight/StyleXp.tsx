"use client";
/**
 * STYLE FILL reporter (lib/xp STYLE), the twin of DraftXp. The engine fires `disciple:stylefill` { at, combo, kind } when your BOOST
 * fills within a few seconds of a spin / flip; on a live coin with a signed-in pilot this posts it to /api/xp/style and answers the
 * engine with `disciple:stylexp` { state: "confirming" | "capped" | "off", xp }. The cron pays it later only if the fill is real.
 * Free play, replays and signed-out pilots get "off" (the callout still shows, no XP).
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
      const d = (e as CustomEvent<{ at?: unknown; combo?: unknown }>).detail || {};
      const combo = typeof d.combo === "number" ? d.combo : 1, xp = styleXp(combo);
      if (!isAddr(coin) || !wallet) { reply({ state: "off", xp }); return; }
      const token = await privyAccessToken();
      if (!token) { reply({ state: "off", xp }); return; }
      try {
        const r = await fetch("/api/xp/style", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ wallet, coin, combo, at: typeof d.at === "number" ? d.at : Date.now() }) });
        const j = (await r.json().catch(() => null)) as { ok?: boolean; capped?: boolean; xp?: number } | null;
        if (!r.ok || !j?.ok) { reply({ state: "off", xp }); return; }
        reply({ state: j.capped ? "capped" : "confirming", xp: j.xp ?? xp });
      } catch { reply({ state: "off", xp }); }
    };
    addEventListener("disciple:stylefill", on);
    return () => { removeEventListener("disciple:stylefill", on); offWallet(); };
  }, [coin]);
  return null;
}
