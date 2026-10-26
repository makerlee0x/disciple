import { RARITY_SCALE, normalizeRarity, ACHIEVEMENT_RARITY } from "@/lib/config";

/** Rarity → --dsc-rarity-* CSS aliases (globals.css), so rarity code never reads season-rank token names. */
export function rarityKey(r: string) { return normalizeRarity(r).toLowerCase(); }
export function rarityVars(r: string): { color: string; glow: string; label: string; pips: number } {
  const n = normalizeRarity(r);
  const k = n.toLowerCase();
  return { color: `var(--dsc-rarity-${k})`, glow: `var(--dsc-rarity-${k}-glow)`, label: ACHIEVEMENT_RARITY[n].label, pips: RARITY_SCALE.indexOf(n) + 1 };
}

/** 1–5 pips, always shown with the label (never colour alone). */
export function RarityPips({ rarity }: { rarity: string }) {
  const v = rarityVars(rarity);
  return (
    <span className="pf-pips" aria-hidden style={{ color: v.color }}>
      {RARITY_SCALE.map((_, i) => <i key={i} className={i < v.pips ? "on" : ""} />)}
    </span>
  );
}

/** Pips + label, coloured. Common's label uses --dsc-muted for contrast. */
export function RarityTag({ rarity, className = "" }: { rarity: string; className?: string }) {
  const v = rarityVars(rarity);
  return (
    <span className={`pf-rarity rarity-${rarityKey(rarity)} ${className}`} style={{ color: v.color }}>
      <RarityPips rarity={rarity} /><span className="pf-rarity-label">{v.label}</span>
    </span>
  );
}
