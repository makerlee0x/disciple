import type { VerifiedTierRule } from "@/lib/config";

const COLORS: Record<string, string> = {
  UNVERIFIED: "rgba(220,228,255,.55)",
  BLESSED: "#9fd8ff",
  ANOINTED: "#c9a8ff",
  GLORIFIED: "#ffd98a",
};

export default function VerifiedBadge({ tier }: { tier: VerifiedTierRule }) {
  const c = COLORS[tier.level];
  return (
    <span
      title={`${tier.label} rocket (mock stats)`}
      style={{
        display: "inline-block",
        fontSize: 9,
        letterSpacing: ".1em",
        padding: "2px 6px",
        borderRadius: 6,
        border: `1px solid ${c}`,
        color: c,
        marginLeft: 6,
      }}
    >
      {tier.icon} {tier.label.toUpperCase()}
    </span>
  );
}
