"use client";
/**
 * Small Turbo fuel box: balance + Add fuel / Take fuel out. PRACTICE ONLY while the mock adapter is active — it never
 * touches game cash or the wallet. Bare on purpose; GAME owns the real screens and can restyle or replace it.
 * Copy pending lee approval.
 */
import { useState } from "react";
import { useTurboFuel } from "@/lib/turbo/useTurboFuel";

const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PRESETS = [10, 50, 100];

export default function TurboFuelPanel({ className }: { className?: string }) {
  const { usd, loading, busy, error, addFuel, withdrawFuel, practice } = useTurboFuel();
  const [amount, setAmount] = useState("10");
  const n = Number(amount);
  const ok = Number.isFinite(n) && n > 0;

  return (
    <div className={className} style={{ display: "grid", gap: 8, padding: 12, border: "1px solid rgba(255,255,255,.15)", borderRadius: 12 }} data-turbo-fuel>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, justifyContent: "space-between" }}>
        <span>Turbo fuel</span>
        {practice && <span className="tag mock" title="Practice money. Not real.">Practice</span>}
      </div>
      <strong style={{ fontSize: 24 }} aria-live="polite">{loading ? "…" : fmt(usd ?? 0)}</strong>
      {practice && <span className="muted tiny">Practice money only. Not real dollars, and separate from your game cash.</span>}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {PRESETS.map((p) => (
          <button key={p} type="button" onClick={() => setAmount(String(p))} aria-pressed={n === p}>${p}</button>
        ))}
        <input aria-label="Amount in dollars" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} style={{ width: 80 }} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" disabled={!ok || busy} onClick={() => addFuel(n)}>Add fuel</button>
        <button type="button" disabled={!ok || busy || (usd ?? 0) <= 0} onClick={() => withdrawFuel(n)}>Take fuel out</button>
      </div>
      {error && <span role="alert" className="tiny">{error}</span>}
    </div>
  );
}
