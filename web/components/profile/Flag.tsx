import { withBase } from "@/lib/base-path";
import { isCountryFlag } from "@/lib/profileMeta";

/** Country name in the viewer's locale (Intl, so no new copy). */
export function countryName(cc: string): string {
  try { return new Intl.DisplayNames(undefined, { type: "region" }).of(cc) || cc; } catch { return cc; }
}

/** Display name for a flag id (a country, via Intl). Coin communities are guilds now (components/guilds). */
export function flagName(id: string): string {
  return countryName(id);
}

/**
 * Profile flag as SVG. Countries: public/flags (country-flag-icons, MIT; emoji flags render as two letters on Windows).
 */
export default function Flag({ cc, size = 18 }: { cc: string; size?: number }) {
  if (!cc) return null;
  if (!isCountryFlag(cc)) return null;
  const name = flagName(cc);
  const src = `/flags/${cc}.svg`;
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="pf-flag" src={withBase(src)} alt={name} title={name} width={Math.round(size * 1.5)} height={size} loading="lazy" decoding="async" />;
}
