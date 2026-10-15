"use client";

import { useEffect, useState } from "react";
import { MODES, fmtUsd, nextUnlock, verifiedLevel } from "@/lib/config";
import VerifiedBadge from "./VerifiedBadge";

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

const REWARDS = ["Crew orb rain", "Halo trail skin", "rHALO airdrop ×2", "Choir soundtrack", "Golden wings"];

type FlightWin = { __flight?: { S?: { confirmed?: { mcap?: number | null }; mode?: number } } };

export default function CrewPanel() {
  const [mcap, setMcap] = useState(21_400);
  const [mode, setMode] = useState(2);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const iv = setInterval(() => {
      const S = (window as unknown as FlightWin).__flight?.S;
      if (S?.confirmed?.mcap) setMcap(S.confirmed.mcap);
      if (typeof S?.mode === "number") setMode(S.mode);
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  const u = nextUnlock(mcap);
  const tier = verifiedLevel({ ...MOCK_CREW.stats, mcapUsd: mcap });
  const reward = REWARDS[(u.next.length + u.current.length) % REWARDS.length];

  return (
    <aside
      aria-label="Crew"
      style={{
        position: "fixed", right: 14, top: 305, zIndex: 30, width: 250,
        padding: 12, borderRadius: 14, background: "rgba(10,12,28,.82)",
        border: "1px solid rgba(255,231,163,.45)", color: "#e8ecff",
        font: "11px ui-monospace,monospace",
      }}
    >
      <button type="button" onClick={() => setOpen((o) => !o)}
        style={{ all: "unset", cursor: "pointer", display: "flex", width: "100%", justifyContent: "space-between", color: "#ffe7a3", fontWeight: "bold" }}>
        <span>CREW <span style={{ color: "#ffb0c8" }}>· MOCK</span></span>
        <span>{open ? "−" : "+"}</span>
      </button>
      <div style={{ marginTop: 4 }}><VerifiedBadge tier={tier} /></div>
      {open && (
        <>
          <div style={{ marginTop: 8 }}>👥 {MOCK_CREW.aboard} players aboard</div>
          <div style={{ marginTop: 6, color: "#ffe7a3" }}>TOP FUELERS</div>
          {MOCK_CREW.top.map((t, i) => (
            <div key={t.who} style={{ display: "flex", justifyContent: "space-between" }}>
              <span>{i === 0 ? "👑" : i + 1} {t.who}</span><span>{fmtUsd(t.usd)}</span>
            </div>
          ))}
          <div style={{ marginTop: 6, color: "#9ff3c8" }}>Your contribution: {fmtUsd(MOCK_CREW.you)}</div>
          <div style={{ marginTop: 10, color: "#ffe7a3" }}>NEXT UNLOCK · {u.next}</div>
          <div style={{ height: 6, borderRadius: 4, background: "rgba(255,255,255,.12)", overflow: "hidden", marginTop: 4 }}>
            <i style={{ display: "block", height: "100%", width: `${u.pct}%`, background: "linear-gradient(90deg,#ffd98a,#fff7df)" }} />
          </div>
          <div style={{ marginTop: 3, opacity: 0.8 }}>{u.pct.toFixed(0)}% · {fmtUsd(mcap)} / {fmtUsd(u.targetUsd)} → 🎁 {reward} for everyone aboard</div>
          <div style={{ marginTop: 10, color: "#ffe7a3" }}>AMMO COST</div>
          {MODES.map((m, i) => (
            <div key={m.key} style={{ display: "flex", justifyContent: "space-between", color: i === mode ? "#9ff3c8" : undefined }}>
              <span>{m.key} {m.name}</span><span>${m.usd < 1 ? m.usd.toFixed(2) : m.usd.toLocaleString()}</span>
            </div>
          ))}
        </>
      )}
    </aside>
  );
}
