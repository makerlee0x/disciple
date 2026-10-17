"use client";

import { useEffect, useRef, useState } from "react";
import { MODES, fmtUsd, nextUnlock, verifiedLevel } from "@/lib/config";
import VerifiedBadge from "./VerifiedBadge";
import Icon from "@/components/icons/Icon";

/** MOCK crew data — replace with indexer reads (DISCIPLE FLOW). */
const MOCK_CREW = {
  aboard: 640,
  top: [
    { who: "0xA11…ce7", usd: 1_840 },
    { who: "seraph.eth", usd: 1_220 },
    { who: "0x7Fe…01b", usd: 760 },
  ],
  you: 35,
  stats: { volume24hUsd: 42_000, ageHours: 900, holders: 640, liquidityUsd: 60_000 },
};

const REWARDS = ["Crew orb rain", "Halo trail skin", "Orb airdrop ×2", "Choir soundtrack", "Golden wings"];

type FlightWin = { __flight?: { S?: { confirmed?: { mcap?: number | null }; mode?: number } } };

export default function CrewPanel() {
  const [mcap, setMcap] = useState(21_400);
  const [mode, setMode] = useState(2);
  // Card in the right HUD column right under the status block, ABOVE the CHAT | HOLDERS panel; expanded by default. Always visible (no longer hidden by
  // chat); its height is published as --ap-crew-h so the CHAT | HOLDERS panel ends above it. Expanded state remembered.
  const [open, setOpenS] = useState(true);
  const setOpen = (f: (o: boolean) => boolean) => setOpenS((o) => { const n = f(o); try { localStorage.setItem("disciple.crew.open", n ? "1" : "0"); } catch { /* */ } return n; });
  useEffect(() => { try { setOpenS(localStorage.getItem("disciple.crew.open") !== "0"); } catch { /* */ } }, []);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current, st = document.documentElement.style; if (!el) return;
    const ro = new ResizeObserver(() => st.setProperty("--ap-crew-h", Math.ceil(el.getBoundingClientRect().height + 8) + "px")); ro.observe(el);
    return () => { ro.disconnect(); st.removeProperty("--ap-crew-h"); };
  }, []);

  const [ammoUsd, setAmmoUsd] = useState<number[]>(MODES.map((m) => m.usd));
  // Engine pushes marks + scaled ammo presets on change (no 1 s poll).
  useEffect(() => {
    const S = (window as unknown as FlightWin).__flight?.S;
    if (S?.confirmed?.mcap) setMcap(S.confirmed.mcap);
    if (typeof S?.mode === "number") setMode(S.mode);
    const onMark = (e: Event) => { const m = (e as CustomEvent<{ mcap: number }>).detail?.mcap; if (m) setMcap(m); };
    const onAmmo = (e: Event) => { const d = (e as CustomEvent<{ usd: number[]; mode: number }>).detail; if (d?.usd) setAmmoUsd(d.usd); if (typeof d?.mode === "number") setMode(d.mode); };
    addEventListener("disciple:mark", onMark);
    addEventListener("disciple:ammo", onAmmo);
    dispatchEvent(new Event("disciple:ammo-query"));
    return () => { removeEventListener("disciple:mark", onMark); removeEventListener("disciple:ammo", onAmmo); };
  }, []);

  const u = nextUnlock(mcap);
  const tier = verifiedLevel({ ...MOCK_CREW.stats, mcapUsd: mcap });
  const reward = REWARDS[(u.next.length + u.current.length) % REWARDS.length];

  const ammoTxt = (i: number, d: number) => { const v = ammoUsd[i] ?? d; return "$" + (v < 1 ? v.toFixed(2) : v.toLocaleString()); };
  return (
    <aside
      ref={ref} aria-label="Crew" data-testid="crew-panel"
      style={{
        position: "fixed", right: 20, top: "calc(var(--ap-hud-rt, 58px) + 100px)", maxHeight: "calc(100vh - var(--ap-hud-rt, 58px) - 360px)", overflowY: "auto", zIndex: 30, width: 310, boxSizing: "border-box",
        padding: "8px 12px", borderRadius: 12, background: "rgba(22,24,28,.82)",
        border: "1px solid rgba(255,231,163,.45)", color: "#E8EAEE",
        font: "11px ui-monospace,monospace",
      }}
    >
      <button type="button" data-testid="crew-toggle" onClick={() => setOpen((o) => !o)} title={open ? "Collapse crew" : "Expand crew"}
        style={{ all: "unset", cursor: "pointer", display: "flex", width: "100%", gap: 8, alignItems: "center", color: "#ffe7a3", fontWeight: "bold" }}>
        <span>CREW <span style={{ color: "#ffb0c8" }}>· MOCK</span></span>
        <span style={{ color: "#E8EAEE", fontWeight: 400 }}><Icon name="crew" size={16} style={{ verticalAlign: -4 }} /> {MOCK_CREW.aboard} aboard</span>
        <span style={{ marginLeft: "auto", display: "inline-flex" }}><Icon name={open ? "minus" : "plus"} size={16} /></span>
      </button>
      {/* Tier progress itself is the canvas tier bar (PR #50: fill + USD to next tier); Crew only names the crew reward */}
      <div data-testid="crew-unlock" style={{ marginTop: 5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        <Icon name="gift" size={16} /> Next unlock at <b style={{ color: "#ffe7a3" }}>{u.next}</b>: {reward.replace(/^Crew /, "").toLowerCase()} for everyone aboard
      </div>
      {open && (
        <>
          <div style={{ marginTop: 6 }}><VerifiedBadge tier={tier} /></div>
          <div style={{ marginTop: 6, color: "#ffe7a3" }}>TOP FUELERS</div>
          {MOCK_CREW.top.map((t, i) => (
            <div key={t.who} style={{ display: "flex", justifyContent: "space-between" }}>
              <span>{i === 0 ? <Icon name="crown" size={16} label="top fueler" /> : i + 1} {t.who}</span><span>{fmtUsd(t.usd)}</span>
            </div>
          ))}
          <div style={{ marginTop: 4, color: "#9ff3c8" }}>Your contribution: {fmtUsd(MOCK_CREW.you)}</div>
          <div style={{ marginTop: 6, color: "#ffe7a3" }}>BUY PRESETS</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 14 }}>
            {MODES.map((m, i) => (
              <div key={m.key} style={{ display: "flex", justifyContent: "space-between", color: i === mode ? "#9ff3c8" : undefined }}>
                <span>{m.key}</span><span>{ammoTxt(i, m.usd)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
