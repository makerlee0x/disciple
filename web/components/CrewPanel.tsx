"use client";

import { useEffect, useRef, useState } from "react";
import { DEMO_POOL, fmtUsd } from "@/lib/config";
import { isDeployed } from "@/lib/chains";
import { isVerified } from "@/lib/verified";
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
};

const NARROW_PX = 760;
/** px below the HUD's right-column top: the status box (92 + 8) and, when the chat isn't docking it, the canvas TOP HOLDERS box (96 + 8). */
export const crewTopOffset = (holdersDocked: boolean) => (holdersDocked ? 100 : 204);

export default function CrewPanel({ coin, verified }: { coin?: string; verified?: boolean } = {}) {
  // 1d: on a live coin the sample crew numbers (aboard / top boosters / your contribution) are hidden, not labelled MOCK
  const sample = !isDeployed() || !coin || coin.toLowerCase() === DEMO_POOL.address.toLowerCase();
  // Card in the right HUD column right under the status block, ABOVE the CHAT | HOLDERS panel; expanded by default. Always visible (no longer hidden by
  // chat); its height is published as --ap-crew-h so the CHAT | HOLDERS panel ends above it. Expanded state remembered.
  const [open, setOpenS] = useState(true);
  const setOpen = (f: (o: boolean) => boolean) => setOpenS((o) => { const n = f(o); try { localStorage.setItem("disciple.crew.open", n ? "1" : "0"); } catch { /* */ } return n; });
  // Phones: collapsed unless the player opened it before (the expanded card covers most of the right column there).
  useEffect(() => { try { const v = localStorage.getItem("disciple.crew.open"); setOpenS(v == null ? innerWidth >= NARROW_PX : v !== "0"); } catch { /* */ } }, []);
  // Live retest #1: with the chat closed (default since #114) the canvas draws its own TOP HOLDERS box at hud-rt+100
  // (engine.js, 96 px tall) — the same slot this card used, so the card covered it. Mirror the engine's kothDocked
  // (disciple:chatdock open && holders) and sit below that box while it is on the canvas.
  const [docked, setDocked] = useState(false);
  useEffect(() => {
    const S = (window as unknown as { __flight?: { S?: { kothDocked?: boolean } } }).__flight?.S;
    if (typeof S?.kothDocked === "boolean") setDocked(S.kothDocked);
    const on = (e: Event) => { const d = (e as CustomEvent<{ open?: boolean; holders?: boolean }>).detail; setDocked(!!(d?.open && d?.holders)); };
    addEventListener("disciple:chatdock", on);
    return () => removeEventListener("disciple:chatdock", on);
  }, []);
  const offset = crewTopOffset(docked);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current, st = document.documentElement.style; if (!el) return;
    const ro = new ResizeObserver(() => st.setProperty("--ap-crew-h", Math.ceil(el.getBoundingClientRect().height + 8) + "px")); ro.observe(el);
    return () => { ro.disconnect(); st.removeProperty("--ap-crew-h"); };
  }, []);

  // Lee, Oct 30 (coin-screen pass 2): no BUY PRESETS list and no "Next unlock … orb rain" loot line on the coin screen, even
  // with NEXT_PUBLIC_FEATURE_CREW_CARD=1 — the card keeps only the crew itself (verified badge, sample top boosters).
  const isVer = isVerified(coin, verified);

  return (
    <aside
      ref={ref} aria-label="Crew" data-testid="crew-panel"
      style={{
        position: "fixed", right: 20, top: `calc(var(--ap-hud-rt, 58px) + ${offset}px)`, maxHeight: `max(120px, calc(100vh - var(--ap-hud-rt, 58px) - ${260 + offset}px))`, overflowY: "auto", zIndex: 30, width: "min(310px, calc(100vw - 40px))", boxSizing: "border-box",
        padding: "8px 12px", borderRadius: 12, background: "rgba(22,24,28,.82)",
        border: "1px solid rgba(255,231,163,.45)", color: "#E8EAEE",
        font: "11px ui-monospace,monospace",
      }}
    >
      <button type="button" data-testid="crew-toggle" onClick={() => setOpen((o) => !o)} title={open ? "Collapse crew" : "Expand crew"}
        style={{ all: "unset", cursor: "pointer", display: "flex", width: "100%", gap: 8, alignItems: "center", color: "#ffe7a3", fontWeight: "bold" }}>
        <span>CREW{sample && <span style={{ color: "#ffb0c8" }}> · SAMPLE</span>}</span>
        {sample && <span style={{ color: "#E8EAEE", fontWeight: 400 }}><Icon name="crew" size={16} style={{ verticalAlign: -4 }} /> {MOCK_CREW.aboard} aboard</span>}
        <span style={{ marginLeft: "auto", display: "inline-flex" }}><Icon name={open ? "minus" : "plus"} size={16} /></span>
      </button>
      {open && (
        <>
          {isVer && <div style={{ marginTop: 6 }}><VerifiedBadge verified showLabel /></div>}
          {sample && <>
            <div style={{ marginTop: 6, color: "#ffe7a3" }}>TOP BOOSTERS</div>
            {MOCK_CREW.top.map((t, i) => (
              <div key={t.who} style={{ display: "flex", justifyContent: "space-between" }}>
                <span>{i === 0 ? <Icon name="crown" size={16} label="top booster" /> : i + 1} {t.who}</span><span>{fmtUsd(t.usd)}</span>
              </div>
            ))}
            <div style={{ marginTop: 4, color: "#9ff3c8" }}>Your contribution: {fmtUsd(MOCK_CREW.you)}</div>
          </>}
        </>
      )}
    </aside>
  );
}
