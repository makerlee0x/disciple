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
