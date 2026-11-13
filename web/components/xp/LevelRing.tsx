/** Level number in a gold ring that fills toward the next level (brand v3). */
import type { LevelInfo } from "@/lib/xp";

export default function LevelRing({ info, size = 40, stroke }: { info: Pick<LevelInfo, "level" | "progress" | "prestige">; size?: number; stroke?: number }) {
  const sw = stroke ?? Math.max(3, Math.round(size / 11));
  const r = (size - sw) / 2, c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, info.progress));
  return (
    <span className="xp-ring" style={{ width: size, height: size }} data-prestige={info.prestige || undefined}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--xp-ring-track)" strokeWidth={sw} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--dsc3-light-gold)" strokeWidth={sw} strokeLinecap="round"
          strokeDasharray={`${c * p} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <span className="xp-ring-n" style={{ fontSize: Math.round(size * 0.4) }}>{info.level}</span>
    </span>
  );
}
