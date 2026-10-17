import type { VerifiedTierRule } from "@/lib/config";

const COLORS: Record<string, string> = {
  BLESSED: "#85B0D6",
  ANOINTED: "#C9A8DC",
  GLORIFIED: "#E5875A",
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
          <circle cx="8" cy="8" r="6" fill="none" stroke="rgba(201,206,214,.32)" strokeWidth="1.4" strokeDasharray="2.2 2" />
        </svg>
      </span>
    );
  }
  const c = COLORS[tier.level] ?? "#85B0D6";
  const halo = tier.level !== "BLESSED";
  return (
    <span className={`vmark vmark-${tier.level.toLowerCase()}`} title={label} aria-label={label} role="img">
      <svg width={size} height={size + (halo ? 4 : 0)} viewBox={`0 ${halo ? -4 : 0} 16 ${16 + (halo ? 4 : 0)}`} aria-hidden
        style={{ filter: `drop-shadow(0 0 4px ${c})` }}>
        {halo && <ellipse cx="8" cy="-1.5" rx="5" ry="1.6" fill="none" stroke={c} strokeWidth="1.2" />}
        {/* BRAND icons v1: d-verified, tinted by tier */}
        <use href="#d-verified" x="0" y="0" width="16" height="16" color={c} />
      </svg>
    </span>
  );
}
