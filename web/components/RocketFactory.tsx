"use client";

import { useEffect, useMemo, useState } from "react";
import { LOADOUT_KEY, coinById, coinEmblem, thrusterById } from "@/lib/rocketSkin";
import { PARTS, isFreePart, type Part, type PartStats, type Slot } from "@/lib/parts";
import { buyPartWithXp, usePilotWallet, useXp } from "@/lib/xpClient";
import SkinnedRocket from "@/components/SkinnedRocket";
import HangarRocket from "@/components/factory/HangarRocket";
import hs from "@/components/factory/hangar.module.css";
import { withBase } from "@/lib/base-path";

/**
 * Rocket factory (Forza "My Cars" layout): header with rocket + XP, centre stage, right-side stat bars, bottom part
 * carousel. Parts are bought with XP (POST /api/shop/buy; catalogue in lib/parts.ts) and are cosmetic only: they never
 * change price, fills or odds. The equipped loadout is kept in this browser.
 */
type Stats = PartStats;

const SLOTS: { id: Slot; label: string }[] = [
  { id: "body", label: "Body skin" }, { id: "thrusters", label: "Thrusters" }, { id: "coin", label: "Nose coin" },
  { id: "trail", label: "Trail" }, { id: "frame", label: "Frame" },
];
const BASE: Stats = { thrust: 5.0, handling: 5.0, glow: 4.0, aura: 3.5, launch: 5.5 };
const STAT_LABEL: Record<keyof Stats, string> = { thrust: "THRUST", handling: "HANDLING", glow: "GLOW", aura: "AURA", launch: "LAUNCH" };
const DEFAULT_EQUIP: Record<Slot, string> = { body: "body-chrome", thrusters: "thr-stock", coin: "coin-halo", trail: "trail-none", frame: "frame-none" };

function rating(s: Stats) { return Math.round((s.thrust + s.handling + s.glow + s.aura + s.launch) * 20); }
function ratingClass(r: number) { return r >= 800 ? "S" : r >= 650 ? "A" : r >= 550 ? "B" : r >= 450 ? "C" : "D"; }

export default function RocketFactory() {
  const [slot, setSlot] = useState<Slot>("body");
  const [equipped, setEquipped] = useState<Record<Slot, string>>(DEFAULT_EQUIP);
  const wallet = usePilotWallet();
  const { xp, ready } = useXp(wallet);
  const owned = xp?.owned ?? [];
  const points = xp?.spendableXp ?? 0;
  const prestige = xp?.level.prestige ?? 0;
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string>("body-chrome");
  const [note, setNote] = useState("");
  const [loaded, setLoaded] = useState(false);

  // Persist the loadout in this browser.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LOADOUT_KEY);
      if (raw) {
        const j = JSON.parse(raw) as { equipped?: Record<Slot, string> };
        if (j.equipped) {
          const eq = { ...DEFAULT_EQUIP, ...j.equipped };
          for (const k of Object.keys(eq) as Slot[]) if (!PARTS.some((p) => p.id === eq[k] && p.slot === k)) eq[k] = DEFAULT_EQUIP[k];
          setEquipped(eq); setPreview(eq.body);
        }
      }
    } catch { /* ignore */ }
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(LOADOUT_KEY, JSON.stringify({ equipped })); } catch { /* ignore */ }
  }, [equipped, loaded]);
  const isOwned = (p: Part) => isFreePart(p) || owned.includes(p.id);
  const locked = (p: Part) => (p.minPrestige ?? 0) > prestige;
  // A part equipped in this browser that this pilot doesn't own (signed out, or another pilot) goes back to stock.
  useEffect(() => {
    if (!loaded || (wallet && !ready)) return;
    setEquipped((e) => {
      let changed = false; const n = { ...e };
      for (const k of Object.keys(n) as Slot[]) { const p = PARTS.find((x) => x.id === n[k]); if (!p || !(isFreePart(p) || (xp?.owned ?? []).includes(p.id))) { n[k] = DEFAULT_EQUIP[k]; changed = true; } }
      return changed ? n : e;
    });
  }, [loaded, wallet, ready, xp]);

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
  const buy = async () => {
    const p = previewPart;
    if (isOwned(p)) { setEquipped((e) => ({ ...e, [p.slot]: p.id })); setNote(`${p.name} equipped.`); return; }
    if (!wallet) { setNote("Sign in to unlock parts with XP."); return; }
    if (locked(p)) { setNote(`${p.name} unlocks at prestige ${p.minPrestige}.`); return; }
    if (points < p.cost) { setNote(`You need ${(p.cost - points).toLocaleString("en-US")} more XP for ${p.name}.`); return; }
    setBusy(true); setNote("");
    const r = await buyPartWithXp(wallet, p.id);
    setBusy(false);
    if (!r.ok) { setNote(r.reason || "Couldn't unlock that part."); return; }
    setEquipped((e) => ({ ...e, [p.slot]: p.id }));
    setNote(`${p.name} unlocked and equipped.`);
  };
  const cta = (p: Part) => isOwned(p) ? "Equip" : locked(p) ? `Prestige ${p.minPrestige}` : `Unlock · ${p.cost.toLocaleString("en-US")} XP`;

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
              <source type="image/avif" srcSet={`${withBase("/hangar/plate-1280.avif")} 1280w, ${withBase("/hangar/plate.avif")} 2560w`} sizes="(max-width: 1280px) 100vw, 1280px" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className={hs.plate}
                src={withBase("/hangar/plate.webp")}
                srcSet={`${withBase("/hangar/plate-1280.webp")} 1280w, ${withBase("/hangar/plate.webp")} 2560w`}
                sizes="(max-width: 1280px) 100vw, 1280px"
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
              <div className={hs.ptsLab}>XP TO SPEND</div>
              <div className={hs.ptsVal} data-testid="factory-xp">{wallet ? points.toLocaleString("en-US") : "–"} <span>XP</span></div>
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
            disabled={isEquipped || busy}
            onClick={buy}
            data-testid="factory-unlock"
          >
            {isEquipped && (
              <svg viewBox="0 0 14 14" aria-hidden><path d="M2.5 7.5 5.5 10.5 11.5 3.5" stroke="currentColor" strokeWidth="1.6" fill="none" /></svg>
            )}
            {isEquipped ? "Equipped" : busy ? "Unlocking…" : cta(previewPart)}
          </button>
          {note && <p className={hs.status} role="status">{note}</p>}
          <p className={hs.note}>Looks only. Parts never change price, fills or odds.</p>
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
            <span className="fc-cost">{equipped[p.slot] === p.id ? "EQUIPPED" : isOwned(p) ? "OWNED" : locked(p) ? `PRESTIGE ${p.minPrestige}` : `${p.cost.toLocaleString("en-US")} XP`}</span>
          </button>
        ))}
      </div>
      <footer className="factory-foot">
        <span>Earn XP from missions. Prestige unlocks the rarest parts.</span>
        <span className="muted tiny">Tap a part to try it on</span>
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
