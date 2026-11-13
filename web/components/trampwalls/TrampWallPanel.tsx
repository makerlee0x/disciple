"use client";

import { HUD } from "@/lib/game/hudStyle";
import Icon from "@/components/ui/Icon";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address } from "@/lib/protocol";
import { pointsFor, type TrampWall, type TrampWallAdapter, type TrampWallKind, type TrampWallPreview } from "@/lib/trampwalls/adapter";
import { TRAMP_WALL_POINTS_PER_USD } from "@/lib/config";
import { createMockAdapter, MOCK_ME, mockMarkFilled } from "@/lib/trampwalls/mock";

type FlightApi = { S?: { confirmed?: { mcap?: number } }; screenYToMcap?: (y: number) => number };
type TwWindow = Window & { __flight?: unknown; __trampWalls?: unknown[]; __twPreview?: unknown };
const w = () => window as unknown as TwWindow;
const flight = () => w().__flight as FlightApi | undefined;
const curMcap = () => flight()?.S?.confirmed?.mcap || 0;
/** One-tap presets: distance from price, range width, size × the ammo tier's FLARE preset (same scale as buys). */
const PRESETS = [
  { id: "tight", label: "Tight", dist: 3, width: 1, mult: 1, blurb: "close · fills often" },
  { id: "medium", label: "Medium", dist: 8, width: 3, mult: 2.5, blurb: "balanced" },
  { id: "wide", label: "Wide", dist: 18, width: 8, mult: 5, blurb: "deep · big moves only" },
] as const;
type Preset = (typeof PRESETS)[number];
const fmt = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`;

/**
 * adapter/owner/supply: the SIMULATOR passes its own adapter (lib/sim/twAdapter.ts) so placements are real
 * liquidity in the sim market; without one the panel runs on the local mock. simulator: sim wording.
 * Live and sim alike: a tramp/wall is a pure limit order. No fee share (the contract pays range orders no LP yield);
 * once the price fully crosses it a keeper closes it for a 0.1% tip.
 */
export default function TrampWallPanel({ token, adapter: ext, owner, supply, simulator }: { token: string; adapter?: TrampWallAdapter; owner?: Address; supply?: number; simulator?: boolean }) {
  const sample = !ext; // live coin pages fall back to the local mock until on-chain tramps land
  const adapter = useMemo(() => ext ?? createMockAdapter(curMcap), [ext]);
  const ME = owner ?? MOCK_ME, SUP = supply ?? 1e9;
  const coin = token as Address;
  const [graduated, setGraduated] = useState(false);
  const [cur, setCur] = useState(0);
  const [open, setOpen] = useState(false);

  const [listOpen, setListOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [kind, setKind] = useState<TrampWallKind>("tramp");
  const [pct, setPct] = useState(-8);
  const [width, setWidth] = useState(2);
  const [amount, setAmount] = useState("250");
  const [all, setAll] = useState<TrampWall[]>([]);
  const [mine, setMine] = useState<TrampWall[]>([]);
  const [pv, setPv] = useState<TrampWallPreview | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [step, setStep] = useState<"kind" | "preset" | "custom">("kind");
  const [flare, setFlare] = useState(20);
  const [pvs, setPvs] = useState<Record<string, TrampWallPreview>>({});
  useEffect(() => {
    const h = (e: Event) => { const u = (e as CustomEvent<{ usd?: number[] }>).detail?.usd; if (u && u[2] > 0) setFlare(u[2]); };
    addEventListener("disciple:ammo", h); dispatchEvent(new Event("disciple:ammo-query"));
    return () => removeEventListener("disciple:ammo", h);
  }, []);
  const presetParams = useCallback((k: TrampWallKind, p: Preset) => {
    const pc = k === "tramp" ? -p.dist : p.dist, pm = cur * (1 + pc / 100), su = flare * p.mult;
    const amt = k === "tramp" ? su : (pm > 0 ? su / (pm / SUP) : 0);   // wall amount is tokens (price = mcap / supply)
    return { pct: pc, priceMcap: pm, width: p.width, sizeUsd: su, amount: amt };
  }, [cur, flare, SUP]);
  useEffect(() => {
    if (!open || step !== "preset" || !(cur > 0)) return;
    let alive = true;
    Promise.all(PRESETS.map((p) => { const q = presetParams(kind, p);
      return adapter.preview({ token: coin, kind, mcapUsd: q.priceMcap, rangeWidthPct: q.width, amount: BigInt(0), sizeUsd: q.sizeUsd }, cur).then((r) => [p.id, r] as const); }))
      .then((rs) => { if (alive) setPvs(Object.fromEntries(rs)); });
    return () => { alive = false; };
  }, [open, step, kind, cur, adapter, coin, presetParams]);
  const placePreset = async (p: Preset) => {
    const q = presetParams(kind, p);
    const pre = await adapter.preview({ token: coin, kind, mcapUsd: q.priceMcap, rangeWidthPct: q.width, amount: BigInt(0), sizeUsd: q.sizeUsd }, cur);
    if (!pre.valid) { setMsg(pre.reason || "That order doesn't fit right now. Try a different size."); return; }
    const r = await adapter.place({ token: coin, kind, mcapUsd: q.priceMcap, rangeWidthPct: q.width, amount: BigInt(Math.floor(q.amount * 1e6)), sizeUsd: q.sizeUsd });
    setMsg(r.ok ? `${kind === "tramp" ? "Tramp" : "Wall"} placed ✦ ${p.label} · ${fmt(q.sizeUsd)}` : r.reason || "That didn't go through. Try again.");
    if (r.ok) { setOpen(false); refresh(); }
  };
  const openFlow = () => { setStep("kind"); setMsg(null); setOpen(true); };

  const refresh = useCallback(async () => {
    const m = curMcap(); setCur(m);
    setGraduated(await adapter.isGraduated(coin));
    setAll(await adapter.list(coin));
    setMine(await adapter.listMine(ME, coin));
  }, [adapter, coin, ME]);

  useEffect(() => {
    refresh(); const iv = setInterval(refresh, 2000);
    const off = adapter.onEvent(coin, () => refresh());
    const onFill = (e: Event) => { if (!ext) mockMarkFilled((e as CustomEvent).detail.id); refresh(); };   // the sim market fills its own orders
    addEventListener("twfilled", onFill);
    if (new URLSearchParams(location.search).get("tw") === "open") { setStep("kind"); setOpen(true); }
    return () => { clearInterval(iv); off(); removeEventListener("twfilled", onFill); };
  }, [adapter, coin, refresh, ext]);

  useEffect(() => {
    w().__trampWalls = graduated ? all.map((t) => ({ id: t.id, kind: t.kind, mcap: t.mcapUsd, lo: t.mcapLoUsd, hi: t.mcapHiUsd,
      sizeUsd: t.sizeUsd, mine: t.owner === ME, status: t.status })) : [];
  }, [all, graduated, ME]);

  // Pricing: tramp amount is quote USD; wall amount is tokens × (mcap / supply).
  const priceMcap = cur * (1 + pct / 100);
  const sizeUsd = kind === "tramp" ? +amount || 0 : (+amount || 0) * (cur > 0 ? priceMcap / SUP : 0);
  useEffect(() => {
    if (!open || step !== "custom" || !(cur > 0)) { w().__twPreview = null; return; }
    adapter.preview({ token: coin, kind, mcapUsd: priceMcap, rangeWidthPct: width, amount: BigInt(0), sizeUsd }, cur).then((p) => {
      setPv(p); w().__twPreview = { kind, mcap: priceMcap, lo: p.mcapLoUsd, hi: p.mcapHiUsd, sizeUsd, mine: true, status: "active" };
    });
  }, [open, step, kind, priceMcap, width, sizeUsd, cur, adapter, coin]);
  useEffect(() => () => { w().__twPreview = null; }, []);

  const chooseKind = (k: TrampWallKind) => { setKind(k); setPct(k === "tramp" ? -Math.abs(pct || 8) : Math.abs(pct || 8)); setAmount(k === "tramp" ? "250" : simulator && cur > 0 ? String(Math.round(250 / (cur * 1.08 / SUP))) : "1000000"); };
  const confirm = async () => {
    const r = await adapter.place({ token: coin, kind, mcapUsd: priceMcap, rangeWidthPct: width, amount: BigInt(Math.floor((+amount || 0) * 1e6)), sizeUsd });
    setMsg(r.ok ? `${kind === "tramp" ? "Tramp" : "Wall"} placed ✦` : r.reason || "That didn't go through. Try again.");
    if (r.ok) { setOpen(false); refresh(); }
  };
  const cancel = async (id: string) => { await adapter.cancel(id); refresh(); };

  // the flight top bar's menu (components/flight/HudModeToggle) is where Tramp / Wall lives now (maker Nov 12): publish the
  // state it shows, and open the flow / your list when it asks
  const activeN = mine.filter((m) => m.status === "active").length;
  useEffect(() => { dispatchEvent(new CustomEvent("disciple:twstate", { detail: { on: graduated, active: activeN, sample } })); }, [graduated, activeN, sample]);
  useEffect(() => () => { dispatchEvent(new CustomEvent("disciple:twstate", { detail: { on: false, active: 0, sample: false } })); }, []);
  useEffect(() => {
    const h = (e: Event) => { const o = (e as CustomEvent<{ open?: string }>).detail?.open; if (o === "place") openFlow(); else if (o === "list") setListOpen((v) => !v); };
    addEventListener("disciple:tw", h); return () => removeEventListener("disciple:tw", h);
  });

  if (!graduated) return null;
  /* brand v3 (approved HUD mockups): navy glass cards, hairline border, Barlow Condensed headings, Geist body, white-pill
     choices and a solid gold confirm (was the gold-gradient pill, mono text and glowing ring) */
  const card: React.CSSProperties = { boxSizing: "border-box", borderRadius: HUD.radius, background: "rgba(18,19,39,.94)", border: `1px solid ${HUD.border}`,
    boxShadow: "0 16px 40px rgba(0,0,0,.45)", color: HUD.text, font: `13px/1.4 ${HUD.ui}` };
  const h2: React.CSSProperties = { font: `700 15px/1 ${HUD.game}`, letterSpacing: "1.5px", color: HUD.champagne };
  const dim: React.CSSProperties = { color: HUD.dim, fontSize: 12 };
  const choice = (on: boolean, col = "#F2F3F7"): React.CSSProperties => ({ all: "unset", boxSizing: "border-box", cursor: "pointer", padding: "10px 12px", borderRadius: 12, textAlign: "left",
    border: `1px solid ${on ? col : HUD.border}`, background: on ? "rgba(255,255,255,.08)" : "rgba(11,12,14,.6)" });
  const sampleTag = sample && <span style={{ marginLeft: 6, padding: "2px 6px", borderRadius: 6, border: "1px solid rgba(255,159,184,.5)", color: "#FF9FB8", font: `700 11px/1 ${HUD.game}`, letterSpacing: ".06em", verticalAlign: 2 }}>SAMPLE</span>;
  const kindCol = (k: TrampWallKind) => (k === "tramp" ? HUD.up : "#FF7FB3");
  return (
    <>
      {/* phones: the two pills over the trade bar. Desktop: the top bar's menu opens these (no pills, approved mockup) */}
      <div className="ap-bc z-30 flex gap-2" style={{ bottom: "calc(var(--ap-tb-h, 80px) + 16px + var(--ap-safe-bottom))", }} data-desk-hide="1">
        <button data-testid="tw-open" onClick={openFlow}
          style={{ all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, padding: "0 14px", minHeight: 36, borderRadius: 999, background: HUD.glass, border: `1px solid ${HUD.border}`,
            color: HUD.champagne, font: `700 14px/1 ${HUD.game}`, letterSpacing: ".06em" }}>
          <Icon name="tramp" size={16} /> TRAMP / <Icon name="wall" size={16} /> WALL{sampleTag}
        </button>
        <button data-testid="tw-mine" onClick={() => setListOpen((v) => !v)}
          style={{ all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, padding: "0 14px", minHeight: 36, borderRadius: 999, background: HUD.glass, border: `1px solid ${HUD.border}`,
            color: HUD.text, font: `500 13px/1 ${HUD.ui}` }}>
          Mine ({activeN})
        </button>
      </div>

      {listOpen && (
        <div data-testid="tw-list" style={{ ...card, position: "fixed", right: 20, top: 80, zIndex: 63, width: "min(360px, calc(100vw - 40px))", padding: "14px 16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <span style={h2}>MY TRAMPS AND WALLS{sampleTag}</span>
            <button type="button" aria-label="Close" onClick={() => setListOpen(false)} style={{ all: "unset", cursor: "pointer", color: HUD.dim, fontSize: 18, lineHeight: 1 }}>×</button>
          </div>
          {mine.length === 0 && <div style={dim}>None yet. Place a trampoline under the rocket to catch it.</div>}
          {mine.map((t) => (
            <div key={t.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 0", borderTop: `1px solid ${HUD.border}` }}>
              <div>
                <span style={{ color: kindCol(t.kind), font: `700 15px/1 ${HUD.game}`, letterSpacing: ".04em" }}><Icon name={t.kind === "tramp" ? "tramp" : "wall"} size={13} /> {t.kind === "tramp" ? "TRAMP" : "WALL"}</span>{" "}
                <span style={{ font: `700 15px/1 ${HUD.game}` }}>{fmt(t.sizeUsd)}</span> <span style={dim}>at {fmt(t.mcapUsd)}</span>
                <div style={dim}>{t.status === "active" ? `Active · ${Math.round(t.filledFrac * 100)}% filled · +${pointsFor(t.sizeUsd)} pts once filled` : `${t.status[0].toUpperCase()}${t.status.slice(1)} · ${t.pointsEarned} pts`}</div>
              </div>
              {t.status === "active" && <button onClick={() => cancel(t.id)} style={{ all: "unset", cursor: "pointer", padding: "6px 10px", borderRadius: 10, border: "1px solid rgba(240,48,127,.5)", color: "#FF9CC4", font: `700 13px/1 ${HUD.game}`, letterSpacing: ".04em" }}>CANCEL</button>}
            </div>
          ))}
        </div>
      )}

      {picking && (
        <div className="fixed inset-0 z-40 cursor-ns-resize" data-testid="tw-pick"
          onPointerMove={(e) => { const m = flight()?.screenYToMcap?.(e.clientY); if (m && cur > 0) setPct(+(((m - cur) / cur) * 100).toFixed(2)); }}
          onPointerUp={() => setPicking(false)}>
          <div className="pointer-events-none absolute left-1/2 top-6 -translate-x-1/2" style={{ ...card, padding: "8px 14px", borderRadius: 999, color: HUD.champagne }}>
            Drag up or down on the sky, release to set the {kind} ({pct >= 0 ? "+" : ""}{pct.toFixed(1)}%)
          </div>
        </div>
      )}

      {open && !picking && (
        <div className="fixed inset-0 z-40 flex items-center justify-center" style={{ background: "rgba(4,5,14,.5)", backdropFilter: "blur(3px)" }} onClick={() => setOpen(false)}>
          <div data-testid="tw-modal" onClick={(e) => e.stopPropagation()} style={{ ...card, position: "relative", width: 440, maxWidth: "calc(100vw - 32px)", padding: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <h2 style={{ ...h2, fontSize: 20, margin: 0 }}>PLACE A {kind === "tramp" ? "TRAMPOLINE" : "WALL"}{sampleTag}</h2>
              <button type="button" aria-label="Close" onClick={() => setOpen(false)} style={{ all: "unset", cursor: "pointer", color: HUD.dim, fontSize: 20, lineHeight: 1 }}>×</button>
            </div>
            <p style={{ ...dim, margin: "6px 0 14px" }}>Altitude now {fmt(cur)}. {sample ? "Sample only: local, not on-chain. " : simulator ? "Simulator. " : ""}A limit order with no fee share: once the price fully crosses it, a keeper closes it for a 0.1% tip.
              {" "}{TRAMP_WALL_POINTS_PER_USD} points per $1 of size, only when it fills.</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
              {(["tramp", "wall"] as const).map((k) => (
                <button key={k} data-testid={`tw-kind-${k}`} onClick={() => { chooseKind(k); setStep("preset"); }} style={choice(step !== "kind" && kind === k, kindCol(k))}>
                  <div style={{ font: `700 18px/1.1 ${HUD.game}`, color: kindCol(k) }}><Icon name={k === "tramp" ? "tramp" : "wall"} size={18} /> {k === "tramp" ? "TRAMP" : "WALL"}</div>
                  <div style={dim}>{k === "tramp" ? "Below the price · catches a drop" : "Above the price · slows a climb"}</div>
                </button>
              ))}
            </div>
            {step === "kind" && <p style={{ ...dim, textAlign: "center", margin: 0 }}>Pick one, then choose a size.</p>}
            {step === "preset" && (
              <div data-testid="tw-presets" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {PRESETS.map((p) => { const q = presetParams(kind, p), r = pvs[p.id], off = r ? !r.valid : false; return (
                  <button key={p.id} data-testid={`tw-preset-${p.id}`} disabled={off} onClick={() => placePreset(p)} style={{ ...choice(false), opacity: off ? 0.4 : 1, cursor: off ? "default" : "pointer" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}><span style={{ font: `700 16px/1 ${HUD.game}`, color: HUD.champagne }}>{p.label.toUpperCase()}</span><span style={{ font: `700 16px/1 ${HUD.game}` }}>{fmt(q.sizeUsd)}</span></div>
                    <div style={{ fontSize: 12, marginTop: 4 }}>{q.pct > 0 ? "+" : ""}{q.pct}% · ±{p.width / 2}% · at {fmt(q.priceMcap)}</div>
                    <div style={dim}>{p.blurb} · +{pointsFor(q.sizeUsd)} pts if filled{r && !r.valid && r.reason ? ` · ${r.reason}` : ""}</div>
                  </button>); })}
                <button data-testid="tw-preset-custom" onClick={() => setStep("custom")} style={{ ...choice(false), borderStyle: "dashed", borderColor: "rgba(243,223,168,.4)" }}>
                  <div style={{ font: `700 16px/1 ${HUD.game}`, color: HUD.champagne }}>CUSTOM</div><div style={dim}>Set the price, range and amount</div>
                </button>
              </div>
            )}
            {step === "preset" && msg && <div style={{ marginTop: 8, textAlign: "center", color: HUD.champagne, fontSize: 12 }}>{msg}</div>}
            {step === "custom" && (<>
            <button onClick={() => setStep("preset")} style={{ all: "unset", cursor: "pointer", ...dim, marginBottom: 8 }}>← Sizes</button>
            <label style={{ ...dim, display: "block" }}>Price ({pct >= 0 ? "+" : ""}{pct.toFixed(1)}% from now)</label>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <input type="range" min={kind === "tramp" ? -60 : 1} max={kind === "tramp" ? -1 : 200} step={0.5} value={pct} onChange={(e) => setPct(+e.target.value)} style={{ flex: 1, accentColor: HUD.gold }} />
              <input value={fmt(priceMcap)} readOnly style={{ width: 84, boxSizing: "border-box", padding: "6px 8px", borderRadius: 10, border: `1px solid ${HUD.border}`, background: "rgba(11,12,14,.6)", color: HUD.text, font: `700 14px/1 ${HUD.game}`, textAlign: "right" }} />
              <button onClick={() => setPicking(true)} style={{ all: "unset", cursor: "pointer", padding: "6px 10px", borderRadius: 10, border: "1px dashed rgba(243,223,168,.4)", color: HUD.champagne, fontSize: 12 }}>Drag on sky</button>
            </div>
            <label style={{ ...dim, display: "block" }}>Range width · {width}%</label>
            <input type="range" min={0.5} max={20} step={0.5} value={width} onChange={(e) => setWidth(+e.target.value)} style={{ width: "100%", accentColor: HUD.gold, marginBottom: 12 }} />
            <label style={{ ...dim, display: "block" }}>Amount ({kind === "tramp" ? "cash, USD" : "tokens"})</label>
            <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} style={{ width: "100%", boxSizing: "border-box", margin: "4px 0 14px", padding: "8px 12px", borderRadius: 12, border: `1px solid ${HUD.border}`, background: "rgba(11,12,14,.6)", color: HUD.text, font: `700 16px/1 ${HUD.game}` }} />
            {pv && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 14, padding: 10, borderRadius: 12, border: `1px solid ${HUD.border}`, background: "rgba(255,255,255,.04)", textAlign: "center" }}>
                <div><div style={dim}>Distance</div><div style={{ font: `700 18px/1.1 ${HUD.game}` }}>{pv.distancePct >= 0 ? "+" : ""}{pv.distancePct.toFixed(1)}%</div></div>
                <div><div style={dim}>Keeper tip</div><div style={{ font: `700 18px/1.1 ${HUD.game}` }}>0.1%</div></div>
                <div><div style={dim}>Points if filled</div><div style={{ font: `700 18px/1.1 ${HUD.game}`, color: HUD.champagne }}>+{pv.pointsIfFilled}</div></div>
              </div>
            )}
            {pv && !pv.valid && <div style={{ marginBottom: 8, textAlign: "center", color: "#FF9CC4", fontSize: 12 }}>{pv.reason}</div>}
            {msg && <div style={{ marginBottom: 8, textAlign: "center", color: HUD.champagne, fontSize: 12 }}>{msg}</div>}
            <button data-testid="tw-confirm" disabled={!pv?.valid} onClick={confirm}
              style={{ all: "unset", boxSizing: "border-box", width: "100%", textAlign: "center", cursor: pv?.valid ? "pointer" : "default", padding: "14px 0", borderRadius: 12, background: HUD.gold, color: HUD.ink,
                font: `800 18px/1 ${HUD.game}`, letterSpacing: ".04em", opacity: pv?.valid ? 1 : 0.4 }}>
              PLACE {kind === "tramp" ? "TRAMP" : "WALL"} · {fmt(sizeUsd)}
            </button>
            </>)}
          </div>
        </div>
      )}
    </>
  );
}
