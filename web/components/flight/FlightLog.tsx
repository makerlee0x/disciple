"use client";
/**
 * FLIGHT LOG (approved prototype "Flight feel", maker Nov 13): leaving a live rocket you boosted this flight (✕ or "Back to
 * the lobby") shows how the flight went before you go. Peak, bombs survived, wingmen, slingshots and XP come from
 * /api/flight/log (indexed fills only, lib/flightLog.ts); Bag now and Banked are the YOUR BAG card's own numbers. Share opens
 * the trade share card for this rocket. Esc / Back to flight = stay. The simulator keeps its "Leave the mission?" confirm.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ShareModal from "@/components/share/ShareModal";
import { HUD, hudLabel } from "@/lib/game/hudStyle";
import { fmtMcap, fmtMoney } from "@/lib/share/format";
import type { FlightLog as Log } from "@/lib/flightLog";
import { usePilotWallet } from "@/lib/xpClient";

const LEAVE_SEL = '[data-testid="flight-leave"], [data-testid="flight-menu-lobby"]';
const titleCase = (s: string) => s.toLowerCase().replace(/(^|\s)\S/g, (a) => a.toUpperCase());
type Bag = { valueUsd?: number; realized?: number } | null;

export default function FlightLog({ coin, ticker, practice }: { coin: string | null; ticker: string; practice: boolean }) {
  const router = useRouter();
  const wallet = usePilotWallet();
  const since = useRef(Date.now());
  const boarded = useRef(false);
  const [href, setHref] = useState<string | null>(null);
  const [log, setLog] = useState<Log | null>(null);
  const [bag, setBag] = useState<Bag>(null);
  const [share, setShare] = useState(false);
  const [failed, setFailed] = useState(false);
  const st = useRef({ wallet, coin, practice, share }); st.current = { wallet, coin, practice, share };

  // boarded this flight: YOUR BAG showed a position at some point
  useEffect(() => {
    const on = (e: Event) => { if (((e as CustomEvent<{ size?: number }>).detail?.size ?? 0) > 0) boarded.current = true; };
    addEventListener("disciple:position", on);
    return () => removeEventListener("disciple:position", on);
  }, []);

  // ✕ / Back to the lobby: open the log instead (capture phase, before next/link)
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const { wallet: w, coin: c, practice: p } = st.current;
      if (p || !w || !c || !boarded.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const a = (e.target as Element | null)?.closest?.(LEAVE_SEL) as HTMLAnchorElement | null;
      if (!a) return;
      e.preventDefault(); e.stopPropagation();
      setHref(a.href || "/");
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  const open = !!href;
  const stay = useCallback(() => { setHref(null); setShare(false); }, []);
  const leave = useCallback(() => {
    const h = href || "/"; setHref(null);
    try { const u = new URL(h, location.href); if (u.origin === location.origin) { router.push(u.pathname + u.search + u.hash); return; } } catch { /* */ }
    location.assign(h);
  }, [href, router]);

  // load the numbers when it opens; pause the game keys while it is up
  useEffect(() => {
    if (!open || !wallet || !coin) return;
    setLog(null); setFailed(false);
    setBag(((window as unknown as { __pnlView?: Bag }).__pnlView) ?? null);
    fetch(`/api/flight/log?wallet=${wallet}&coin=${coin.toLowerCase()}&since=${since.current}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null)).then((l: Log | null) => { setLog(l); setFailed(!l); }).catch(() => setFailed(true));
    dispatchEvent(new CustomEvent("disciple:menu", { detail: { open: true } }));
    const k = (e: KeyboardEvent) => {
      if (st.current.share) return;   // the share modal owns its keys
      if (e.code === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); stay(); return; }
      if ((e.target as HTMLElement | null)?.closest?.('[data-testid="flight-log"]')) return;
      e.stopImmediatePropagation();
    };
    addEventListener("keydown", k, true);
    return () => { removeEventListener("keydown", k, true); dispatchEvent(new CustomEvent("disciple:menu", { detail: { open: false } })); };
  }, [open, wallet, coin, stay]);

  if (!open || !wallet || !coin) return null;
  const wait = failed ? "—" : "…";
  const n = (v: number | undefined) => (log ? String(v ?? 0) : wait);
  const stats: [string, string][] = [
    ["Bombs survived", n(log?.bombsSurvived)],
    ["Wingmen", n(log?.wingmen)],
    ["Slingshots", n(log?.slingshots)],
    ["XP earned", log ? `+${log.xp}` : wait],
    ["Bag now", bag?.valueUsd != null ? fmtMoney(bag.valueUsd).replace(/^\+/, "") : "$0.00"],
    ["Banked", fmtMoney(bag?.realized ?? 0)],
  ];
  const title = log?.peakMcap ? `Peak ${fmtMcap(log.peakMcap)} · ${titleCase(log.peakTier || "")}` : log ? "You rode it from Launch Pad" : failed ? "Flight log" : "Reading your flight…";
  const btn: React.CSSProperties = { all: "unset", cursor: "pointer", boxSizing: "border-box", textAlign: "center", padding: "12px 16px", borderRadius: HUD.control, font: `800 18px/1 ${HUD.game}`, letterSpacing: ".04em" };

  return (
    <>
      <div data-testid="flight-log" role="dialog" aria-modal="true" aria-labelledby="flog-title"
        onPointerDown={(e) => { if (e.target === e.currentTarget) stay(); }}
        style={{ position: "fixed", inset: 0, zIndex: 80, display: "grid", placeItems: "center", background: "rgba(6,7,16,.6)", backdropFilter: "blur(3px)" }}>
        <div style={{ width: "min(420px, calc(100% - 32px))", boxSizing: "border-box", padding: 20, display: "flex", flexDirection: "column", gap: 14,
          borderRadius: HUD.radius, background: "rgba(18,19,39,.94)", border: `1px solid ${HUD.borderGold}`, boxShadow: "0 24px 70px rgba(0,0,0,.6)", color: HUD.text, fontFamily: HUD.ui }}>
          <span style={{ ...hudLabel, fontSize: 12 }}>Flight log{ticker ? ` · $${ticker}` : ""}</span>
          <h2 id="flog-title" style={{ margin: 0, font: `800 34px/1 ${HUD.game}`, letterSpacing: ".02em", textWrap: "balance" }}>{title}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {stats.map(([k, v]) => (
              <div key={k} style={{ padding: "10px 10px 9px", borderRadius: 10, background: "rgba(255,255,255,.04)", border: `1px solid ${HUD.border}`, display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ ...hudLabel, fontSize: 10.5 }}>{k}</span>
                <b style={{ font: `800 22px/1 ${HUD.game}`, color: k === "XP earned" ? HUD.gold : k === "Banked" ? ((bag?.realized ?? 0) < 0 ? HUD.down : HUD.up) : HUD.text }}>{v}</b>
              </div>
            ))}
          </div>
          <p style={{ margin: 0, font: `500 12px/1.4 ${HUD.ui}`, color: HUD.dim }}>Every number here comes from the chain. XP from this flight lands within a few minutes.</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <button type="button" data-testid="flight-log-share" onClick={() => setShare(true)} style={{ ...btn, background: "transparent", color: HUD.champagne, border: `1px solid ${HUD.borderGold}` }}>SHARE</button>
            <button type="button" data-testid="flight-log-leave" onClick={leave} style={{ ...btn, background: HUD.gold, color: HUD.ink }}>LEAVE</button>
          </div>
          <button type="button" data-testid="flight-log-back" onClick={stay} autoFocus style={{ all: "unset", cursor: "pointer", alignSelf: "center", font: `600 13px/1 ${HUD.ui}`, color: HUD.dim }}>Back to flight</button>
        </div>
      </div>
      {share && <ShareModal target={{ coin, ticker, wallet, username: null }} onClose={() => setShare(false)} />}
    </>
  );
}
