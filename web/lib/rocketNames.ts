/** Random rocket-name generator for /create (fresh name on every page open + shuffle). */
const A = ["Halo", "Seraph", "Gilded", "Pearly", "Celestial", "Holy", "Neon", "Lunar", "Solar", "Blessed", "Cosmic", "Velvet", "Iron", "Crystal", "Golden", "Silent", "Wild", "Feral", "Based", "Turbo"];
const B = ["Inu", "Pilgrim", "Choir", "Comet", "Falcon", "Monk", "Frog", "Cat", "Ape", "Whale", "Prophet", "Angel", "Dragon", "Oracle", "Saint", "Ghost", "Rocket", "Lion", "Wolf", "Phoenix"];
const C = ["", "", "", " Mk II", " One", " X", " Prime", " Zero"];
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];
export function randomRocketName(): string { return `${pick(A)} ${pick(B)}${pick(C)}`.slice(0, 32); }
export function tickerFromName(name: string): string {
  const w = name.replace(/[^A-Za-z ]/g, "").split(/\s+/).filter(Boolean);
  const t = w.length >= 2 ? (w[0][0] + w[1].slice(0, 3)) : (w[0] || "").slice(0, 4);
  return t.toUpperCase();
}

const FILLER = new Set(["MK", "II", "III", "THE", "OF", "A"]);
/**
 * Call-sign variants derived from a rocket name (all valid: A–Z/0–9, 2–10 chars), best first:
 * first word → last word → acronym → first-letter + 3 → first-3 + first-3.
 * "Blessed Falcon" → BLESSED, FALCON, BF, BFAL, BLEFAL.
 */
export function tickerVariants(name: string): string[] {
  const w = name.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter((x) => x && !FILLER.has(x));
  if (!w.length) return [];
  const out = [
    w[0],
    w.length > 1 ? w[w.length - 1] : "",
    w.length > 1 ? w.map((x) => x[0]).join("") : "",
    w.length > 1 ? w[0][0] + w[1].slice(0, 3) : w[0].slice(0, 4),
    w.length > 1 ? w[0].slice(0, 3) + w[1].slice(0, 3) : w[0].slice(0, 3),
    w.length > 1 ? w[1] : "",
  ].map((t) => t.slice(0, 10)).filter((t) => t.length >= 2 && /^[A-Z0-9]+$/.test(t));
  return Array.from(new Set(out));
}
/** Next variant after `current` (wraps); first variant when current isn't derived from this name. */
export function nextTicker(name: string, current: string): string {
  const v = tickerVariants(name);
  if (!v.length) return current;
  const i = v.indexOf(current.toUpperCase());
  return v[(i + 1) % v.length];
}
