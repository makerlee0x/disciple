"use client";
/**
 * Graduation floor bins (LockedLP floorInfo / floorBands, lib/floor.ts).
 *  - FloorBinsCard: "floor support remaining" headline + two-layer bins chart (dollars resting per price bucket).
 *  - CoinFloor: coin-page pill → card. Hidden unless the coin has graduated AND the active chain's LockedLP has a
 *    floor for it (pre-floor LockedLP / bands = 0 / not deployed → renders nothing). Re-reads after the user's own
 *    fills (disciple:fillreceipt) and every 20 s for everyone else's trades.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { fmtUsd } from "@/lib/config";
import { readFloor, floorLockedLP, type FloorView } from "@/lib/floor";
import { coinFacts, readMarket } from "@/lib/protocol-viem";
import { pc } from "@/components/claims/ui";
import s from "./floor.module.css";

const f1 = (n: number) => n.toFixed(1);
const kUsd = (v: number) => (v >= 1000 ? `$${+(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}K` : `$${Math.round(v)}`);

/** Two-layer bins: x = market cap (log, low → high), y = dollars resting per bucket; dashed = what was seeded. */
export function FloorBinsChart({ view, nowMcap, compact = false }: { view: FloorView; nowMcap?: number | null; compact?: boolean }) {
  const W = 400, H = compact ? 150 : 170, L = 6, R = 6, T = 16, B = 22;
  const lo = Math.log(view.mcapMin), hi = Math.log(view.mcapMax);
  const X = (m: number) => L + ((Math.log(Math.max(m, view.mcapMin * 0.5)) - lo) / (hi - lo)) * (W - L - R);
  const max = Math.max(1e-9, ...view.bins.map((b) => b.topSeeded + b.bottomSeeded));
  const Y = (v: number) => T + (H - T - B) * (1 - v / max);
  const y0 = Y(0);
  const ticks = [3_333, 10_000, 25_000, 33_333].filter((t) => t >= view.mcapMin * 0.98 && t <= view.mcapMax * 1.02);
  const nowIn = nowMcap != null && Number.isFinite(nowMcap) && nowMcap > 0;
  const nx = nowIn ? Math.min(W - R, Math.max(L, X(nowMcap!))) : 0;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={s.svg} role="img" aria-label="Floor support by market cap">
      <line x1={L} x2={W - R} y1={f1(y0)} y2={f1(y0)} stroke="var(--dsc-border)" />
      {view.bins.map((b, k) => {
        const x1 = X(b.mcapLo), x2 = X(b.mcapHi), w = Math.max(0.5, x2 - x1 - 0.6);
        const yb = Y(b.bottom), yt = Y(b.bottom + b.top), yg = Y(b.bottomSeeded + b.topSeeded);
        return (
          <g key={k}>
            <rect x={f1(x1)} y={f1(yg)} width={f1(w)} height={f1(Math.max(0, y0 - yg))} fill="none" stroke="var(--dsc-muted)" strokeOpacity=".35" strokeDasharray="2 2" strokeWidth=".8" />
            {b.bottom > 0 && <rect x={f1(x1)} y={f1(yb)} width={f1(w)} height={f1(y0 - yb)} fill="var(--dsc-primary)" fillOpacity=".85" />}
            {b.top > 0 && <rect x={f1(x1)} y={f1(yt)} width={f1(w)} height={f1(yb - yt)} fill="var(--dsc-gold)" fillOpacity=".9" />}
          </g>
        );
      })}
      {ticks.map((t) => (
        <text key={t} x={f1(Math.min(W - R - 2, Math.max(L + 2, X(t))))} y={H - 6} textAnchor={X(t) > W - 40 ? "end" : X(t) < 40 ? "start" : "middle"} className={s.axis}>{kUsd(t)}</text>
      ))}
      {nowIn && (
        <g>
          <line x1={f1(nx)} x2={f1(nx)} y1={T - 4} y2={f1(y0)} stroke="var(--dsc-text)" strokeDasharray="3 3" strokeWidth="1" />
          <text x={f1(nx - 4)} y={T - 6} textAnchor="end" className={s.now}>Now {kUsd(nowMcap!)}</text>
        </g>
      )}
    </svg>
  );
}

export function FloorBinsCard({ view, nowMcap, onClose, compact }: { view: FloorView; nowMcap?: number | null; onClose?: () => void; compact?: boolean }) {
  const pct = Math.round(view.remainingFrac * 100);
  return (
    <section className={s.card} data-testid="floor-bins" aria-label="Floor support remaining">
      <div className={s.head}>
        <span className={s.eyebrow}>Floor support remaining</span>
        {onClose && <button type="button" className={s.close} onClick={onClose} aria-label="Close">Close</button>}
      </div>
      <div className={s.big}>{fmtUsd(view.remainingUsd)}<small>of {fmtUsd(view.seededUsd)} · {pct}%</small></div>
      <div className={s.meter}><i style={{ width: `${pct}%` }} /></div>
      <FloorBinsChart view={view} nowMcap={nowMcap} compact={compact} />
      <div className={s.legend}>
        <span><i className={`${s.sw} ${s.swTop}`} />Top layer <b>{fmtUsd(view.topUsd)}</b></span>
        <span><i className={`${s.sw} ${s.swBottom}`} />Bottom layer <b>{fmtUsd(view.bottomUsd)}</b></span>
        <span><i className={`${s.sw} ${s.swGhost}`} />At graduation</span>
      </div>
      <p className={s.note}>Locked at graduation. It buys the coin if the price falls into it.</p>
    </section>
  );
}

export default function CoinFloor({ token }: { token: string }) {
  const [view, setView] = useState<FloorView | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const busy = useRef(false);
  const valid = /^0x[0-9a-fA-F]{40}$/.test(token) && !!floorLockedLP();

  const load = useCallback(async () => {
    if (!valid || busy.current) return;
    busy.current = true;
    try {
      const c = pc(), t = token as Address;
      const f = await coinFacts(c, t);
      if (!f.graduated) { setView(null); return; }
      const [v, m] = await Promise.all([readFloor(c, t, f.curve), readMarket(c, t)]);
      setView(v); setNow(m?.mcapUsd ?? null);
    } catch { setView(null); } finally { busy.current = false; }
  }, [token, valid]);

  useEffect(() => {
    if (!valid) return;
    void load();
    const id = setInterval(() => void load(), 20_000);
    let tm: ReturnType<typeof setTimeout> | undefined;
    const onFill = () => { clearTimeout(tm); tm = setTimeout(() => void load(), 2_500); }; // after the user's own trade lands
    addEventListener("disciple:fillreceipt", onFill);
    return () => { clearInterval(id); clearTimeout(tm); removeEventListener("disciple:fillreceipt", onFill); };
  }, [valid, load]);

  if (!view) return null;
  return (
    <>
      <div className={s.pill} data-testid="floor-pill">
        <span className={s.lbl}>Floor support</span>
        <strong>{fmtUsd(view.remainingUsd)}</strong>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? "Hide" : "Bins"}</button>
      </div>
      {open && <FloorBinsCard view={view} nowMcap={now} onClose={() => setOpen(false)} />}
    </>
  );
}
