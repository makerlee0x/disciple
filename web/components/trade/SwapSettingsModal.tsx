"use client";

import { useEffect, useState } from "react";
import { MODES } from "@/lib/config";
import { AUTO_SLIPPAGE_PCT, DEFAULT_SELLS, type SellSlot, type SwapSettings } from "@/lib/trade/swapSettings";

/** Swap settings modal (gear in the ammo panel's SELL row). Styled after the reference: dark card, 4-up preset grids, Reset, Auto/Custom, Save. */
export default function SwapSettingsModal({ initial, autoUsd, tier, scope, onSave, onClose }: {
  initial: SwapSettings; autoUsd: number[]; tier: number | null; scope: string;
  onSave: (s: SwapSettings, tier: number | null) => void; onClose: () => void;
}) {
  const [buy, setBuy] = useState<string[]>((initial.buy || autoUsd).map(String));
  const [buyAuto, setBuyAuto] = useState(!initial.buy);
  const [sells, setSells] = useState<string[]>(initial.sells.map(String));
  const [slipMode, setSlipMode] = useState(initial.slippage.mode);
  const [slip, setSlip] = useState(String(initial.slippage.pct));
  const [tag, setTag] = useState(initial.tag);
  const t = tier;
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);
  useEffect(() => { if (buyAuto) setBuy(autoUsd.map(String)); }, [buyAuto, autoUsd]);
  const save = () => {
    const b = buy.map((v) => +v);
    const s: SellSlot[] = sells.map((v, i) => (+v > 0 && +v <= 100 ? +v : DEFAULT_SELLS[i]));
    onSave({ buy: buyAuto || !b.every((v) => v > 0) ? null : b, sells: s, slippage: { mode: slipMode, pct: +slip > 0 ? Math.min(50, +slip) : AUTO_SLIPPAGE_PCT }, tag }, t);
  };
  const cell: React.CSSProperties = { width: "100%", boxSizing: "border-box", textAlign: "center", font: "bold 15px ui-monospace,monospace", color: "#fff", padding: "10px 4px",
    background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.12)", borderRadius: 10, outline: "none" };
  const head = (label: string, reset?: () => void) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "14px 0 8px", fontSize: 13, color: "#cfd3e6" }}>
      <span>{label}</span>{reset && <button type="button" onClick={reset} style={{ all: "unset", cursor: "pointer", fontSize: 11, opacity: 0.7 }}>↻ Reset</button>}</div>);
  return (
    <div data-testid="swap-settings" role="dialog" aria-label="Swap settings" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => e.stopPropagation()} onKeyUp={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, zIndex: 60, display: "grid", placeItems: "center", background: "rgba(0,0,0,.45)" }}>
      <div style={{ position: "relative", width: 440, maxWidth: "92vw", padding: "20px 18px 18px", borderRadius: 18, background: "#14151b", border: "1px solid rgba(255,255,255,.08)",
        boxShadow: "0 20px 60px rgba(0,0,0,.6)", color: "#eef0ff", font: "13px system-ui,sans-serif" }}>
        <button type="button" aria-label="close" onClick={onClose} style={{ all: "unset", cursor: "pointer", position: "absolute", right: 14, top: 12, fontSize: 18, opacity: 0.8 }}>✕</button>
        <div style={{ textAlign: "center", fontWeight: 700, fontSize: 18 }}>Swap settings</div>
        <div style={{ textAlign: "center", fontSize: 10, opacity: 0.5, marginTop: 2, fontFamily: "ui-monospace,monospace" }}>{scope}</div>
        {head("Buy presets ($)", () => setBuyAuto(true))}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
          {buy.map((v, i) => <label key={i} style={{ display: "grid", gap: 3, fontSize: 9, opacity: 0.95, fontFamily: "ui-monospace,monospace", color: "#ffe7a3" }}>
            <span>{MODES[i].key}</span>
            <input data-testid={`swap-buy-${i}`} inputMode="decimal" value={buyAuto ? (+v < 1 ? `$${(+v).toFixed(2)}` : `$${+v}`) : v} onFocus={() => { if (buyAuto) { setBuyAuto(false); } }}
              onChange={(e) => { setBuyAuto(false); const n = [...buy]; n[i] = e.target.value.replace(/[^\d.]/g, ""); setBuy(n); }} style={{ ...cell, color: buyAuto ? "rgba(255,255,255,.6)" : "#fff" }} /></label>)}
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 12, cursor: "pointer" }}>
          <input type="checkbox" data-testid="swap-autoscale" checked={buyAuto} onChange={(e) => setBuyAuto(e.target.checked)} />
          <span>Auto-scale with mcap: {buyAuto ? "on" : "off"}</span></label>
        {head("Sell presets (%)", () => setSells(DEFAULT_SELLS.map(String)))}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
          {sells.map((v, i) => <label key={i} style={{ display: "grid", gap: 3, fontSize: 9, fontFamily: "ui-monospace,monospace", color: "#ffb0c8" }}>
            <span>{["Z", "X", "C", "V"][i]}</span>
            <input data-testid={`swap-sell-${i}`} value={v} title="% of your position (1–100)"
              onChange={(e) => { const n = [...sells]; const x = e.target.value; n[i] = x.replace(/[^\d.]/g, ""); setSells(n); }}
              style={cell} />
            </label>)}
        </div>
        <div style={{ borderTop: "1px dashed rgba(255,255,255,.12)", margin: "16px 0 12px" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span title="Max price move allowed between quote and fill (live trades only). Auto = 1%.">Slippage ⓘ</span>
          {slipMode === "custom" && <input data-testid="swap-slip" inputMode="decimal" value={slip} onChange={(e) => setSlip(e.target.value.replace(/[^\d.]/g, ""))}
            style={{ ...cell, width: 64, padding: "5px 4px", fontSize: 13, marginLeft: "auto" }} />}
          {slipMode === "custom" && <span>%</span>}
          <div style={{ display: "flex", marginLeft: slipMode === "custom" ? 0 : "auto", padding: 3, borderRadius: 9, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.1)" }}>
            {(["auto", "custom"] as const).map((m) => <button key={m} type="button" data-testid={`swap-slip-${m}`} onClick={() => setSlipMode(m)}
              style={{ all: "unset", cursor: "pointer", padding: "4px 12px", borderRadius: 7, fontWeight: 600, background: slipMode === m ? "#2b2f6e" : "transparent", color: slipMode === m ? "#aab4ff" : "rgba(255,255,255,.55)" }}>{m === "auto" ? "Auto" : "Custom"}</button>)}
          </div>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, cursor: "pointer" }}>
          <input type="checkbox" data-testid="swap-tag" checked={tag} onChange={(e) => setTag(e.target.checked)} /> Position tag next to the rocket <span style={{ opacity: 0.55 }}>(P)</span></label>
        <button type="button" data-testid="swap-save" onClick={save}
          style={{ all: "unset", cursor: "pointer", display: "block", textAlign: "center", width: "100%", boxSizing: "border-box", marginTop: 16, padding: "12px 0", borderRadius: 12, fontWeight: 700, fontSize: 15,
            background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.1)", color: "#eef0ff" }}>Save</button>
      </div>
    </div>
  );
}
