"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address } from "@/lib/protocol";
import type { TrampWall, TrampWallKind, TrampWallPreview } from "@/lib/trampwalls/adapter";
import { createMockAdapter, MOCK_ME, mockMarkFilled } from "@/lib/trampwalls/mock";

type FlightApi = { S?: { confirmed?: { mcap?: number } }; screenYToMcap?: (y: number) => number };
type TwWindow = Window & { __flight?: unknown; __trampWalls?: unknown[]; __twPreview?: unknown };
const w = () => window as unknown as TwWindow;
const flight = () => w().__flight as FlightApi | undefined;
const curMcap = () => flight()?.S?.confirmed?.mcap || 0;
const fmt = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`;

export default function TrampWallPanel({ token }: { token: string }) {
  const adapter = useMemo(() => createMockAdapter(curMcap), []);
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

  const refresh = useCallback(async () => {
    const m = curMcap(); setCur(m);
    setGraduated(await adapter.isGraduated(coin));
    setAll(await adapter.list(coin));
    setMine(await adapter.listMine(MOCK_ME, coin));
  }, [adapter, coin]);

  useEffect(() => {
    refresh(); const iv = setInterval(refresh, 2000);
    const off = adapter.onEvent(coin, () => refresh());
    const onFill = (e: Event) => { mockMarkFilled((e as CustomEvent).detail.id); refresh(); };
    addEventListener("twfilled", onFill);
    if (new URLSearchParams(location.search).get("tw") === "open") setOpen(true);
    return () => { clearInterval(iv); off(); removeEventListener("twfilled", onFill); };
  }, [adapter, coin, refresh]);

  useEffect(() => {
    w().__trampWalls = graduated ? all.map((t) => ({ id: t.id, kind: t.kind, mcap: t.mcapUsd, lo: t.mcapLoUsd, hi: t.mcapHiUsd,
      sizeUsd: t.sizeUsd, mine: t.owner === MOCK_ME, status: t.status })) : [];
  }, [all, graduated]);

  // Mock pricing: tramp amount is quote USD; wall amount is tokens × (mcap / 1e9 supply).
  const priceMcap = cur * (1 + pct / 100);
  const sizeUsd = kind === "tramp" ? +amount || 0 : (+amount || 0) * (cur > 0 ? priceMcap / 1e9 : 0);
  useEffect(() => {
    if (!open || !(cur > 0)) { w().__twPreview = null; return; }
    adapter.preview({ token: coin, kind, mcapUsd: priceMcap, rangeWidthPct: width, amount: BigInt(0), sizeUsd }, cur).then((p) => {
      setPv(p); w().__twPreview = { kind, mcap: priceMcap, lo: p.mcapLoUsd, hi: p.mcapHiUsd, sizeUsd, mine: true, status: "active" };
    });
  }, [open, kind, priceMcap, width, sizeUsd, cur, adapter, coin]);
  useEffect(() => () => { w().__twPreview = null; }, []);

  const chooseKind = (k: TrampWallKind) => { setKind(k); setPct(k === "tramp" ? -Math.abs(pct || 8) : Math.abs(pct || 8)); setAmount(k === "tramp" ? "250" : "1000000"); };
  const confirm = async () => {
    const r = await adapter.place({ token: coin, kind, mcapUsd: priceMcap, rangeWidthPct: width, amount: BigInt(Math.floor((+amount || 0) * 1e6)), sizeUsd });
    setMsg(r.ok ? `${kind === "tramp" ? "Tramp" : "Wall"} placed ✦` : r.reason || "failed");
    if (r.ok) { setOpen(false); refresh(); }
  };
  const cancel = async (id: string) => { await adapter.cancel(id); refresh(); };

  if (!graduated) return null;
  return (
    <>
      <div className="fixed bottom-[72px] left-1/2 z-30 flex -translate-x-1/2 gap-2">
        <button data-testid="tw-open" onClick={() => setOpen(true)}
          className="rounded-full border border-[#ffe7a3]/70 bg-gradient-to-b from-[#3a2a07]/90 to-[#120d02]/90 px-5 py-2 font-display text-sm font-bold tracking-wider text-[#ffe7a3] shadow-[0_0_24px_rgba(255,215,110,.45)] transition hover:scale-105">
          🛟 TRAMP / 🧱 WALL
        </button>
        <button data-testid="tw-mine" onClick={() => setListOpen((v) => !v)}
          className="rounded-full border border-white/20 bg-black/60 px-4 py-2 font-mono text-xs text-white/80 hover:text-white">
          My tramps & walls ({mine.filter((m) => m.status === "active").length})
        </button>
      </div>

      {listOpen && (
        <div data-testid="tw-list" className="fixed bottom-[124px] left-1/2 z-30 w-[420px] -translate-x-1/2 rounded-2xl border border-[#ffe7a3]/30 bg-[#07070f]/95 p-4 font-mono text-xs text-white shadow-2xl">
          <div className="mb-2 font-display text-base text-[#ffe7a3]">My tramps & walls</div>
          {mine.length === 0 && <div className="text-white/50">None yet — place a trampoline under the rocket.</div>}
          {mine.map((t) => (
            <div key={t.id} className="flex items-center justify-between border-t border-white/10 py-2">
              <div>
                <span className={t.kind === "tramp" ? "text-[#ffd76e]" : "text-[#ff8a7a]"}>{t.kind === "tramp" ? "🛟 TRAMP" : "🧱 WALL"}</span>{" "}
                {fmt(t.sizeUsd)} @ {fmt(t.mcapUsd)}
                <div className="text-white/50">{t.status.toUpperCase()} · fees {fmt(t.feesEarnedUsd)} · {t.pointsEarned} pts</div>
              </div>
              {t.status === "active" && <button onClick={() => cancel(t.id)} className="rounded-md border border-red-400/50 px-2 py-1 text-red-300 hover:bg-red-500/20">Cancel</button>}
            </div>
          ))}
        </div>
      )}

      {picking && (
        <div className="fixed inset-0 z-40 cursor-ns-resize" data-testid="tw-pick"
          onPointerMove={(e) => { const m = flight()?.screenYToMcap?.(e.clientY); if (m && cur > 0) setPct(+(((m - cur) / cur) * 100).toFixed(2)); }}
          onPointerUp={() => setPicking(false)}>
          <div className="pointer-events-none absolute left-1/2 top-6 -translate-x-1/2 rounded-full bg-black/70 px-4 py-1 font-mono text-xs text-[#ffe7a3]">
            Drag up/down on the chart · release to set {kind} ({pct >= 0 ? "+" : ""}{pct.toFixed(1)}%)
          </div>
        </div>
      )}

      {open && !picking && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-[2px]" onClick={() => setOpen(false)}>
          <div data-testid="tw-modal" onClick={(e) => e.stopPropagation()}
            className="relative w-[440px] rounded-3xl border border-[#ffe7a3]/50 bg-gradient-to-b from-[#1b1630] via-[#0c0a18] to-[#05040a] p-6 text-white shadow-[0_0_60px_rgba(255,215,110,.35)]">
            <div className="pointer-events-none absolute -top-5 left-1/2 h-8 w-40 -translate-x-1/2 rounded-[50%] border-4 border-[#ffe7a3]/80 shadow-[0_0_30px_#ffe7a3]" />
            <h2 className="text-center font-display text-2xl font-bold tracking-wide text-[#ffe7a3]">Place a {kind === "tramp" ? "Trampoline" : "Wall"}</h2>
            <p className="mb-4 text-center font-mono text-[11px] text-white/60">current mcap {fmt(cur)} · earn the ~0.11% hook donation while in range</p>
            <div className="mb-4 grid grid-cols-2 gap-2">
              {(["tramp", "wall"] as const).map((k) => (
                <button key={k} data-testid={`tw-kind-${k}`} onClick={() => chooseKind(k)}
                  className={`rounded-xl border-2 px-3 py-3 text-left transition ${kind === k ? (k === "tramp" ? "border-[#ffd76e] bg-[#ffd76e]/15 shadow-[0_0_20px_rgba(255,215,110,.4)]" : "border-[#ff8a7a] bg-[#ff8a7a]/15 shadow-[0_0_20px_rgba(255,120,100,.4)]") : "border-white/15 bg-white/5"}`}>
                  <div className="font-display text-lg">{k === "tramp" ? "🛟 Tramp" : "🧱 Wall"}</div>
                  <div className="font-mono text-[10px] text-white/60">{k === "tramp" ? "Quote LP below · support" : "Token LP above · resistance"}</div>
                </button>
              ))}
            </div>
            <label className="font-mono text-[11px] uppercase text-white/60">Price ({pct >= 0 ? "+" : ""}{pct.toFixed(1)}% from current)</label>
            <div className="mb-3 flex items-center gap-2">
              <input type="range" min={kind === "tramp" ? -60 : 1} max={kind === "tramp" ? -1 : 200} step={0.5} value={pct} onChange={(e) => setPct(+e.target.value)} className="flex-1 accent-[#ffd76e]" />
              <input value={fmt(priceMcap)} readOnly className="w-24 rounded-md bg-black/50 px-2 py-1 text-right font-mono text-xs" />
              <button onClick={() => setPicking(true)} className="rounded-md border border-[#ffe7a3]/50 px-2 py-1 font-mono text-[10px] text-[#ffe7a3]">drag on chart</button>
            </div>
            <label className="font-mono text-[11px] uppercase text-white/60">Range width (optional) · {width}%</label>
            <input type="range" min={0.5} max={20} step={0.5} value={width} onChange={(e) => setWidth(+e.target.value)} className="mb-3 w-full accent-[#ffd76e]" />
            <label className="font-mono text-[11px] uppercase text-white/60">Amount ({kind === "tramp" ? "quote, USD" : "tokens"})</label>
            <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} className="mb-4 w-full rounded-lg border border-white/15 bg-black/50 px-3 py-2 font-mono" />
            {pv && (
              <div className="mb-4 grid grid-cols-3 gap-2 rounded-xl border border-white/10 bg-white/5 p-3 text-center font-mono text-[11px]">
                <div><div className="text-white/50">est. fees/day</div><div className="text-base text-[#9ff3c8]">{fmt(pv.estFeeShareUsdPerDay)}</div></div>
                <div><div className="text-white/50">pool share</div><div className="text-base">{pv.estSharePct.toFixed(1)}%</div></div>
                <div><div className="text-white/50">points if filled</div><div className="text-base text-[#ffe7a3]">+{pv.pointsIfFilled}</div></div>
              </div>
            )}
            {pv && !pv.valid && <div className="mb-2 text-center font-mono text-xs text-red-300">{pv.reason}</div>}
            {msg && <div className="mb-2 text-center font-mono text-xs text-[#ffe7a3]">{msg}</div>}
            <button data-testid="tw-confirm" disabled={!pv?.valid} onClick={confirm}
              className="w-full rounded-xl bg-gradient-to-r from-[#ffd76e] via-[#fff7df] to-[#ffd76e] py-3 font-display text-lg font-bold text-[#2a1d00] shadow-[0_0_30px_rgba(255,215,110,.6)] disabled:opacity-40">
              ✦ Confirm {kind === "tramp" ? "Tramp" : "Wall"} ({fmt(sizeUsd)})
            </button>
          </div>
        </div>
      )}
    </>
  );
}
