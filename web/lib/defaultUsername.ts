/**
 * Space-themed default call sign for players who haven't claimed a username ("Captain Boom", "Cadet Nebula", …).
 *
 * Display-only fallback: a pure function of the account address (the same smart-account / wallet address usernames
 * are bound to in lib/server/usernames), so it is identical on every device, session and surface, and nothing is
 * written to storage. A claimed username always wins: render `displayName(username, address)` (or
 * `username || defaultUsername(address)`) wherever a username can be missing. Claimed usernames are lowercase
 * `a-z0-9_` and shown as `@name`; defaults are Title Case with a space and never get an `@`, so they can't be
 * mistaken for (or collide with) a claimed handle. Duplicate call signs are fine (32 × 64 = 2,048 combos).
 *
 * The lists are FROZEN: reordering, adding or removing a word re-rolls every player's default name.
 * Unit-tested by scripts/test-default-username.mjs.
 */
export const CALLSIGN_TITLES = [
  "Captain", "Commander", "Pilot", "Cadet", "Navigator", "Admiral", "Major", "Ensign",
  "Chief", "Skipper", "Ace", "Ranger", "Scout", "Marshal", "Pathfinder", "Voyager",
  "Rookie", "Lieutenant", "Sergeant", "Colonel", "General", "Astro", "Cosmo", "Rocketeer",
  "Starfarer", "Hotshot", "Trooper", "Agent", "Engineer", "Spacer", "Stargazer", "Maverick",
] as const;

export const CALLSIGN_NOUNS = [
  "Boom", "Nova", "Comet", "Orbit", "Nebula", "Quasar", "Rocket", "Pulsar",
  "Meteor", "Lunar", "Zenith", "Photon", "Vortex", "Galaxy", "Stardust", "Eclipse",
  "Moonshot", "Thruster", "Booster", "Ignition", "Liftoff", "Gravity", "Plasma", "Ion",
  "Cosmos", "Saturn", "Jupiter", "Mars", "Neptune", "Pluto", "Titan", "Starlight",
  "Supernova", "Asteroid", "Rover", "Satellite", "Warp", "Hyperdrive", "Afterburner", "Orion",
  "Vega", "Sirius", "Andromeda", "Polaris", "Wormhole", "Jetpack", "Gamma", "Moonbag",
  "Blastoff", "Countdown", "Starburst", "Sunflare", "Cosmic", "Lightyear", "Parsec", "Apogee",
  "Redshift", "Aurora", "Kaboom", "Zoom", "Turbo", "Sparky", "Rocketfuel", "Skyrocket",
] as const;

const isAddr = (a: string) => /^0x[0-9a-f]{40}$/.test(a);

/** 32-bit FNV-1a + murmur3 finalizer (good spread on hex addresses that share prefixes). */
function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

/** Deterministic call sign for an address (case-insensitive). Empty/missing input → "". */
export function defaultUsername(address: string | null | undefined): string {
  const a = String(address ?? "").trim().toLowerCase();
  if (!a) return "";
  const h = hash32(a), t = CALLSIGN_TITLES.length;
  return `${CALLSIGN_TITLES[h % t]} ${CALLSIGN_NOUNS[Math.floor(h / t) % CALLSIGN_NOUNS.length]}`;
}

/** True for a 0x… 20-byte address (any case). */
export const isAddressLike = (a: string | null | undefined) => isAddr(String(a ?? "").trim().toLowerCase());

/**
 * What to show for a player: their claimed username (as `@name` when `at`), else the address's default call sign.
 * `fallback` is returned only when there's neither a username nor an address.
 */
export function displayName(username: string | null | undefined, address: string | null | undefined, opts: { at?: boolean; fallback?: string } = {}): string {
  const u = String(username ?? "").trim().replace(/^@/, "");
  if (u) return opts.at ? `@${u}` : u;
  return defaultUsername(address) || (opts.fallback ?? "");
}
