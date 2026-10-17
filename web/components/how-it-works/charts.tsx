/**
 * /how-it-works charts: inline SVG, server-rendered, no chart library. Text comes from content/how-it-works.ts.
 * The curve is the real constant-product bonding curve shape ($7K → $33K over 72% of supply); phase 2 is illustrative.
 */
import { HIW_FEES, HIW_PHASES } from "@/content/how-it-works";
import { POOL_WANDER, SPARKS } from "./chartData";
import s from "./charts.module.css";

const f1 = (n: number) => n.toFixed(1);

/** Bonding curve → Uniswap v4. `compact` is a taller, larger-type layout for phones (same data). */
export function CurveChart({ compact = false }: { compact?: boolean }) {
  const C = HIW_PHASES.chart;
  const W = compact ? 360 : 1000, H = compact ? 300 : 300;
  const L = compact ? 40 : 58, R = compact ? 8 : 20, T = compact ? 44 : 18, B = compact ? 36 : 40;
  const fs = compact ? 10 : 11;
  const gx = L + (W - L - R) * 0.72;
  const X = (sold: number) => L + (gx - L) * (sold / 0.72);
  const Y = (m: number) => T + (H - T - B) * (1 - m / 48000);
  const y0 = (0.72 * Math.sqrt(33 / 7)) / (Math.sqrt(33 / 7) - 1);
  const pts: [number, number][] = [];
  for (let i = 0; i <= 120; i++) { const sold = (i / 120) * 0.72; pts.push([X(sold), Y(7000 * (y0 / (y0 - sold)) ** 2)]); }
  const path = "M" + pts.map(([x, y]) => `${f1(x)},${f1(y)}`).join(" L");
  const area = `${path} L${f1(gx)},${f1(Y(0))} L${L},${f1(Y(0))} Z`;
  const p2 = "M" + POOL_WANDER.map((m, i) => `${f1(gx + ((W - R - gx) * i) / (POOL_WANDER.length - 1))},${f1(Y(m))}`).join(" L");
  const ticks = compact ? [0, 7000, 15000, 25000, 33000, 45000] : [0, 7000, 15000, 25000, 33000, 45000];
  const xt = compact ? [0, 0.36, 0.72] : [0, 0.18, 0.36, 0.54, 0.72];
  const gid = compact ? "hiwCurveAreaM" : "hiwCurveArea";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={s.svg} role="img" aria-label={C.title}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8585AA" stopOpacity=".35" /><stop offset="1" stopColor="#8585AA" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x={f1(gx)} y={T} width={f1(W - R - gx)} height={H - T - B} fill="rgba(68,66,106,.18)" />
      {ticks.map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={f1(Y(v))} y2={f1(Y(v))} stroke="rgba(201,206,214,.08)" />
          <text x={L - 8} y={f1(Y(v) + 4)} textAnchor="end" className={s.mono} fontSize={fs} fill="#9095A0">${v / 1000}K</text>
        </g>
      ))}
      {xt.map((v) => <text key={v} x={f1(X(v))} y={H - B + 18} textAnchor="middle" className={s.mono} fontSize={fs} fill="#9095A0">{Math.round(v * 100)}%</text>)}
      <path d={area} fill={`url(#${gid})`} />
      <path d={path} fill="none" stroke="#E8EAEE" strokeWidth="2.2" />
      <path d={p2} fill="none" stroke="#AEABCC" strokeWidth="1.8" strokeDasharray="5 5" />
      <line x1={f1(gx)} x2={f1(gx)} y1={T} y2={H - B} stroke="rgba(232,234,238,.5)" strokeDasharray="3 4" />
      <circle cx={X(0)} cy={f1(Y(7000))} r="5" fill="#0B0C0E" stroke="#E8EAEE" strokeWidth="2" />
      <text x={X(0) + 10} y={f1(Y(7000) - 10)} className={s.ui} fontSize={compact ? 11.5 : 13} fill="#E8EAEE">{C.start}</text>
      <circle cx={f1(gx)} cy={f1(Y(33000))} r="7" fill="#E8EAEE" />
      <circle cx={f1(gx)} cy={f1(Y(33000))} r="14" fill="none" stroke="rgba(232,234,238,.35)" />
      <text x={f1(gx - 14)} y={f1(Y(33000) - (compact ? 10 : 4))} textAnchor="end" className={s.ui} fontSize={compact ? 11.5 : 13} fontWeight="600" fill="#E8EAEE">{C.grad}</text>
      {compact ? (
        <>
          <text x={L} y={12} className={s.mono} fontSize={9.5} letterSpacing="1.2" fill="#BCC0CA">{C.phase1}</text>
          <text x={L} y={28} className={s.mono} fontSize={9.5} letterSpacing="1.2" fill="#BCC0CA">{C.phase2}</text>
          <text x={f1((L + gx) / 2)} y={H - 4} textAnchor="middle" className={s.mono} fontSize={9.5} letterSpacing="1" fill="#9095A0">{C.xPhase1}</text>
        </>
      ) : (
        <>
          <text x={L + 6} y={T + 14} className={s.mono} fontSize="10.5" letterSpacing="1.5" fill="#BCC0CA">{C.phase1}</text>
          <text x={f1(gx + 14)} y={T + 14} className={s.mono} fontSize="10.5" letterSpacing="1.5" fill="#BCC0CA">{C.phase2}</text>
          <text x={f1(gx + 14)} y={T + 30} className={s.mono} fontSize="10" fill="#9095A0">{C.phase2Note}</text>
          <text x={f1((L + gx) / 2)} y={H - 4} textAnchor="middle" className={s.mono} fontSize="10.5" letterSpacing="1" fill="#9095A0">{C.xPhase1}</text>
          <text x={f1((gx + W - R) / 2)} y={H - 4} textAnchor="middle" className={s.mono} fontSize="10.5" letterSpacing="1" fill="#9095A0">{C.xPhase2}</text>
        </>
      )}
    </svg>
  );
}

/** Difficulty sparkline (decorative; the card text carries the meaning). Stroke = the card's --c. */
export function Spark({ id }: { id: keyof typeof SPARKS }) {
  const W = 300, H = 64;
  const v = SPARKS[id];
  const pts = v.map((y, i) => `${f1((i / (v.length - 1)) * W)},${f1(H - 4 - y * (H - 8))}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={s.spark} preserveAspectRatio="none" aria-hidden focusable="false">
      <polyline points={pts} fill="none" stroke="var(--c)" strokeWidth="1.8" strokeLinejoin="round" vectorEffect="non-scaling-stroke" opacity=".9" />
    </svg>
  );
}

/** Anti-snipe fee: 77.7% → 0% in 7 one-second steps. */
export function SnipeChart() {
  const C = HIW_FEES.snipeChart;
  const W = 300, H = 90;
  const pts: [number, number][] = [];
  for (let t = 0; t < 8; t++) { const bps = 7770 - Math.floor((7770 * t) / 7); pts.push([(t / 7) * (W - 30) + 24, 8 + (H - 26) * (1 - bps / 7770)]); }
  const d = `M${f1(pts[0][0])},${f1(pts[0][1])} ` + pts.slice(1).map(([x, y]) => `H${f1(x)} V${f1(y)}`).join(" ") + ` H${W - 6}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={s.snipe} role="img" aria-label={C.title}>
      <path d={d} fill="none" stroke="#FF7A3D" strokeWidth="1.8" />
      <line x1="24" x2={W - 6} y1={H - 18} y2={H - 18} stroke="rgba(201,206,214,.15)" />
      <text x="0" y="14" className={s.mono} fontSize="10" fill="#9095A0">{C.top}</text>
      <text x="0" y={H - 14} className={s.mono} fontSize="10" fill="#9095A0">{C.bottom}</text>
      <text x="24" y={H - 2} className={s.mono} fontSize="10" fill="#9095A0">{C.axis}</text>
      <text x={W - 6} y={H - 2} textAnchor="end" className={s.mono} fontSize="10" fill="#9095A0">{C.end}</text>
    </svg>
  );
}
