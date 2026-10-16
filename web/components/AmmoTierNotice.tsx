"use client";

import { useEffect, useState } from "react";

type TierUp = { from: number; to: number; fromName: string; toName: string; usd: number[]; current: number[]; mode: number; mcap: number };

const short = (v: number) => (v >= 1e3 ? `$${(v / 1e3).toFixed(v % 1e3 ? 1 : 0)}K` : v < 1 ? `$${v.toFixed(2)}` : `$${v}`);

/**
 * Non-intrusive tier-up nudge: the engine fires `disciple:ammotier` when the rocket's mcap crosses into a
 * higher ammo tier than the player's presets. Upgrade re-scales presets; Keep leaves them (always allowed).
 * Auto-hides after 14 s without changing anything.
 */
export default function AmmoTierNotice() {
  const [n, setN] = useState<TierUp | null>(null);
  useEffect(() => {
    const h = (e: Event) => setN((e as CustomEvent<TierUp>).detail);
    addEventListener("disciple:ammotier", h);
    return () => removeEventListener("disciple:ammotier", h);
  }, []);
  useEffect(() => {
    if (!n) return;
    const t = setTimeout(() => setN(null), 14_000);
    return () => clearTimeout(t);
  }, [n]);
  if (!n) return null;
  const act = (kind: "upgrade" | "keep") => {
    dispatchEvent(new CustomEvent(`disciple:ammo-${kind}`, { detail: { tier: n.to } }));
    setN(null);
  };
  const b = { all: "unset" as const, cursor: "pointer", padding: "4px 10px", borderRadius: 7, fontWeight: 700, fontSize: 11 };
  return (
    <div role="status" aria-label="ammo tier up" style={{ position: "fixed", bottom: 160, left: "calc(50% + var(--ap-rail-w, 64px) / 2)", transform: "translateX(-50%)", zIndex: 32,
      display: "flex", gap: 10, alignItems: "center", padding: "7px 10px", borderRadius: 11, maxWidth: "92vw",
      background: "rgba(14,12,34,.9)", border: "1px solid rgba(159,243,200,.55)", color: "#eef0ff",
      font: "11px ui-monospace,monospace", boxShadow: "0 6px 24px rgba(0,0,0,.35)", animation: "apAmmoIn .35s ease-out" }}>
      <span style={{ color: "#9ff3c8", fontWeight: 700 }}>▲ {n.toName} TIER</span>
      <span style={{ opacity: 0.85 }}>
        bigger ammo fits: {short(n.current[2])}→<b style={{ color: "#ffe7a3" }}>{short(n.usd[2])}</b> FLARE · {short(n.current[5])}→
        <b style={{ color: "#ffe7a3" }}>{short(n.usd[5])}</b> GLORY
      </span>
      <button type="button" aria-label="upgrade ammo" onClick={() => act("upgrade")} style={{ ...b, background: "#1f6f4a", color: "#c8ffe4" }}>Upgrade</button>
      <button type="button" aria-label="keep ammo" onClick={() => act("keep")} style={{ ...b, background: "rgba(255,255,255,.1)", color: "#e8ecff" }}>Keep</button>
      <style>{`@keyframes apAmmoIn{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}`}</style>
    </div>
  );
}
