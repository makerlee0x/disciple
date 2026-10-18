"use client";

import { useEffect, useState } from "react";
import { keyLabel, useGameSettings } from "@/lib/game/settings";
import { useT, type I18nKey } from "@/lib/game/i18n";

/**
 * Controls reference (rendered inside the ESC settings menu, components/flight/SettingsMenu.tsx).
 * Was the '? CONTROLS' pill + popover in the bottom pill row; moved into the menu to declutter the HUD.
 * useControlsFeed() keeps the engine's MODE panel docked (disciple:controlsdock) and streams its live values
 * (disciple:controls, ≤4 Hz on change); SettingsMenu mounts it for the page lifetime.
 */
export type Ctl = { mode: string; key: string; shot: string; pending: number; max: number; turbo: boolean | null; orbs: boolean; score: number; streak: number; mult: number };

export function useControlsFeed(): Ctl | null {
  const [c, setC] = useState<Ctl | null>(null);
  useEffect(() => {
    let got = false; const on = (e: Event) => { got = true; setC((e as CustomEvent<Ctl>).detail); };
    addEventListener("disciple:controls", on);
    const dock = () => dispatchEvent(new CustomEvent("disciple:controlsdock", { detail: { docked: true } }));
    dock(); const iv = window.setInterval(() => { if (!got) dock(); }, 2000);   // engine may boot after us
    return () => { removeEventListener("disciple:controls", on); clearInterval(iv); dispatchEvent(new CustomEvent("disciple:controlsdock", { detail: { docked: false } })); };
  }, []);
  return c;
}

export default function ControlsReference({ c, simulator = false }: { c: Ctl | null; simulator?: boolean }) {
  const t = useT();
  const gs = useGameSettings();
  const buyKeys = gs.keys.buy.map(keyLabel).join(" "), sellKeys = gs.keys.sell.map(keyLabel).join(" ");
  const rows: [string, I18nKey, string?][] = [
    ["SPACE", "ctl.space", "#9ff3c8"], ["SHIFT", "ctl.shift", "#ffb0c8"],
    [buyKeys, "ctl.buyKeys", "#9ff3c8"], [sellKeys, "ctl.sellKeys", "#ffb0c8"],
    ["CLICK", "ctl.click"], ["W / ↑", "ctl.w"], ["A / D", "ctl.ad"], ["P", "ctl.p"], ["G", "ctl.g", "#c8ffd8"], ["O", "ctl.o"], ["B", "ctl.b"],
    ...(simulator ? [] : ([["ENTER", "ctl.enter"], ["H", "ctl.h"]] as [string, I18nKey][])),
    ["ESC", "ctl.esc"],
  ];
  return (
    <div data-testid="controls-ref" style={{ font: "11px/1.55 ui-monospace,monospace", color: "#e8ecff" }}>
      {c && <div style={{ fontWeight: 800, color: "#fff", marginBottom: 6 }}>{t("ctl.shot", { shot: c.shot })} <span style={{ opacity: 0.6, fontWeight: 400 }}>[{c.key}]</span></div>}
      {rows.map(([k, d, col]) => (
        <div key={d} style={{ display: "flex", gap: 8 }}><b style={{ minWidth: 104, color: col || "#ffe7a3" }}>{k}</b><span style={{ opacity: 0.9 }}>{t(d)}</span></div>))}
      {c && <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid rgba(255,255,255,.1)", opacity: 0.9 }}>
        {t("ctl.pending")} {c.pending}/{c.max}{c.turbo !== null ? ` · T turbo ${c.turbo ? t("on") : t("off")}` : ""}
        {c.orbs && <span style={{ color: "#ffe7a3" }}> · {t("ctl.points")} {c.score} · {t("ctl.streak")} {c.streak}{c.mult > 1 ? ` ×${c.mult}` : ""}</span>}
      </div>}
    </div>
  );
}
