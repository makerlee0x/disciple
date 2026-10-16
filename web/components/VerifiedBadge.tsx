import type { VerifiedTierRule } from "@/lib/config";

const COLORS: Record<string, string> = {
  BLESSED: "#7ec8ff",
  ANOINTED: "#c9a8ff",
  GLORIFIED: "#ffd98a",
};

/**
 * Verification mark (icon only, no text pill).
 * UNVERIFIED → muted empty ring · BLESSED → blue check · higher tiers → check with a halo.
 */
export default function VerifiedBadge({ tier, size = 16 }: { tier: VerifiedTierRule; size?: number }) {
  const label = `${tier.label} rocket (mock stats)`;
  if (tier.level === "UNVERIFIED") {
    return (
      <span className="vmark vmark-none" title={label} aria-label={label} role="img">
        <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="8" r="6" fill="none" stroke="rgba(220,228,255,.28)" strokeWidth="1.4" strokeDasharray="2.2 2" />
        </svg>
      </span>
    );
  }
  const c = COLORS[tier.level] ?? "#7ec8ff";
  const halo = tier.level !== "BLESSED";
  return (
    <span className={`vmark vmark-${tier.level.toLowerCase()}`} title={label} aria-label={label} role="img">
      <svg width={size} height={size + (halo ? 4 : 0)} viewBox={`0 ${halo ? -4 : 0} 16 ${16 + (halo ? 4 : 0)}`} aria-hidden
        style={{ filter: `drop-shadow(0 0 4px ${c})` }}>
        {halo && <ellipse cx="8" cy="-1.5" rx="5" ry="1.6" fill="none" stroke={c} strokeWidth="1.2" />}
        <path d="M8 .8l1.9 1.4 2.3-.2.7 2.2 1.9 1.4-.7 2.2.7 2.2-1.9 1.4-.7 2.2-2.3-.2L8 15.2l-1.9-1.4-2.3.2-.7-2.2L1.2 10.4l.7-2.2-.7-2.2 1.9-1.4.7-2.2 2.3.2z" fill={c} />
        <path d="M5 8.2l2 2 4-4.2" fill="none" stroke="#0a0c1a" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
