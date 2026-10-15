"use client";

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
  value, label, sub, size = 118, color = "#ffe7a3", progress = 0.72,
}: {
  value: string; label: string; sub?: string; size?: number; color?: string; progress?: number;
}) {
  const r = (size - 12) / 2, c = 2 * Math.PI * r, p = Math.max(0, Math.min(1, progress));
  return (
    <div className="stat-ring" style={{ width: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,231,163,0.12)" strokeWidth={6} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={6} strokeLinecap="round"
          strokeDasharray={`${c * p} ${c * (1 - p)}`} transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ filter: `drop-shadow(0 0 6px ${color})` }} />
        <text x="50%" y="48%" textAnchor="middle" fill="#fff7df" fontSize={15} fontWeight={700} fontFamily="Georgia, serif">{value}</text>
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
        <path d="M16 78 A54 54 0 0 1 124 78" fill="none" stroke="rgba(255,231,163,0.12)" strokeWidth={10} strokeLinecap="round" />
        <path d="M16 78 A54 54 0 0 1 124 78" fill="none" stroke={color} strokeWidth={10} strokeLinecap="round"
          strokeDasharray={`${circ * pct} ${circ}`} style={{ filter: `drop-shadow(0 0 8px ${color})` }} />
        <text x="70" y="68" textAnchor="middle" fill="#fff7df" fontSize={22} fontWeight={700} fontFamily="Georgia, serif">
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

export function BarChart({ items, height = 140, color = "#ffe7a3" }: { items: { label: string; value: number }[]; height?: number; color?: string }) {
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
        <polygon key={rv} fill="none" stroke="rgba(255,231,163,0.15)" strokeWidth={1}
          points={axes.map((_, i) => pt(i, rv).join(",")).join(" ")} />
      ))}
      {axes.map((ax, i) => {
        const [x, y] = pt(i, 1), [lx, ly] = pt(i, 1.22);
        return (
          <g key={ax.label}>
            <line x1={cx} y1={cy} x2={x} y2={y} stroke="rgba(255,231,163,0.2)" />
            <text x={lx} y={ly} textAnchor="middle" fill="rgba(220,228,255,0.7)" fontSize={9}>{ax.label}</text>
          </g>
        );
      })}
      <path d={poly} fill="rgba(255,231,163,0.25)" stroke="#ffe7a3" strokeWidth={1.5} />
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
