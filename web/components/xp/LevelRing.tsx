/** Level number in a gold ring that fills toward the next level (brand v3). With `img` (the pilot's picture), the picture
 *  fills the ring and the level moves to a small badge (maker 2026-11-17: picture in the top bar pill). */
import type { LevelInfo } from "@/lib/xp";

export default function LevelRing({ info, size = 40, stroke, img }: { info: Pick<LevelInfo, "level" | "progress" | "prestige">; size?: number; stroke?: number; img?: string | null }) {
  const sw = stroke ?? Math.max(3, Math.round(size / 11));
  const r = (size - sw) / 2, c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, info.progress));
  return (
    <span className={img ? "xp-ring has-pfp" : "xp-ring"} style={{ width: size, height: size }} data-prestige={info.prestige || undefined}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--xp-ring-track)" strokeWidth={sw} />
        {/* no arc at 0: a round cap on a zero-length dash still paints a gold dot (maker 2026-11-19 "two gold dots") */}
        {p > 0 && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--dsc3-light-gold)" strokeWidth={sw} strokeLinecap="round"
          strokeDasharray={`${c * p} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />}
      </svg>
      {img ? <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="xp-ring-pfp pfp-img" src={img} alt="" style={{ left: sw + 1, top: sw + 1, width: size - 2 * (sw + 1), height: size - 2 * (sw + 1) }} />
        <span className="xp-ring-badge">{info.level}</span>
      </> : <span className="xp-ring-n" style={{ fontSize: Math.round(size * 0.4) }}>{info.level}</span>}
    </span>
  );
}
