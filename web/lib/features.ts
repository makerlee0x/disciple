/**
 * Feature switches for UI that exists in code but isn't live yet. Flip a constant (or set the NEXT_PUBLIC_ override at
 * build time) to bring the feature back; nothing else needs to change.
 */

/**
 * Profile Loot tab (cosmetic parts from achievements). Hidden until loot is a real feature (lee, 2026-10-24).
 * Off: the profile shows Rockets · Achievements · Activity, ?tab=loot / ?slot= deep links fall back to Rockets, and no
 * loot count / reward line / link shows anywhere on the profile. On: Rockets · Loot · Achievements · Activity.
 * Override: NEXT_PUBLIC_FEATURE_LOOT=1 (build-time; not set anywhere today).
 */
export const LOOT_ENABLED: boolean = process.env.NEXT_PUBLIC_FEATURE_LOOT === "1" || process.env.NEXT_PUBLIC_FEATURE_LOOT === "true";

/**
 * Real player progress (titles, season tier, level, header stats). Off until the indexer serves real per-wallet
 * achievement / season data (lee, 2026-10-24: "Hide it"). Today those numbers come from lib/mock/sample-trades, so
 * while this is off:
 *  - the profile header shows no stats, no season tier (ANOINTED…) and no LVL, and the title is always "Normie";
 *  - no title counts as earned (lib/titles earnedTitlesFor → []), so the picker shows its empty state and
 *    /api/profile/meta rejects every title pick ("You haven't earned that title yet.").
 * Turn on only after lib/titles profileStatsFor() returns real stats. Override: NEXT_PUBLIC_FEATURE_REAL_PROGRESS=1
 * (build-time; not set anywhere today).
 */
export const REAL_PROGRESS_ENABLED: boolean =
  process.env.NEXT_PUBLIC_FEATURE_REAL_PROGRESS === "1" || process.env.NEXT_PUBLIC_FEATURE_REAL_PROGRESS === "true";

/**
 * Coin screen POINTS section (Your Position card: off-chain points multiplier bar, "hold to ramp" hint). Hidden until points
 * are a real feature (lee, Oct 30 coin-screen cleanup). Override: NEXT_PUBLIC_FEATURE_POINTS=1 (build-time; not set anywhere).
 */
export const POINTS_ENABLED: boolean = process.env.NEXT_PUBLIC_FEATURE_POINTS === "1" || process.env.NEXT_PUBLIC_FEATURE_POINTS === "true";

/**
 * Coin screen CREW card (components/CrewPanel). Hidden (lee, Oct 30 coin-screen cleanup). Override: NEXT_PUBLIC_FEATURE_CREW_CARD=1.
 * Pass 2: its BUY PRESETS list and "Next unlock … orb rain" loot line were removed from the card itself, so the flag never brings them back.
 */
export const CREW_CARD_ENABLED: boolean = process.env.NEXT_PUBLIC_FEATURE_CREW_CARD === "1" || process.env.NEXT_PUBLIC_FEATURE_CREW_CARD === "true";

/**
 * Guilds and their short tags next to usernames (lee called these clans/tags; renamed to guilds on Oct 26 2026).
 * Hidden until v2 (lee, 2026-11-10): hide only — components, routes, APIs and contract wiring stay so this can
 * come back. Off: no guild chip/tag in the feed, leaderboard, profile, sidebar or wallet pill, and no guild
 * picker in Edit profile. /api/guilds, /api/holders `guild`, chat `from.guild` and window.__discipleGuilds are
 * unchanged. Override: NEXT_PUBLIC_FEATURE_GUILDS=1 (build-time; not set anywhere today).
 */
export const GUILDS_ENABLED: boolean = process.env.NEXT_PUBLIC_FEATURE_GUILDS === "1" || process.env.NEXT_PUBLIC_FEATURE_GUILDS === "true";
/** Alias: product docs and lee still say "clans"; same flag as GUILDS_ENABLED. */
export const CLANS_ENABLED: boolean = GUILDS_ENABLED;


/**
 * Logbook: your closed flights (/logbook), one rocket's story (/logbook/[coin]), the steady-hand streaks page it links to
 * (/streaks) and the lobby "while you were away" card. Built in PR #355; hidden until after launch (maker, 2026-11-14).
 * Off: no Logbook tab or account-menu item, the routes 404, Top pilots' Best call opens the pilot's profile, and orbit pushes
 * open the rocket. The APIs stay so this can come back. Override: NEXT_PUBLIC_FEATURE_LOGBOOK=1 (build-time).
 */
export const LOGBOOK_ENABLED: boolean = process.env.NEXT_PUBLIC_FEATURE_LOGBOOK === "1" || process.env.NEXT_PUBLIC_FEATURE_LOGBOOK === "true";

/**
 * Crew: your crew page (/crew), the "Fly with me" invite landing (/fly), "N of your crew aboard" on lobby cards, the Crews
 * sort on Top pilots and crew-zone pushes. Built in PR #355; hidden until after launch (maker, 2026-11-14).
 * Off: no Crew tab or account-menu item, /crew and /fly 404, /fly/<user>/<ticker> still sets the referral cookie but opens
 * the rocket, and no crew push is sent or offered. The APIs stay. Override: NEXT_PUBLIC_FEATURE_CREW=1 (build-time).
 */
/**
 * Tramps and walls (limit orders on rockets in orbit): the coin-page / Free play panel, its ☰ menu items and the docs page.
 * Hidden for launch (maker, 2026-11-14: "they may come back but we don't need them right now"). Off: TrampWallPanel is not
 * mounted, so nothing is placed or drawn and the menu items stay hidden; the contracts, adapters and APIs are untouched.
 * Override: NEXT_PUBLIC_FEATURE_TRAMP_WALLS=1 (build-time).
 */
export const TRAMP_WALLS_ENABLED: boolean = process.env.NEXT_PUBLIC_FEATURE_TRAMP_WALLS === "1" || process.env.NEXT_PUBLIC_FEATURE_TRAMP_WALLS === "true";
export const CREW_ENABLED: boolean = process.env.NEXT_PUBLIC_FEATURE_CREW === "1" || process.env.NEXT_PUBLIC_FEATURE_CREW === "true";

/**
 * Pro HUD: the advanced trader view on desktop flight (loadout card, Pro chart, full position card, every bomb banner) and
 * the PILOT / PRO switch that picks it. Hidden for launch (maker, 2026-11-14: "i dont think we need the advanced trader view
 * any more for desktop"). Off: every flight runs Pilot, the top bar has no switch, a saved 'pro' choice is reset to Pilot,
 * and How to play shows one panel without its Pilot / Pro tabs (#pro still opens the spec sheet). Price protection lives in
 * Settings → Trading and in the trade settings popup (☰ → Trade settings). The Pro code stays so this can come back.
 * Override: NEXT_PUBLIC_FEATURE_PRO=1 (build-time).
 */
export const PRO_HUD_ENABLED: boolean = process.env.NEXT_PUBLIC_FEATURE_PRO === "1" || process.env.NEXT_PUBLIC_FEATURE_PRO === "true";

/** Trading Duel card in the lobby's "Pick a mode" row (game modes option A, maker 2026-11-14). The card shows whenever the
 *  Turbo flag is on (lib/turbo/flag.ts) and opens the duel lobby, which sits behind the Turbo password. */
export const DUEL_HREF = "/turbo/duel";

/** Straight into a bot duel (no lobby): empty states point here on launch day, since a bot duel always has action
 *  (launch funnel item 7, maker 2026-11-17). Same entry as the first-run WelcomeIntro. */
export const BOT_DUEL_HREF = "/turbo/duel?first=1";

/**
 * Market tab in the top bar and the phone tab bar (nav rework, maker 2026-11-16: "we need the marketplace now in the nav
 * bar"). /market shipped with PR #444 and holds your crates too (PR #446), so the tab is on (maker 2026-11-17: "turn it on").
 * Kill switch: NEXT_PUBLIC_FEATURE_MARKET=0 (build-time) hides it.
 */
export const MARKET_ENABLED: boolean = process.env.NEXT_PUBLIC_FEATURE_MARKET !== "0" && process.env.NEXT_PUBLIC_FEATURE_MARKET !== "false";
/** Where the Live flights tab and the lobby's Live flights card go: every rocket, with its sort chips (not one random rocket). */
export const FLIGHTS_HREF = "/live";

/**
 * Turbo Royale. Held for launch (maker, 2026-11-18: "id rather ship a good mode that works great than something thats half
 * assed. yes lets hold off on royale"). Hide only: the game, /turbo/royale, its APIs, season points, prices and Lighter wiring stay.
 * Off: no Royale card in the lobby or the app home / quick-play sheet, the Turbo tab goes straight to Trading duel (no menu
 * while it's the only mode), no Royale tab on Top pilots, and /turbo/royale shows nothing unless this device opted in for
 * play-testing with /turbo/royale?royale=1 (?royale=0 clears it). Override: NEXT_PUBLIC_FEATURE_ROYALE=1 (build-time; not set anywhere today).
 */
export const ROYALE_ENABLED: boolean = process.env.NEXT_PUBLIC_FEATURE_ROYALE === "1" || process.env.NEXT_PUBLIC_FEATURE_ROYALE === "true";
const ROYALE_TEST_KEY = "disciple.royale.test.v1";
/** ROYALE_ENABLED, or this device opted in with ?royale=1 (client only; call from an effect). */
export function royaleOpenHere(): boolean {
  if (ROYALE_ENABLED) return true;
  if (typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search).get("royale");
    if (q === "1") window.localStorage.setItem(ROYALE_TEST_KEY, "1");
    else if (q === "0") window.localStorage.removeItem(ROYALE_TEST_KEY);
    return window.localStorage.getItem(ROYALE_TEST_KEY) === "1";
  } catch { return false; }
}
