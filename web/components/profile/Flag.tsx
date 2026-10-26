import { withBase } from "@/lib/base-path";
import { isCountryFlag } from "@/lib/profileMeta";
import { communityFlag } from "@/lib/flags/community";

/** Country name in the viewer's locale (Intl, so no new copy). */
export function countryName(cc: string): string {
  try { return new Intl.DisplayNames(undefined, { type: "region" }).of(cc) || cc; } catch { return cc; }
}

/** Display name for any allowed flag id: a country (Intl) or a coin community (lib/flags/community). */
export function flagName(id: string): string {
  return communityFlag(id)?.label ?? countryName(id);
}

/**
 * Profile flag as SVG. Countries: public/flags (country-flag-icons, MIT; emoji flags render as two letters on Windows).
 * Communities: the asset from lib/flags/community (placeholder art for now).
 */
export default function Flag({ cc, size = 18 }: { cc: string; size?: number }) {
  if (!cc) return null;
  const community = communityFlag(cc);
  if (!community && !isCountryFlag(cc)) return null;
  const name = flagName(cc);
  const src = community ? community.asset : `/flags/${cc}.svg`;
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={`pf-flag${community ? " pf-flag-community" : ""}`} src={withBase(src)} alt={name} title={name} width={Math.round(size * 1.5)} height={size} loading="lazy" decoding="async" />;
}
