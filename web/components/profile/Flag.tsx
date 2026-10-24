import { withBase } from "@/lib/base-path";
import { isFlag } from "@/lib/profileMeta";

/** Country name in the viewer's locale (Intl, so no new copy). */
export function countryName(cc: string): string {
  try { return new Intl.DisplayNames(undefined, { type: "region" }).of(cc) || cc; } catch { return cc; }
}

/** Country flag as SVG (public/flags, country-flag-icons, MIT): emoji flags render as two letters on Windows. */
export default function Flag({ cc, size = 18 }: { cc: string; size?: number }) {
  if (!cc || !isFlag(cc)) return null;
  const name = countryName(cc);
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="pf-flag" src={withBase(`/flags/${cc}.svg`)} alt={name} title={name} width={Math.round(size * 1.5)} height={size} loading="lazy" decoding="async" />;
}
