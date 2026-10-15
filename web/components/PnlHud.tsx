"use client";

import { useEffect, useRef, useState } from "react";
import { fmtUsd } from "@/lib/config";
import { applyFill, emptyPosition, view, type Position } from "@/lib/pnl";

type Fill = { side: "buy" | "sell"; usd: number; mcap: number; supply: number; gas: number; at?: number };
type FlightWin = {
  __flight?: { S?: { confirmed?: { mcap?: number | null } }; source?: { supply?: number } };
  __entryMcap?: number;
  __pnl?: { fill(f: Fill): void; reset(): void };
};

const KEY = "disciple.pnl.";
const usd = (v: number) => (v < 0 ? "−" : v > 0 ? "+" : "") + "$" + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const amt = (v: number) => (v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "K" : v.toFixed(0));

/** Holdings / PnL HUD (PAPER ledger now; ProtocolClient.getPosition later). */
export default function PnlHud({ coin }: { coin: string }) {
  const [pos, setPos] = useState<Position>(emptyPosition);
  const [mcap, setMcap] = useState(0);
  const [supply, setSupply] = useState(1e9);
  const [open, setOpen] = useState(true);
  const [session, setSession] = useState(0);
  const posRef = useRef(pos);
  posRef.current = pos;

  useEffect(() => {
    try { const s = localStorage.getItem(KEY + coin); if (s) setPos(JSON.parse(s)); } catch { /* ignore */ }
    if (window.matchMedia?.("(max-width: 760px)").matches) setOpen(false);
  }, [coin]);

  useEffect(() => {
    const w = window as unknown as FlightWin;
    const onFill = (f: Fill) => {
      const price = f.mcap / (f.supply || 1e9);
      const next = applyFill(posRef.current, f.side, f.usd, price, f.gas, f.at);
      posRef.current = next;
      setPos(next);
      try { localStorage.setItem(KEY + coin, JSON.stringify(next)); } catch { /* ignore */ }
    };
    const h = (e: Event) => onFill((e as CustomEvent<Fill>).detail);
    addEventListener("disciple:paperfill", h);
    w.__pnl = { fill: onFill, reset: () => { posRef.current = emptyPosition(); setPos(posRef.current); localStorage.removeItem(KEY + coin); } };
    const iv = setInterval(() => {
      const m = w.__flight?.S?.confirmed?.mcap;
      if (m) setMcap(m);
      if (w.__flight?.source?.supply) setSupply(w.__flight.source.supply);
      // session total across rockets (sum of each coin's ledger at its last known mark is not available → realized + this coin's uPnL)
      let tot = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(KEY) && k !== KEY + coin) try { tot += JSON.parse(localStorage.getItem(k) || "{}").realized || 0; } catch { /* ignore */ }
      }
      setSession(tot);
    }, 500);
    return () => { removeEventListener("disciple:paperfill", h); clearInterval(iv); };
  }, [coin]);

  const price = mcap / supply;
  const v = view(pos, price, supply);
  useEffect(() => {
    (window as unknown as FlightWin).__entryMcap = v.size > 0 ? v.entryMcap : undefined;
  }, [v.size, v.entryMcap]);

  const up = v.uPnl >= 0;
  const c = (x: number) => (x > 0 ? "#8ff0c0" : x < 0 ? "#ff9fb8" : "#e8ecff");
  const row = { display: "flex", justifyContent: "space-between", gap: 10 } as const;

  return (
    <aside aria-label="Holdings and PnL" className="pnl-hud"
      style={{ position: "fixed", top: 212, left: "calc(var(--ap-rail-w, 64px) + 22px)", zIndex: 31, width: 260, padding: "8px 11px",
        borderRadius: 12, background: "rgba(10,12,28,.78)", backdropFilter: "blur(6px)", border: "1px solid rgba(255,231,163,.5)",
        color: "#fff7df", font: "11px ui-monospace,monospace" }}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={{ all: "unset", cursor: "pointer", ...row, width: "100%", color: "#ffe7a3", fontWeight: "bold" }}>
        <span>FUEL IN TANK <span style={{ color: "#ffb0c8" }}>· PAPER</span></span>
        <span style={{ color: c(v.uPnl) }}>{v.size > 0 ? `${up ? "▲" : "▼"} ${Math.abs(v.pnlPct).toFixed(1)}%` : "—"} {open ? "−" : "+"}</span>
      </button>
      {open && (
        <div style={{ marginTop: 5, lineHeight: 1.55 }}>
          <div style={row}><span>Holdings</span><span>{amt(v.size)} · {fmtUsd(v.valueUsd)}</span></div>
          <div style={row}><span>Avg entry</span><span>{v.size > 0 ? `$${v.avgEntryUsd.toPrecision(3)} · MC ${fmtUsd(v.entryMcap)}` : "—"}</span></div>
          <div style={row}><span>uPnL</span><span style={{ color: c(v.uPnl), fontWeight: "bold" }}>{usd(v.uPnl)}</span></div>
          <div style={row}><span>Realized</span><span style={{ color: c(v.realized) }}>{usd(v.realized)}</span></div>
          <div style={row}><span>Session (other rockets)</span><span style={{ color: c(session) }}>{usd(session)}</span></div>
          <div style={{ ...row, marginTop: 3, color: v.bonus > 1 ? "#ffd98a" : "rgba(220,228,255,.6)", fontWeight: "bold" }}>
            <span>HOLD BONUS</span><span>×{v.bonus.toFixed(2)}</span>
          </div>
        </div>
      )}
      <style jsx>{`
        @media (max-width: 760px) {
          .pnl-hud { left: 8px !important; top: auto !important; bottom: 60px; width: 200px !important; }
        }
      `}</style>
    </aside>
  );
}
