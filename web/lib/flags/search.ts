/**
 * Flag picker search (components/profile/FlagPicker). Case- and accent-insensitive; matches the shown name, the code
 * (US, JP, c-pepe → "pepe") and common aliases ("america" → United States, "uk" / "england" → United Kingdom).
 * Results are ranked: exact code / alias / name first, then names or aliases that start with the query, then the rest,
 * so "us" lists United States before Australia / Belarus / Russia. Pure; unit-tested by scripts/test-flag-search.mts.
 * Aliases are search terms only (never shown), so they add no player-facing copy.
 */
export const FLAG_ALIASES: Readonly<Record<string, readonly string[]>> = {
  US: ["america", "usa", "us", "united states", "united states of america", "the states", "u.s.", "u.s.a."],
  GB: ["uk", "u.k.", "united kingdom", "britain", "great britain", "england", "scotland", "wales", "northern ireland", "gb"],
  NL: ["holland", "netherlands", "the netherlands", "dutch"],
  KR: ["korea", "south korea", "republic of korea"],
  KP: ["north korea", "dprk"],
  AE: ["uae", "emirates", "united arab emirates", "dubai", "abu dhabi"],
  CZ: ["czechia", "czech republic"],
  CI: ["ivory coast", "cote d'ivoire"],
  CD: ["drc", "dr congo", "congo kinshasa"],
  CG: ["congo brazzaville"],
  CV: ["cape verde"],
  SZ: ["swaziland", "eswatini"],
  MM: ["burma", "myanmar"],
  TR: ["turkey", "turkiye"],
  MK: ["macedonia", "north macedonia"],
  VA: ["vatican", "holy see"],
  RU: ["russia"],
  CN: ["china", "prc"],
  TW: ["taiwan"],
  HK: ["hong kong"],
  IR: ["iran", "persia"],
  DE: ["germany", "deutschland"],
  ES: ["spain", "espana"],
  CH: ["switzerland", "swiss"],
  NZ: ["new zealand", "aotearoa"],
  SA: ["saudi", "saudi arabia", "ksa"],
  PH: ["philippines", "pinas"],
  VN: ["vietnam", "viet nam"],
  LA: ["laos"],
  BO: ["bolivia"],
  VE: ["venezuela"],
  SY: ["syria"],
  PS: ["palestine"],
  FM: ["micronesia"],
  MD: ["moldova"],
  TZ: ["tanzania"],
};

export type FlagItem = { id: string; label: string };

/** Lower case, accents dropped ("Türkiye" → "turkiye", "Côte d’Ivoire" → "cote d'ivoire"), whitespace collapsed. */
export function foldSearch(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\u2018\u2019]/g, "'").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Lower = better; null = no match. 0 exact (code / alias / name), 1 prefix, 2 contains. Empty query → 2 (everything). */
export function flagMatchRank(query: string, f: FlagItem): number | null {
  const q = foldSearch(query);
  if (!q) return 2;
  const code = f.id.toLowerCase().replace(/^c-/, "");
  const terms = [foldSearch(f.label), ...(FLAG_ALIASES[f.id] ?? []).map(foldSearch)];
  if (code === q || terms.includes(q)) return 0;
  if (terms.some((t) => t.startsWith(q) || t.split(/[\s-]/).some((w) => w.startsWith(q)))) return 1;
  if (code.includes(q) || terms.some((t) => t.includes(q))) return 2;
  return null;
}

/** Matching flags, best first; ties keep the input order (already sorted by name). */
export function searchFlags<T extends FlagItem>(query: string, items: readonly T[]): T[] {
  return items
    .map((f, i) => ({ f, i, r: flagMatchRank(query, f) }))
    .filter((x): x is { f: T; i: number; r: number } => x.r !== null)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.f);
}
