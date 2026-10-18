"use client";
import { useVerified } from "@/lib/verified";

/**
 * Verified mark (icon only). Shows ONLY for rockets an admin approved (/admin/verify → /api/verified); nothing otherwise.
 * Sample/mock coins are never approved, so they never show it.
 */
export default function VerifiedBadge({ token, size = 16 }: { token?: string | null; size?: number }) {
  const ok = useVerified(token);
  if (!ok) return null;
  const label = "Verified by DISCIPLE";
  return (
    <span className="vmark vmark-approved" title={label} aria-label={label} role="img" data-testid="verified-badge">
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden style={{ filter: "drop-shadow(0 0 4px rgba(242,193,78,.55))" }}>
        {/* BRAND icons v1: d-verified, gold */}
        <use href="#d-verified" x="0" y="0" width="16" height="16" color="#F2C14E" />
      </svg>
    </span>
  );
}
