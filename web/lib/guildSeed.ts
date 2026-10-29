/**
 * Starter guilds: SWAPPABLE DATA (lee, Mon Oct 26 2026 8:59 AM CT: clans renamed to guilds; 12 guilds in 3 categories).
 * To swap a guild, edit this list. Its logo goes in public/guilds/<id>.png (scripts/fetch-guild-logos.mts downloads
 * candidates from CoinGecko's public image URLs for lee to review; we host our own copies and never hotlink).
 *  - id: stored per player (guild:member:<wallet>). Keep it stable once shipped.
 *  - tag: 2–5 chars, A–Z 0–9 (lib/guilds GUILD_TAG_RE). Starter tags are reserved: nobody can start a guild with one.
 *    STRATEGY, SCHIFFY and CASHCAT are longer than 5, so they show as STRAT, SCHIF and CCAT (pending lee; or raise
 *    GUILD_TAG_MAX in lib/guilds).
 *  - coingeckoId: the CoinGecko coin the logo comes from. null = no confident match (pending lee / BRAND).
 *    Robinhood matches are best guesses from CoinGecko search; check they're the Robinhood Chain coins.
 */
export type GuildCategory = "long" | "robinhood" | "og";
export type SeedGuild = { id: string; tag: string; name: string; category: GuildCategory; coingeckoId: string | null };

export const GUILD_CATEGORIES: readonly { id: GuildCategory; label: string }[] = [
  { id: "long", label: "LONG Coins" },
  { id: "robinhood", label: "Robinhood" },
  { id: "og", label: "OG" },
];

export const GUILD_SEED: readonly SeedGuild[] = [
  { id: "g-strategy", tag: "STRAT", name: "STRATEGY", category: "long", coingeckoId: null },
  { id: "g-ai", tag: "AI", name: "AI", category: "long", coingeckoId: null },
  { id: "g-schiffy", tag: "SCHIF", name: "SCHIFFY", category: "long", coingeckoId: "schiffy" },
  { id: "g-cashcat", tag: "CCAT", name: "CASHCAT", category: "robinhood", coingeckoId: "cash-cat" },
  { id: "g-pons", tag: "PONS", name: "PONS", category: "robinhood", coingeckoId: "pons" },
  { id: "g-orbio", tag: "ORBIO", name: "ORBIO", category: "robinhood", coingeckoId: "orbio-so" },
  { id: "g-pengu", tag: "PENGU", name: "PENGU", category: "og", coingeckoId: "pudgy-penguins" },
  { id: "g-mog", tag: "MOG", name: "MOG", category: "og", coingeckoId: "mog-coin" },
  { id: "g-pepe", tag: "PEPE", name: "PEPE", category: "og", coingeckoId: "pepe" },
  { id: "g-dood", tag: "DOOD", name: "DOOD", category: "og", coingeckoId: "doodles" },
  { id: "g-jesus", tag: "JESUS", name: "JESUS", category: "og", coingeckoId: "jesus-coin" },
  { id: "g-anime", tag: "ANIME", name: "ANIME", category: "og", coingeckoId: "anime" },
];

/**
 * Logos committed under public/guilds/? false until lee reviews the downloaded files and their licensing is clear:
 * until then every guild shows the lettered placeholder in its 24×24 slot (no 404s, nothing hotlinked).
 */
export const GUILD_LOGOS_COMMITTED = false;
export const guildLogoPath = (id: string) => `/guilds/${id}.png`;
/** BRAND's shared logo frame, drawn as a separate overlay on the 24×24 slot. "" until BRAND delivers it. */
export const GUILD_FRAME_SRC = "";
