"use client";

import { useEffect, useMemo, useState } from "react";
import { COINS, LOADOUT_KEY, SKINS, THRUSTERS, coinById, coinEmblem, thrusterById } from "@/lib/rocketSkin";
import SkinnedRocket from "@/components/SkinnedRocket";
import HangarRocket from "@/components/factory/HangarRocket";
import hs from "@/components/factory/hangar.module.css";
import { withBase } from "@/lib/base-path";

/**
 * Rocket factory (Forza "My Cars" layout): header with rocket + points, centre stage,
 * right-side stat bars, bottom part carousel. v1 is presentational — upgrades are cosmetic
 * only and never change price or fills. Part catalogue is SAMPLE until the cosmetics contract lands.
 */
type Slot = "body" | "thrusters" | "coin" | "trail" | "frame";
type Stats = { thrust: number; handling: number; glow: number; aura: number; launch: number };
type Part = { id: string; slot: Slot; ref: string; name: string; cost: number; tint: string; stats: Partial<Stats>; owned?: boolean };

const SLOTS: { id: Slot; label: string }[] = [
  { id: "body", label: "Body skin" }, { id: "thrusters", label: "Thrusters" }, { id: "coin", label: "Nose coin" },
  { id: "trail", label: "Trail" }, { id: "frame", label: "Frame" },
];
const BASE: Stats = { thrust: 5.0, handling: 5.0, glow: 4.0, aura: 3.5, launch: 5.5 };
const STAT_LABEL: Record<keyof Stats, string> = { thrust: "THRUST", handling: "HANDLING", glow: "GLOW", aura: "AURA", launch: "LAUNCH" };

const SKIN_COST: Record<string, [number, Partial<Stats>]> = {
  chrome: [0, {}], gold: [2500, { glow: 1.6, aura: 1.2 }], rose: [1800, { aura: 1.4 }], green: [1500, { handling: 1.0, glow: 0.6 }],
  cobalt: [1500, { handling: 1.2 }], violet: [3000, { aura: 2.0, glow: 0.8 }], matte: [2200, { handling: 1.6, launch: 0.6 }], crimson: [2000, { thrust: 0.8, glow: 0.8 }],
};
const THR_COST: Record<string, [number, Partial<Stats>]> = {
  stock: [0, {}], seraph: [500, { thrust: 1.4, launch: 1.0 }], ion: [3000, { thrust: 2.4, launch: 1.8 }],
  plasma: [2400, { thrust: 1.8, glow: 1.0 }], venom: [1600, { thrust: 1.2, handling: 0.8 }], inferno: [2800, { thrust: 2.2, launch: 1.2 }],
};
const COIN_COST: Record<string, [number, Partial<Stats>]> = {
  halo: [0, {}], sun: [900, { glow: 1.0 }], star: [1200, { aura: 1.0 }], moon: [1400, { aura: 1.2, glow: 0.4 }],
  diamond: [3500, { aura: 2.0, handling: 0.6 }], frog: [700, { launch: 0.8 }],
};

const PARTS: Part[] = [
  ...SKINS.map((k) => ({ id: `body-${k.id}`, slot: "body" as Slot, ref: k.id, name: k.name, cost: SKIN_COST[k.id]?.[0] ?? 1000, tint: k.tint ?? "#c9d2e6", stats: SKIN_COST[k.id]?.[1] ?? {}, owned: k.id === "chrome" })),
  ...THRUSTERS.map((t) => ({ id: `thr-${t.id}`, slot: "thrusters" as Slot, ref: t.id, name: t.name, cost: THR_COST[t.id]?.[0] ?? 1000, tint: t.flame, stats: THR_COST[t.id]?.[1] ?? {}, owned: t.id === "stock" })),
  ...COINS.map((c) => ({ id: `coin-${c.id}`, slot: "coin" as Slot, ref: c.id, name: c.name, cost: COIN_COST[c.id]?.[0] ?? 1000, tint: c.bg[1], stats: COIN_COST[c.id]?.[1] ?? {}, owned: c.id === "halo" })),
  { id: "trail-none", slot: "trail", ref: "", name: "Clean Exhaust", cost: 0, tint: "#7d879f", stats: {}, owned: true },
  { id: "trail-wing", slot: "trail", ref: "", name: "Wing Halo Trail", cost: 1000, tint: "#fff7df", stats: { glow: 1.2 } },
  { id: "trail-star", slot: "trail", ref: "", name: "Star Wake", cost: 1800, tint: "#c9b6f2", stats: { glow: 1.8, aura: 0.6 } },
  { id: "trail-gold", slot: "trail", ref: "", name: "Halo Gold", cost: 5000, tint: "#ffd060", stats: { glow: 2.6, aura: 1.2 } },
  { id: "frame-none", slot: "frame", ref: "", name: "No Frame", cost: 0, tint: "#7d879f", stats: {}, owned: true },
  { id: "frame-pearly", slot: "frame", ref: "", name: "Pearly Frame", cost: 800, tint: "#f4f1ea", stats: { aura: 0.8 } },
  { id: "frame-winged", slot: "frame", ref: "", name: "Winged Border", cost: 2200, tint: "#ffe7a3", stats: { aura: 1.6 } },
];
const DEFAULT_EQUIP: Record<Slot, string> = { body: "body-chrome", thrusters: "thr-stock", coin: "coin-halo", trail: "trail-none", frame: "frame-none" };
const SAMPLE_POINTS = 12_400;

function rating(s: Stats) { return Math.round((s.thrust + s.handling + s.glow + s.aura + s.launch) * 20); }
function ratingClass(r: number) { return r >= 800 ? "S" : r >= 650 ? "A" : r >= 550 ? "B" : r >= 450 ? "C" : "D"; }

export default function RocketFactory() {
  const [slot, setSlot] = useState<Slot>("body");
  const [equipped, setEquipped] = useState<Record<Slot, string>>(DEFAULT_EQUIP);
  const [owned, setOwned] = useState<string[]>([]);
  const [points, setPoints] = useState(SAMPLE_POINTS);
  const [preview, setPreview] = useState<string>("body-chrome");
  const [note, setNote] = useState("");
  const [loaded, setLoaded] = useState(false);

  // Persist loadout + sample purchases in this browser.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LOADOUT_KEY);
      if (raw) {
        const j = JSON.parse(raw) as { equipped?: Record<Slot, string>; owned?: string[]; points?: number };
        if (j.equipped) {
          const eq = { ...DEFAULT_EQUIP, ...j.equipped };
          for (const k of Object.keys(eq) as Slot[]) if (!PARTS.some((p) => p.id === eq[k] && p.slot === k)) eq[k] = DEFAULT_EQUIP[k];
          setEquipped(eq); setPreview(eq.body);
        }
        if (Array.isArray(j.owned)) setOwned(j.owned);
        if (typeof j.points === "number") setPoints(j.points);
      }
    } catch { /* ignore */ }
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(LOADOUT_KEY, JSON.stringify({ equipped, owned, points })); } catch { /* ignore */ }
  }, [equipped, owned, points, loaded]);
  const isOwned = (p: Part) => p.owned || p.cost === 0 || owned.includes(p.id);

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
  const part = (id: string) => PARTS.find((p) => p.id === id);
  const tint = part(build.body)?.tint ?? "#c9d2e6";
  const trail = part(build.trail)?.tint ?? "#7d879f";
  const frame = part(build.frame)?.tint ?? "transparent";
  const skinId = part(build.body)?.ref || "chrome";
  const coinId = part(build.coin)?.ref || "halo";
  const thr = thrusterById(part(build.thrusters)?.ref || "stock");
  const buy = () => {
    const p = previewPart;
    if (isOwned(p)) { setEquipped((e) => ({ ...e, [p.slot]: p.id })); setNote(`${p.name} equipped.`); return; }
    if (points < p.cost) { setNote(`Need ${(p.cost - points).toLocaleString()} more pts for ${p.name}.`); return; }
    setPoints((x) => x - p.cost); setOwned((o) => [...o, p.id]);
    setEquipped((e) => ({ ...e, [p.slot]: p.id }));
    setNote(`${p.name} unlocked & equipped (sample points — real checkout opens when cosmetics go live).`);
  };

  return (
    <div className={`factory-hangar ${hs.wrapOuter}`}>
      <div className={hs.wrap}>
        <section
          className={hs.scene}
          data-frame={build.frame}
          style={{ ["--hull" as string]: tint, ["--trail" as string]: trail, ["--frame" as string]: frame, ["--flame" as string]: thr.flame, ["--flame-core" as string]: thr.core }}
        >
          <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
            <filter id="hangarHeat" x="-50%" y="-20%" width="200%" height="140%">
              <feTurbulence type="fractalNoise" baseFrequency="0.02 0.09" numOctaves="2" seed="3" result="n">
                <animate attributeName="seed" values="1;2;3;4;5;6;7;8" dur="0.8s" repeatCount="indefinite" calcMode="discrete" />
              </feTurbulence>
              <feDisplacementMap in="SourceGraphic" in2="n" scale="5" xChannelSelector="R" yChannelSelector="G" />
            </filter>
          </svg>
          <div className={hs.stage}>
            <picture>
              <source type="image/avif" srcSet={`${withBase("/hangar/plate-1280.avif")} 1280w, ${withBase("/hangar/plate.avif")} 2560w`} sizes="max(100vw, 1280px)" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className={hs.plate}
                src={withBase("/hangar/plate.webp")}
                srcSet={`${withBase("/hangar/plate-1280.webp")} 1280w, ${withBase("/hangar/plate.webp")} 2560w`}
                sizes="max(100vw, 1280px)"
                width={2560}
                height={1440}
                alt=""
                fetchPriority="high"
                decoding="async"
              />
            </picture>
            <div className={hs.floorGlow} aria-hidden />
            {build.trail !== "trail-none" && <div className={hs.trail} aria-hidden />}
            <div className={hs.flameRefl} aria-hidden />
            <HangarRocket skin={skinId} coin={coinId} flame={thr.flame} className={hs.rocket} reflClassName={hs.refl} />
            <div className={hs.flame} aria-hidden><i /><i /></div>
            <div className={hs.flameGlow} aria-hidden />
            <div className={hs.shimmer} aria-hidden />
            <div className={hs.smoke} aria-hidden><span /><span /><span /><span /><span /></div>
            <div className={hs.cone} aria-hidden />
          </div>
          <div className={hs.scrim} aria-hidden />
          <div className={hs.side} aria-hidden="true">ROCKET FACTORY</div>
          <header className={hs.hdr}>
            <div className={hs.id}>
              <div className={hs.badge} aria-hidden>
                <svg viewBox="0 0 16 16"><path d="M8 0 9.6 6.4 16 8 9.6 9.6 8 16 6.4 9.6 0 8 6.4 6.4Z" fill="#E8EAEE" /></svg>
              </div>
              <div>
                <div className={hs.eyebrow}>DISCIPLE HANGAR · BAY 01</div>
                <h1 className={hs.name}>Halo Pilot&apos;s Rocket</h1>
              </div>
            </div>
            <div className={hs.pts}>
              <div className={hs.ptsLab}>POINTS</div>
              <div className={hs.ptsVal}>{points.toLocaleString()} <span>pts</span></div>
            </div>
          </header>
          <div className={hs.cap}>
            <span className={hs.dot} aria-hidden />
            <span className={hs.capName}>{previewPart.name}</span>
            <span className={hs.capSlot}>{SLOTS.find((s) => s.id === previewPart.slot)?.label}</span>
          </div>
        </section>

        <aside className={hs.panel}>
          <div className={hs.rank}>
            <span className={hs.tier}>{ratingClass(r)}</span>
            <span className={hs.score}>{r}</span>
          </div>
          {(Object.keys(STAT_LABEL) as (keyof Stats)[]).map((k) => {
            const delta = next[k] - current[k];
            const n = Math.round(next[k] * 4), c = Math.round(Math.min(current[k], next[k]) * 4);
            return (
              <div key={k} className={hs.stat}>
                <div className={hs.row}>
                  <span className={hs.k}>{STAT_LABEL[k]}</span>
                  <span className={hs.v}>{next[k].toFixed(1)}{delta > 0 && <em>+{delta.toFixed(1)}</em>}</span>
                </div>
                <div className={hs.gauge} role="meter" aria-label={STAT_LABEL[k]} aria-valuemin={0} aria-valuemax={10} aria-valuenow={next[k]}>
                  {Array.from({ length: 40 }, (_, i) => (
                    <i key={i} className={i === n - 1 ? hs.hot : i < c ? hs.on : i < n - 1 ? hs.gain : undefined} />
                  ))}
                </div>
              </div>
            );
          })}
          <div className={hs.sp} />
          <button
            type="button"
            className={`${hs.equip}${!isEquipped && !isOwned(previewPart) ? " " + hs.unlock : ""}`}
            disabled={isEquipped}
            onClick={buy}
          >
            {isEquipped && (
              <svg viewBox="0 0 14 14" aria-hidden><path d="M2.5 7.5 5.5 10.5 11.5 3.5" stroke="currentColor" strokeWidth="1.6" fill="none" /></svg>
            )}
            {isEquipped ? "Equipped" : isOwned(previewPart) ? "Equip" : `Unlock · ${previewPart.cost.toLocaleString()} pts`}
          </button>
          {note && <p className={hs.status} role="status">{note}</p>}
          <p className={hs.note}>Cosmetic only — upgrades never change price, fills or odds.</p>
        </aside>
      </div>

      <div className="factory factory-below">
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
            <PartSwatch p={p} />
            <span className="fc-name">{p.name}</span>
            <span className="fc-cost">{equipped[p.slot] === p.id ? "EQUIPPED" : isOwned(p) ? "OWNED" : `${p.cost.toLocaleString()} pts`}</span>
          </button>
        ))}
      </div>
      <footer className="factory-foot">
        <span><span className="tag mock">SAMPLE PARTS</span> · Prestige unlocks rarer parts</span>
        <span className="muted tiny">Click a part to preview it live · Unlock with points · saved in this browser</span>
      </footer>
      </div>
    </div>
  );
}

/** Carousel swatch: real visual per slot (mini skinned rocket, flame colour, coin face). */
function PartSwatch({ p }: { p: Part }) {
  if (p.slot === "body") return <span className="fc-swatch fc-rocket"><SkinnedRocket skin={p.ref} coin="halo" height={64} /></span>;
  if (p.slot === "thrusters") {
    const t = thrusterById(p.ref);
    return <span className="fc-swatch fc-flame" style={{ ["--flame" as string]: t.flame, ["--flame-core" as string]: t.core }}><span /></span>;
  }
  if (p.slot === "coin") return <CoinSwatch id={p.ref} />;
  return <span className="fc-swatch" style={{ background: `radial-gradient(circle at 40% 35%, #fff, ${p.tint} 45%, #121634 100%)` }} />;
}

function CoinSwatch({ id }: { id: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => { setSrc(coinEmblem(coinById(id), 96).toDataURL()); }, [id]);
  // eslint-disable-next-line @next/next/no-img-element
  return <span className="fc-swatch fc-coin">{src && <img src={src} alt="" />}</span>;
}
