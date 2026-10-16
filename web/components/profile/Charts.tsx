"use client";

import { useState } from "react";

export function Sparkline({
  a, b, width = 120, height = 36,
  colorA = "#7ec8ff", colorB = "rgba(180,190,220,0.45)",
}: {
  a: { t: number; v: number }[]; b?: { t: number; v: number }[];
  width?: number; height?: number; colorA?: string; colorB?: string;
}) {
  const path = (pts: { t: number; v: number }[], color: string) => {
    if (!pts.length) return null;
    const vs = pts.map((p) => p.v);
    const min = Math.min(...vs, 0), max = Math.max(...vs, 0), span = max - min || 1;
    const ts = pts.map((p) => p.t), t0 = Math.min(...ts), t1 = Math.max(...ts), tspan = t1 - t0 || 1;
    const d = pts.map((p, i) => {
      const x = ((p.t - t0) / tspan) * (width - 4) + 2;
      const y = height - 2 - ((p.v - min) / span) * (height - 4);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    return <path d={d} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />;
  };
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      {b ? path(b, colorB) : null}
      {path(a, colorA)}
    </svg>
  );
}

export function StatRing({
  value, label, sub, size = 118, color = "#C9CED6", progress = 0.72,
}: {
  value: string; label: string; sub?: string; size?: number; color?: string; progress?: number;
}) {
  const r = (size - 12) / 2, c = 2 * Math.PI * r, p = Math.max(0, Math.min(1, progress));
  return (
    <div className="stat-ring" style={{ width: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(201,206,214,0.12)" strokeWidth={6} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={6} strokeLinecap="round"
          strokeDasharray={`${c * p} ${c * (1 - p)}`} transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ filter: `drop-shadow(0 0 6px ${color})` }} />
        <text x="50%" y="48%" textAnchor="middle" fill="#E8EAEE" fontSize={15} fontWeight={400} fontFamily="var(--dsc-font-display)">{value}</text>
        {sub ? <text x="50%" y="62%" textAnchor="middle" fill="rgba(220,228,255,0.55)" fontSize={9}>{sub}</text> : null}
      </svg>
      <div className="stat-ring-label">{label}</div>
    </div>
  );
}

export function Gauge({ value, label, max = 100, color = "#ff7eb9" }: { value: number; label: string; max?: number; color?: string }) {
  const pct = Math.max(0, Math.min(1, value / Math.max(max, 1)));
  const r = 54, circ = Math.PI * r;
  return (
    <div className="gauge">
      <svg width={140} height={90} viewBox="0 0 140 90">
        <path d="M16 78 A54 54 0 0 1 124 78" fill="none" stroke="rgba(201,206,214,0.12)" strokeWidth={10} strokeLinecap="round" />
        <path d="M16 78 A54 54 0 0 1 124 78" fill="none" stroke={color} strokeWidth={10} strokeLinecap="round"
          strokeDasharray={`${circ * pct} ${circ}`} style={{ filter: `drop-shadow(0 0 8px ${color})` }} />
        <text x="70" y="68" textAnchor="middle" fill="#E8EAEE" fontSize={22} fontWeight={400} fontFamily="var(--dsc-font-display)">
          {Math.round(value).toLocaleString()}
        </text>
      </svg>
      <div className="gauge-label">{label}</div>
    </div>
  );
}

export function Donut({ value, size = 44 }: { value: number; size?: number }) {
  const r = (size - 6) / 2, c = 2 * Math.PI * r, p = Math.max(0, Math.min(1, value));
  const col = p >= 0.5 ? "#7ec8ff" : "#ff8fab";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={4} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={col} strokeWidth={4}
        strokeDasharray={`${c * p} ${c * (1 - p)}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="54%" textAnchor="middle" fill="#eef0ff" fontSize={10} fontWeight={600}>{Math.round(p * 100)}%</text>
    </svg>
  );
}

export function LineChart({ points, height = 160, color = "#c9b6f2", formatY }: {
  points: { t: number; v: number }[]; height?: number; color?: string; formatY?: (v: number) => string;
}) {
  const width = 560;
  if (!points.length) return <div className="chart-empty">No data</div>;
  const vs = points.map((p) => p.v), min = Math.min(...vs, 0), max = Math.max(...vs, 0), span = max - min || 1;
  const t0 = points[0].t, t1 = points[points.length - 1].t, tspan = t1 - t0 || 1;
  const coords = points.map((p) => [40 + ((p.t - t0) / tspan) * (width - 56), 12 + (1 - (p.v - min) / span) * (height - 36)] as const);
  const d = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c[0]},${c[1]}`).join(" ");
  const area = `${d} L${coords[coords.length - 1][0]},${height - 20} L${coords[0][0]},${height - 20} Z`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="chart-svg" preserveAspectRatio="none">
      <path d={area} fill={color} opacity={0.12} />
      <path d={d} fill="none" stroke={color} strokeWidth={2} />
      <text x={8} y={20} fill="rgba(220,228,255,0.45)" fontSize={10}>{formatY ? formatY(max) : max.toFixed(0)}</text>
      <text x={8} y={height - 24} fill="rgba(220,228,255,0.45)" fontSize={10}>{formatY ? formatY(min) : min.toFixed(0)}</text>
    </svg>
  );
}

export function BarChart({ items, height = 140, color = "#C9CED6" }: { items: { label: string; value: number }[]; height?: number; color?: string }) {
  const width = 560;
  if (!items.length) return <div className="chart-empty">No data</div>;
  const max = Math.max(...items.map((i) => i.value), 1), bw = (width - 40) / items.length;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="chart-svg">
      {items.map((it, i) => {
        const h = (it.value / max) * (height - 36), x = 24 + i * bw, y = height - 24 - h;
        return (
          <g key={it.label + i}>
            <rect x={x + 2} y={y} width={Math.max(2, bw - 4)} height={h} rx={3} fill={color} opacity={0.85} />
            {items.length <= 14 || i % Math.ceil(items.length / 10) === 0 ? (
              <text x={x + bw / 2} y={height - 8} textAnchor="middle" fill="rgba(220,228,255,0.4)" fontSize={8}>{it.label.slice(-5)}</text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export function Histogram({ items, height = 140 }: { items: { bucket: string; count: number }[]; height?: number }) {
  return <BarChart height={height} color="#7ec8ff" items={items.map((i) => ({ label: i.bucket, value: i.count }))} />;
}

export function Heatmap({ days }: { days: { date: string; pnl: number }[] }) {
  const max = Math.max(...days.map((d) => Math.abs(d.pnl)), 1);
  const byDate = new Map(days.map((d) => [d.date, d.pnl]));
  const cells: { date: string; pnl: number }[] = [];
  const end = days.length ? new Date(days[days.length - 1].date + "T12:00:00Z") : new Date();
  for (let i = 83; i >= 0; i--) {
    const d = new Date(end); d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    cells.push({ date: key, pnl: byDate.get(key) ?? 0 });
  }
  return (
    <div className="heatmap">
      {Array.from({ length: 12 }, (_, w) => (
        <div key={w} className="heatmap-col">
          {Array.from({ length: 7 }, (_, day) => {
            const cell = cells[w * 7 + day];
            if (!cell) return <div key={day} className="heatmap-cell empty" />;
            const intensity = Math.abs(cell.pnl) / max;
            const bg = cell.pnl === 0 ? "rgba(255,255,255,0.04)"
              : cell.pnl >= 0 ? `rgba(80, 220, 140, ${0.15 + intensity * 0.75})`
              : `rgba(255, 100, 120, ${0.15 + intensity * 0.75})`;
            return <div key={day} className="heatmap-cell" title={`${cell.date}: ${cell.pnl.toFixed(0)}`} style={{ background: bg }} />;
          })}
        </div>
      ))}
    </div>
  );
}

export function RadarChart({ axes, size = 220 }: { axes: { label: string; value: number }[]; size?: number }) {
  const n = axes.length, cx = size / 2, cy = size / 2, r = size * 0.36;
  const pt = (i: number, v: number) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * r * v, cy + Math.sin(a) * r * v] as const;
  };
  const poly = axes.map((ax, i) => pt(i, Math.max(0, Math.min(1, ax.value / 100))))
    .map((p, i) => `${i === 0 ? "M" : "L"}${p[0]},${p[1]}`).join(" ") + " Z";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="radar-svg">
      {[0.25, 0.5, 0.75, 1].map((rv) => (
        <polygon key={rv} fill="none" stroke="rgba(201,206,214,0.15)" strokeWidth={1}
          points={axes.map((_, i) => pt(i, rv).join(",")).join(" ")} />
      ))}
      {axes.map((ax, i) => {
        const [x, y] = pt(i, 1), [lx, ly] = pt(i, 1.22);
        return (
          <g key={ax.label}>
            <line x1={cx} y1={cy} x2={x} y2={y} stroke="rgba(201,206,214,0.2)" />
            <text x={lx} y={ly} textAnchor="middle" fill="rgba(220,228,255,0.7)" fontSize={9}>{ax.label}</text>
          </g>
        );
      })}
      <path d={poly} fill="rgba(201,206,214,0.25)" stroke="#C9CED6" strokeWidth={1.5} />
    </svg>
  );
}

export function PlaystyleMeter({ pve, pvp }: { pve: number; pvp: number }) {
  const total = Math.max(1, pve + pvp), left = (pve / total) * 100;
  return (
    <div className="playstyle-meter">
      <div className="playstyle-labels"><span>PvE · Crew</span><span>PvP · Bombs</span></div>
      <div className="playstyle-track">
        <div className="playstyle-pve" style={{ width: `${left}%` }} />
        <div className="playstyle-pvp" style={{ width: `${100 - left}%` }} />
        <div className="playstyle-thumb" style={{ left: `${left}%` }} />
      </div>
      <div className="playstyle-scores"><span>{pve}</span><span>{pvp}</span></div>
    </div>
  );
}

export type RangeKey = "1d" | "7d" | "30d";
export const RANGE_DAYS: Record<RangeKey, number> = { "1d": 1, "7d": 7, "30d": 30 };

/** Slice a daily series to a range; for 1d (too few daily points) synthesize a deterministic hourly walk. */
export function sliceRange(points: { t: number; v: number }[], range: RangeKey, mode: "level" | "flow" = "level") {
  if (!points.length) return points;
  const end = points[points.length - 1].t;
  const start = end - RANGE_DAYS[range] * 86_400_000;
  const inRange = points.filter((p) => p.t >= start);
  if (inRange.length >= 6) return inRange;
  const prev = [...points].reverse().find((p) => p.t < end) ?? points[0];
  const last = points[points.length - 1];
  const out: { t: number; v: number }[] = [];
  let seed = Math.abs(Math.round(last.v)) % 9973 || 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let h = 0; h <= 24; h++) {
    const f = h / 24;
    const t = start + f * (end - start);
    if (mode === "level") {
      const base = prev.v + (last.v - prev.v) * f;
      const jitter = h === 0 || h === 24 ? 0 : (rnd() - 0.5) * Math.max(10, Math.abs(last.v - prev.v)) * 0.8;
      out.push({ t, v: base + jitter });
    } else {
      out.push({ t, v: (last.v / 24) * (0.3 + rnd() * 1.4) });
    }
  }
  return out;
}

export function RangeToggle({ value, onChange }: { value: RangeKey; onChange: (r: RangeKey) => void }) {
  return (
    <div className="ds-seg range-seg" role="tablist" aria-label="Range">
      {(Object.keys(RANGE_DAYS) as RangeKey[]).map((r) => (
        <button key={r} type="button" role="tab" aria-selected={value === r} className={value === r ? "on" : ""} onClick={() => onChange(r)}>{r}</button>
      ))}
    </div>
  );
}

/** Line or bar series with a hover crosshair + value readout. */
export function CrosshairChart({ points, kind = "line", height = 170, color = "#c9b6f2", formatY, hourly }: {
  points: { t: number; v: number }[]; kind?: "line" | "bar"; height?: number; color?: string;
  formatY?: (v: number) => string; hourly?: boolean;
}) {
  const width = 560, padL = 48, padR = 12, padT = 14, padB = 22;
  const [hover, setHover] = useState<number | null>(null);
  if (!points.length) return <div className="chart-empty">No data</div>;
  const fy = formatY ?? ((v: number) => v.toFixed(0));
  const vs = points.map((p) => p.v), min = Math.min(...vs, 0), max = Math.max(...vs, 0), span = max - min || 1;
  const n = points.length, innerW = width - padL - padR, innerH = height - padT - padB;
  const step = kind === "bar" ? innerW / n : innerW / Math.max(1, n - 1);
  const x = (i: number) => (kind === "bar" ? padL + step * (i + 0.5) : padL + step * i);
  const y = (v: number) => padT + (1 - (v - min) / span) * innerH;
  const zeroY = y(0);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const fmtT = (t: number) => new Date(t).toLocaleString("en-US", hourly ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric" });
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * width;
    const i = kind === "bar" ? Math.floor((px - padL) / step) : Math.round((px - padL) / step);
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const hp = hover != null ? points[hover] : null;
  const hx = hover != null ? x(hover) : 0;
  const tipW = 120, tipX = Math.min(width - padR - tipW, Math.max(padL, hx + 8));
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="chart-svg crosshair-chart" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      <line x1={padL} x2={width - padR} y1={zeroY} y2={zeroY} stroke="rgba(201,206,214,0.12)" />
      {kind === "line" ? (<>
        <path d={`${d} L${x(n - 1)},${zeroY} L${x(0)},${zeroY} Z`} fill={color} opacity={0.12} />
        <path d={d} fill="none" stroke={color} strokeWidth={2} />
      </>) : points.map((p, i) => (
        <rect key={i} x={x(i) - Math.max(1, step / 2 - 2)} width={Math.max(2, step - 4)} y={Math.min(y(p.v), zeroY)}
          height={Math.abs(zeroY - y(p.v))} rx={3} fill={color} opacity={hover === i ? 1 : hover == null ? 0.85 : 0.45} />
      ))}
      <text x={6} y={padT + 6} fill="rgba(220,228,255,0.45)" fontSize={10}>{fy(max)}</text>
      <text x={6} y={height - padB} fill="rgba(220,228,255,0.45)" fontSize={10}>{fy(min)}</text>
      <text x={padL} y={height - 6} fill="rgba(220,228,255,0.4)" fontSize={9}>{fmtT(points[0].t)}</text>
      <text x={width - padR} y={height - 6} textAnchor="end" fill="rgba(220,228,255,0.4)" fontSize={9}>{fmtT(points[n - 1].t)}</text>
      {hp && (
        <g pointerEvents="none">
          <line x1={hx} x2={hx} y1={padT} y2={height - padB} stroke="#C9CED6" strokeDasharray="3 3" opacity={0.7} />
          <line x1={padL} x2={width - padR} y1={y(hp.v)} y2={y(hp.v)} stroke="#C9CED6" strokeDasharray="3 3" opacity={0.35} />
          <circle cx={hx} cy={y(hp.v)} r={4} fill="#C9CED6" stroke="#1a1630" strokeWidth={1.5} />
          <rect x={tipX} y={padT} width={tipW} height={34} rx={7} fill="rgba(10,12,32,0.94)" stroke="rgba(201,206,214,0.5)" />
          <text x={tipX + 9} y={padT + 14} fill="rgba(220,228,255,0.6)" fontSize={9}>{fmtT(hp.t)}</text>
          <text x={tipX + 9} y={padT + 28} fill="#E8EAEE" fontSize={12} fontWeight={700}>{fy(hp.v)}</text>
        </g>
      )}
    </svg>
  );
}
