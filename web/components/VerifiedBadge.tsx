"use client";
import { useVerified } from "@/lib/verifiedClient";
import Tooltip from "@/components/ui/Tooltip";

/**
 * Verification mark: one "Verified" icon for hand-verified rockets, nothing otherwise.
 * Verification is a manual yes/no flag (see lib/verified.ts); there are no tiers.
 * `verified` is the flag the caller already knows; pass `token` too so an admin approval
 * (/admin/verifications, stored in KV) also shows the mark. Never automatic.
 */
export default function VerifiedBadge({ verified, token, size = 16, showLabel = false }: { verified?: boolean; token?: string | null; size?: number; showLabel?: boolean }) {
  const ok = useVerified(token, verified);
  if (!ok) return null;
  const c = "#85B0D6";
  return (
    <Tooltip content="Verified">
    <span className="vmark vmark-verified" aria-label="Verified" role="img" data-testid="verified-badge">
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden style={{ filter: `drop-shadow(0 0 4px ${c})` }}>
        {/* BRAND icons v1: d-verified */}
        <use href="#d-verified" x="0" y="0" width="16" height="16" color={c} />
      </svg>
      {showLabel && <span className="vmark-label" style={{ marginLeft: 4, color: c, lineHeight: 1 }}>Verified</span>}
    </span>
    </Tooltip>
  );
}
