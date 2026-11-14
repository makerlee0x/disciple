"use client";
/**
 * Desktop Pilot chart (maker 2026-11-14 picked board C "Trader's right column" on the desktop ideas page
 * https://claude.ai/artifact/6bL2Ydgd7GwgxPniaQ7XSv): the phone flight's chart card, big, at the top of the right column.
 * The crew feed (GameChat, Pilot) starts under it via --ap-pilot-chart-h. Pro keeps its DexChart; phones keep PhoneHud's copy.
 * Click the card to make it taller; the 1M / 5M / 1H pick and the size are remembered on this device.
 */
import { useEffect, useState } from "react";
import PhoneChart from "./PhoneChart";
import { useHudMode } from "@/lib/game/hudMode";
import { isPhoneUI } from "@/lib/game/cardLayoutStore";

export const DESK_CHART_W = 420, DESK_CHART_H = 270, DESK_CHART_BIG_H = 400;
const KEY = "disciple.deskchart.v1";
type PnlView = { entryMcap?: number; size?: number } | null;

export default function DeskChart({ ticker }: { ticker: string }) {
  const hud = useHudMode();
  const [phone, setPhone] = useState(true);
  const [tf, setTf] = useState(0);
  const [big, setBig] = useState(false);
  const [entry, setEntry] = useState<number | null>(null);
  useEffect(() => { const f = () => setPhone(isPhoneUI()); f(); addEventListener("resize", f); return () => removeEventListener("resize", f); }, []);
  useEffect(() => { try { const v = JSON.parse(localStorage.getItem(KEY) || "{}"); if (v.tf >= 0 && v.tf <= 2) setTf(v.tf); if (v.big) setBig(true); } catch { /* private mode */ } }, []);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify({ tf, big })); } catch { /* private mode */ } }, [tf, big]);
  useEffect(() => {
    const read = (d: PnlView) => setEntry(d && (d.size ?? 0) > 0 && (d.entryMcap ?? 0) > 0 ? d.entryMcap! : null);
    read((window as unknown as { __pnlView?: PnlView }).__pnlView ?? null);
    const h = (e: Event) => read((e as CustomEvent<PnlView>).detail ?? null);
    addEventListener("disciple:pnlview", h); return () => removeEventListener("disciple:pnlview", h);
  }, []);
  const on = !phone && hud === "pilot";
  const h = big ? DESK_CHART_BIG_H : DESK_CHART_H;
  // the Pilot crew feed starts under this card
  useEffect(() => { const root = document.documentElement; root.style.setProperty("--ap-pilot-chart-h", on ? `${h + 14}px` : "0px");
    root.style.setProperty("--ap-pilot-feed-w", on ? `min(${DESK_CHART_W}px, 34vw)` : "300px");
    if (on) root.dataset.deskChart = "1"; else delete root.dataset.deskChart;   // the feed under the chart shows its 4 newest rows
    return () => { root.style.removeProperty("--ap-pilot-chart-h"); root.style.removeProperty("--ap-pilot-feed-w"); delete root.dataset.deskChart; }; }, [on, h]);
  if (!on) return null;
  return (
    <div className="dsk-chart" data-testid="desk-chart" style={{ position: "fixed", right: 20, top: "calc(var(--ap-hud-rt, 58px) + 34px)", width: `min(${DESK_CHART_W}px, 34vw)`, height: h, zIndex: 33, transition: "height .25s ease" }}>
      <style>{`
        .dsk-chart .pc { position: absolute; inset: 0; border-radius: 16px; background: rgba(12,13,28,.92); border: 1px solid rgba(255,255,255,.14); box-shadow: 0 12px 30px rgba(0,0,0,.35); overflow: hidden; cursor: zoom-in; box-sizing: border-box; }
        .dsk-chart .pc[data-big="1"] { cursor: zoom-out; }
        .dsk-chart .pc canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
        .dsk-chart .pc-lab { position: absolute; left: 14px; top: 12px; display: flex; gap: 8px; align-items: baseline; font: 700 14px/1 'Barlow Condensed', 'Arial Narrow', sans-serif; letter-spacing: 1.4px; color: rgba(215,217,228,.85); pointer-events: none; }
        .dsk-chart .pc-lab b { display: none; }
        .dsk-chart .pc-tf { position: absolute; right: 10px; top: 8px; display: flex; gap: 4px; }
        .dsk-chart .pc-tf button { all: unset; box-sizing: border-box; min-width: 34px; height: 26px; padding: 0 9px; border-radius: 8px; text-align: center; background: rgba(255,255,255,.08); color: rgba(215,217,228,.85); font: 800 14px/26px 'Barlow Condensed', 'Arial Narrow', sans-serif; letter-spacing: .4px; cursor: pointer; }
        .dsk-chart .pc-tf button.on { background: #F2F3F7; color: #121327; }
        .dsk-chart .pc-tf button:focus-visible { outline: 2px solid #F2C14E; }
        html[data-desk-chart="1"] [data-testid="chat-dock"][data-hud="pilot"] [data-testid="chat-list"] > :nth-child(n+5) { display: none !important; }
      `}</style>
      <PhoneChart tf={tf} onTf={setTf} big={big} onBig={() => setBig((b) => !b)} entry={entry} ticker={ticker} badge={null} />
    </div>
  );
}
