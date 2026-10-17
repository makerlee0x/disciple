/**
 * Verification mark: one "Verified" icon for hand-verified rockets, nothing otherwise.
 * Verification is a manual yes/no flag (see lib/verified.ts); there are no tiers.
 */
export default function VerifiedBadge({ verified, size = 16, showLabel = false }: { verified: boolean; size?: number; showLabel?: boolean }) {
  if (!verified) return null;
  const c = "#85B0D6";
  return (
    <span className="vmark vmark-verified" title="Verified" aria-label="Verified" role="img">
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden style={{ filter: `drop-shadow(0 0 4px ${c})` }}>
        {/* BRAND icons v1: d-verified */}
        <use href="#d-verified" x="0" y="0" width="16" height="16" color={c} />
      </svg>
      {showLabel && <span className="vmark-label" style={{ marginLeft: 4, color: c, lineHeight: 1 }}>Verified</span>}
    </span>
  );
}
