"use client";

import { useMemo, useState } from "react";
import BrandedRocket from "@/components/BrandedRocket";

/**
 * Rocket factory (Forza "My Cars" layout): header with rocket + points, centre stage,
 * right-side stat bars, bottom part carousel. v1 is presentational — upgrades are cosmetic
 * only and never change price or fills. Part catalogue is SAMPLE until the cosmetics contract lands.
 */
type Slot = "hull" | "thrusters" | "trail" | "nosecone" | "wings" | "frame";
type Stats = { thrust: number; handling: number; glow: number; aura: number; launch: number };
type Part = { id: string; slot: Slot; name: string; cost: number; tint: string; stats: Partial<Stats>; owned?: boolean };

const SLOTS: { id: Slot; label: string }[] = [
  { id: "hull", label: "Hull" }, { id: "thrusters", label: "Thrusters" }, { id: "trail", label: "Trail" },
  { id: "nosecone", label: "Nosecone" }, { id: "wings", label: "Wings" }, { id: "frame", label: "Frame" },
];
const BASE: Stats = { thrust: 5.0, handling: 5.0, glow: 4.0, aura: 3.5, launch: 5.5 };
const STAT_LABEL: Record<keyof Stats, string> = { thrust: "THRUST", handling: "HANDLING", glow: "GLOW", aura: "AURA", launch: "LAUNCH" };

const PARTS: Part[] = [
  { id: "hull-chrome", slot: "hull", name: "Factory Chrome", cost: 0, tint: "#c9d2e6", stats: {}, owned: true },
  { id: "hull-gilded", slot: "hull", name: "Gilded Hull", cost: 2500, tint: "#ffe7a3", stats: { glow: 1.6, aura: 1.2 } },
  { id: "hull-seraph", slot: "hull", name: "Seraph Chrome", cost: 6000, tint: "#e3d4ff", stats: { glow: 2.2, aura: 2.4 } },
  { id: "hull-marble", slot: "hull", name: "Marble Hull", cost: 4200, tint: "#f4f1ea", stats: { aura: 1.8, handling: 0.6 } },
  { id: "thr-stock", slot: "thrusters", name: "Stock Burners", cost: 0, tint: "#ff9f6b", stats: {}, owned: true },
  { id: "thr-seraph", slot: "thrusters", name: "Seraph Thrusters", cost: 500, tint: "#ffd060", stats: { thrust: 1.4, launch: 1.0 } },
  { id: "thr-halo", slot: "thrusters", name: "Halo Ion Drive", cost: 3000, tint: "#9fd0ff", stats: { thrust: 2.4, launch: 1.8 } },
  { id: "trail-none", slot: "trail", name: "Clean Exhaust", cost: 0, tint: "#7d879f", stats: {}, owned: true },
  { id: "trail-wing", slot: "trail", name: "Wing Halo Trail", cost: 1000, tint: "#fff7df", stats: { glow: 1.2 } },
  { id: "trail-star", slot: "trail", name: "Star Wake", cost: 1800, tint: "#c9b6f2", stats: { glow: 1.8, aura: 0.6 } },
  { id: "trail-gold", slot: "trail", name: "Halo Gold", cost: 5000, tint: "#ffd060", stats: { glow: 2.6, aura: 1.2 } },
  { id: "nose-stock", slot: "nosecone", name: "Stock Cone", cost: 0, tint: "#c9d2e6", stats: {}, owned: true },
  { id: "nose-glory", slot: "nosecone", name: "Glory Nosecone", cost: 4000, tint: "#ffe7a3", stats: { handling: 1.4, aura: 0.8 } },
  { id: "wing-stock", slot: "wings", name: "Fins", cost: 0, tint: "#c9d2e6", stats: {}, owned: true },
  { id: "wing-angel", slot: "wings", name: "Angel Wings", cost: 3500, tint: "#fff7df", stats: { handling: 2.0, aura: 1.4 } },
  { id: "frame-none", slot: "frame", name: "No Frame", cost: 0, tint: "#7d879f", stats: {}, owned: true },
  { id: "frame-pearly", slot: "frame", name: "Pearly Frame", cost: 800, tint: "#f4f1ea", stats: { aura: 0.8 } },
  { id: "frame-winged", slot: "frame", name: "Winged Border", cost: 2200, tint: "#ffe7a3", stats: { aura: 1.6 } },
];
const SAMPLE_POINTS = 12_400;

function rating(s: Stats) { return Math.round((s.thrust + s.handling + s.glow + s.aura + s.launch) * 20); }
function ratingClass(r: number) { return r >= 800 ? "S" : r >= 650 ? "A" : r >= 550 ? "B" : r >= 450 ? "C" : "D"; }

export default function RocketFactory() {
  const [slot, setSlot] = useState<Slot>("hull");
  const [equipped, setEquipped] = useState<Record<Slot, string>>({
    hull: "hull-chrome", thrusters: "thr-stock", trail: "trail-none", nosecone: "nose-stock", wings: "wing-stock", frame: "frame-none",
  });
  const [preview, setPreview] = useState<string>("hull-chrome");
  const [note, setNote] = useState("");

  const parts = PARTS.filter((p) => p.slot === slot);
  const previewPart = PARTS.find((p) => p.id === preview) ?? parts[0];
  const build = useMemo(() => ({ ...equipped, [previewPart.slot]: previewPart.id }), [equipped, previewPart]);
  const statsFor = (b: Record<Slot, string>): Stats => {
    const s = { ...BASE };
    for (const id of Object.values(b)) {
      const p = PARTS.find((x) => x.id === id);
      if (p) for (const [k, v] of Object.entries(p.stats)) s[k as keyof Stats] = Math.min(10, s[k as keyof Stats] + (v ?? 0));
    }
    return s;
  };
  const current = statsFor(equipped);
  const next = statsFor(build);
  const r = rating(next);
  const isEquipped = equipped[previewPart.slot] === previewPart.id;
  const tint = PARTS.find((p) => p.id === build.hull)?.tint ?? "#c9d2e6";
  const trail = PARTS.find((p) => p.id === build.trail)?.tint ?? "#7d879f";

  return (
    <div className="factory">
      <div className="factory-rail" aria-hidden="true">ROCKET FACTORY</div>
      <header className="factory-head">
        <div className="factory-crest">✦</div>
        <div>
          <div className="factory-kicker">DISCIPLE HANGAR · BAY 01</div>
          <h1>Halo Pilot&apos;s Rocket</h1>
        </div>
        <div className="factory-price">
          <span>POINTS</span>
          <strong>{SAMPLE_POINTS.toLocaleString()} pts</strong>
        </div>
      </header>

      <div className="factory-main">
        <section className="factory-stage" style={{ ["--hull" as string]: tint, ["--trail" as string]: trail }}>
          <div className="stage-grid" />
          <div className="stage-door" />
          <div className="stage-floor" />
          <div className="stage-rocket"><BrandedRocket height={260} /></div>
          <div className="stage-trail" />
          <div className="stage-caption">{previewPart.name} <span className="muted">· {SLOTS.find((s) => s.id === previewPart.slot)?.label}</span></div>
        </section>

        <aside className="factory-stats">
          <div className="factory-rating">
            <span className={`rate-class c-${ratingClass(r)}`}>{ratingClass(r)}</span>
            <span className="rate-num">{r}</span>
          </div>
          {(Object.keys(STAT_LABEL) as (keyof Stats)[]).map((k) => {
            const delta = next[k] - current[k];
            return (
              <div key={k} className="factory-stat">
                <div className="fs-label">{STAT_LABEL[k]}</div>
                <div className="fs-row">
                  <span className="fs-num">{next[k].toFixed(1)}</span>
                  <div className="fs-bar">
                    <div className="fs-fill" style={{ width: `${Math.min(current[k], next[k]) * 10}%` }} />
                    {delta > 0 && <div className="fs-gain" style={{ left: `${current[k] * 10}%`, width: `${delta * 10}%` }} />}
                  </div>
                  {delta > 0 && <span className="fs-delta">+{delta.toFixed(1)}</span>}
                </div>
              </div>
            );
          })}
          <button
            type="button"
            className="ds-btn gold factory-cta"
            disabled={isEquipped}
            onClick={() => {
              if (previewPart.owned || previewPart.cost === 0) { setEquipped((e) => ({ ...e, [previewPart.slot]: previewPart.id })); setNote(`${previewPart.name} equipped.`); }
              else setNote(`Upgrade checkout for ${previewPart.name} (${previewPart.cost.toLocaleString()} pts) opens when cosmetics go live. Preview only.`);
            }}
          >
            {isEquipped ? "Equipped" : previewPart.owned || previewPart.cost === 0 ? "Equip" : `Upgrade · ${previewPart.cost.toLocaleString()} pts`}
          </button>
          {note && <p className="muted tiny" role="status">{note}</p>}
          <p className="muted tiny">Cosmetic only — upgrades never change price, fills or odds.</p>
        </aside>
      </div>

      <nav className="factory-slots" aria-label="Part slot">
        {SLOTS.map((s) => (
          <button key={s.id} type="button" className={slot === s.id ? "on" : ""}
            onClick={() => { setSlot(s.id); setPreview(equipped[s.id]); setNote(""); }}>{s.label}</button>
        ))}
      </nav>
      <div className="factory-carousel" role="listbox" aria-label={`${slot} parts`}>
        {parts.map((p) => (
          <button key={p.id} type="button" role="option" aria-selected={preview === p.id}
            className={`fc-card ${preview === p.id ? "on" : ""} ${equipped[p.slot] === p.id ? "eq" : ""}`}
            onClick={() => { setPreview(p.id); setNote(""); }}>
            <span className="fc-swatch" style={{ background: `radial-gradient(circle at 40% 35%, #fff, ${p.tint} 45%, #121634 100%)` }} />
            <span className="fc-name">{p.name}</span>
            <span className="fc-cost">{equipped[p.slot] === p.id ? "EQUIPPED" : p.owned || p.cost === 0 ? "OWNED" : `${p.cost.toLocaleString()} pts`}</span>
          </button>
        ))}
      </div>
      <footer className="factory-foot">
        <span><span className="tag mock">SAMPLE PARTS</span> · Prestige unlocks rarer parts</span>
        <span className="muted tiny">Click a part to preview · Upgrade to buy</span>
      </footer>
    </div>
  );
}
