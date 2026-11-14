/**
 * Quick Launch r4 copy and small helpers (BRAND mockups/quick-launch-r4 README).
 * Visible strings are the r4 board text, used exactly. Logic is unit-tested in
 * scripts/test-quick-launch.mts.
 */
import { MODE } from "./modeRules";
import type { LaunchCoinParams } from "./protocol";

/** r4 Screen 2 mode cards, in the same order as the boards (Easy, Hard, Trench). */
export const QUICK_LAUNCH_MODE_COPY = {
  Easy: "At first, one person can hold up to 1% of the coins. That cap rises to 3.33% as the price goes up.",
  Hard: "At first, one person can hold up to 3.33% of the coins. That cap rises to 7.77% as the price goes up.",
  Trench: "There is no cap on how many coins one person can hold.",
  footer: "You choose this when you launch, and you can't change it later. The caps end when the rocket moves to the open market.",
} as const;

/** The launch builder's difficulty cards (canvas board "Launch: build your rocket"). Same caps as above, in game words. */
export const QUICK_LAUNCH_MODE_CARD = {
  Easy: { label: "Easy", nick: "", blurb: "Small bags only. No one can hold more than 1% at first, so the whole crew climbs together.", color: "#5FF0A0", meter: 1 },
  Hard: { label: "Hard", nick: "", blurb: "Bigger bags, up to 3.33% each at first. More room for whales, bigger bombs.", color: "#FF7A3D", meter: 2 },
  Trench: { label: "Expert", nick: "aka the Trench", blurb: "No caps at all. Anyone can grab as much as they want. Wild climbs, wilder dumps.", color: "#F0307F", meter: 3 },
  footer: "The caps switch off once the rocket reaches orbit.",
} as const;

/** "$20" for the seat the host takes at launch ("$0" with no First BOOST). */
export function seatLabel(boostValue: string): string {
  if (!boostHasAmount(boostValue)) return "$0";
  const n = Number.parseFloat(boostValue.trim().replace(/,/g, "."));
  return `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

export const QUICK_LAUNCH_COPY = {
  title: "Your rocket",
  pickMode: "Pick your mode",
  name: "Name",
  ticker: "Ticker",
  icon: "Badge",
  useOwnImage: "Use your own image",
  uploadImage: "Upload image",
  changeImage: "Change image",
  useGenerated: "Use the badge we made",
  firstBoost: "First BOOST",
  firstBoostTip: "This is your first buy, at launch. You get first dibs on your own rocket.",
  seatHelp: "You get first dibs on your own rocket. Skip it with $0.",
  custom: "Custom",
  chip0: "$0",
  chip5: "$5",
  chip20: "$20",
  mode: "Mode",
  modeChange: "Change",
  modeLabel: (label: string) => `Mode: ${label}`,
  advanced: "More options",
  pairCoin: "Pair coin",
  pairHelp: "Your rocket is bought and sold in this coin.",
  links: "Links",
  linkX: "X / social",
  linkXShort: "X",
  linkWebsite: "Website",
  linkTelegram: "Telegram",
  rewards: "Send your creator fees to a different account",
  rewardsPlaceholder: "You",
  rewardsHelp: "Your creator fees go to this account instead of you. You'll confirm this one extra time.",
  creatorTax: "Creator tax",
  creatorTaxHelp: "You already get 33% of every trading fee. Creator tax is an extra cut on top of that. Higher tax can scare off players.",
  creatorTaxHelpIncluded: "Permanent. A small cut of every trade is included in the creator fees chosen above. Higher tax can scare off players.",
  howLaunching: "How launching works",
  howLaunchingSteps: [
    "Give your rocket a name, a ticker, and a picture.",
    "Choose how tightly one person can hold the coins, and whether to buy some at launch.",
    "When you launch, your rocket goes live and people can start trading it.",
  ],
  ready: (name: string) => `${name || "Your rocket"} · READY FOR LAUNCH`,
  liftoff: "3 · 2 · 1 · LIFTOFF",
  signInLine: "Sign in with email, Google, X or wallet",
  anon: "Anon",
  pseudo: "Pseudo",
  beta: "beta",
  anonHelp: "Your name won't be shown as the creator. The account that pays can still be seen on the public record.",
  anonEasyBoostHelp: "Your name won't be shown as the creator. The account that pays can still be seen on the public record.",
  pseudoHelp: "Your name won't be shown as the creator. The account that pays, and the first buy, can still be seen on the public record.",
  creatorFees: "Creator fees",
  creatorFeeSplit: "You earn 33% of every trading fee, forever.",
  creatorFeesPerm: "You pick this when you launch, and you can't change it later.",
  /** Under the fee cards when pool / burn can't be picked (private launch before PRIVATE_FEE_ROUTING_LIVE, or no harvest on this chain). */
  creatorFeesPrivateLater: "Private launches keep the creator fees for now.",
  creatorFeesNotHere: "Pool and burn aren't switched on here yet.",
  creatorFeesNoBoost: "Pool and burn can't take a first boost yet. Launch without one, or keep the creator fees.",
  creatorFeesHelp: "You pick this when you launch. It applies only to this rocket, including private launches, and it cannot be changed later. It covers all creator fees, including any extra creator tax.",
  creatorFeesPending: "This choice will be available once the new contracts are live.",
  // Image rejected after a generated badge is in use (Oct 17 Quick Launch spec; not on the r4 boards).
  imageReverted: "That image can't be used. We've put your rocket's badge back.",
} as const;

/** localStorage key for the Advanced creator-tax control (defaults to 0%). */
export const CREATOR_TAX_STORE_KEY = "disciple.create.creatorTax.v1";

/** sessionStorage key for a chosen badge image, so the file stays after leaving the control. */
export const UPLOAD_STORE_KEY = "disciple.create.upload.v1";

/** Snap to whole numbers or halves: 0, 0.5, 1, 1.5, … up to maxPct. */
export function snapCreatorTax(pct: number, maxPct: number): number {
  if (!Number.isFinite(pct) || pct < 0) return 0;
  const snapped = Math.round(pct * 2) / 2;
  return Math.min(maxPct, Math.max(0, snapped));
}

export function creatorTaxSteps(maxPct: number): number[] {
  const out: number[] = [];
  for (let n = 0; n <= maxPct + 1e-9; n = Math.round((n + 0.5) * 10) / 10) out.push(n > maxPct ? maxPct : n);
  if (out[out.length - 1] !== maxPct) out.push(maxPct);
  return out;
}

export function readStoredCreatorTax(maxPct: number, storage?: Pick<Storage, "getItem"> | null): number {
  try {
    const raw = (storage ?? (typeof localStorage !== "undefined" ? localStorage : null))?.getItem(CREATOR_TAX_STORE_KEY);
    if (raw == null || raw === "") return 0;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return 0;
    return snapCreatorTax(n, maxPct);
  } catch {
    return 0;
  }
}

export function storeCreatorTax(pct: number, storage?: Pick<Storage, "setItem"> | null): void {
  try {
    (storage ?? (typeof localStorage !== "undefined" ? localStorage : null))?.setItem(CREATOR_TAX_STORE_KEY, String(pct));
  } catch { /* private mode */ }
}

/**
 * Where creator fees go: 0 keep, 1 locked pool, 2 buy-and-burn the pair coin.
 * This is not a LaunchParams field. A launch with 1 or 2 goes through CreatorFeeHarvest
 * (lib/creatorFeeHarvest, contracts/src/addons/CreatorFeeHarvest.sol), which records the
 * choice in the launch transaction. 0 keeps today's Launchpad / router / AnonLauncher path.
 * The choice is remembered between launches (same pattern as creator tax). It applies to
 * the whole creator fee (the 33% creator share and the creator tax) and is fixed for good.
 */
export const CREATOR_FEE_FIELD = "creatorFeeDestination" as const;
export const CREATOR_FEE_STORE_KEY = "disciple.create.creatorFeeDestination.v1";

export const CREATOR_FEE_DESTINATION = {
  creator: 0,
  lockedPool: 1,
  buyAndBurnQuote: 2,
} as const;

export type CreatorFeeDestination = (typeof CREATOR_FEE_DESTINATION)[keyof typeof CREATOR_FEE_DESTINATION];

export const DEFAULT_CREATOR_FEE_DESTINATION: CreatorFeeDestination = CREATOR_FEE_DESTINATION.creator;

export const CREATOR_FEE_DESTINATIONS: readonly CreatorFeeDestination[] = [
  CREATOR_FEE_DESTINATION.creator,
  CREATOR_FEE_DESTINATION.lockedPool,
  CREATOR_FEE_DESTINATION.buyAndBurnQuote,
] as const;

/** Short labels on the r7 Advanced cards, plus the closed-Advanced chip (empty when default). */
export const CREATOR_FEE_COPY: Record<CreatorFeeDestination, { sentence: string; chip: string }> = {
  0: {
    sentence: "You keep the creator fees.",
    chip: "",
  },
  1: {
    sentence: "Fees go into the locked pool.",
    chip: "Fees stay in the pool",
  },
  2: {
    sentence: "Fees buy and burn the pair coin.",
    chip: "Fees buy and burn the pair coin",
  },
};

/** Creator tax helper, verbatim from the r7 boards. Changes with the selected fee card. */
export const CREATOR_TAX_HELP: Record<CreatorFeeDestination, string> = {
  0: "You already get 33% of every trading fee. Creator tax is an extra cut on top of that. Higher tax can scare off players.",
  1: "The 33% of every trading fee goes into the locked pool. Creator tax is an extra cut on top of that, and it goes there too. Higher tax can scare off players.",
  2: "The 33% of every trading fee is used to buy and burn the pair coin. Creator tax is an extra cut on top of that, and it is used the same way. Higher tax can scare off players.",
};

/** Public launches can send 1 and 2 (through CreatorFeeHarvest) on any chain whose deployment has a harvest address. */
export const CREATOR_FEE_DESTINATION_LIVE = true;
/**
 * Private launches go through the gasless relayer, which calls CreatorFeeHarvest.launchAnonWithUsdg with refundTo.
 * That argument is new in this harvest; the v6 testnet harvest does not have it. Keep false until the harvest that
 * has it is deployed (mainnet deploy, or a testnet redeploy), then flip.
 */
export const PRIVATE_FEE_ROUTING_LIVE = false;
/**
 * CreatorFeeHarvest.launchWithUsdg reverts when usdgIn > 0 on the deployed harvest (audit CH-02: its leftover check
 * reads the balance after the USDG swap, then underflows once the Launchpad pulls the First BOOST). Until a fixed
 * harvest is deployed (fix in PR #371), pool / burn launches can't take a First BOOST paid in dollars. Flip with the redeploy.
 */
export const HARVEST_USDG_BOOST_LIVE = false;

/** Can this launch send creator fees to the pool or the burn? Needs the flag(s) and a harvest address on this chain. */
export function creatorFeeRoutingAvailable(o: { private?: boolean; harvest?: string | null }): boolean {
  if (!CREATOR_FEE_DESTINATION_LIVE) return false;
  if (o.private && !PRIVATE_FEE_ROUTING_LIVE) return false;
  return !!o.harvest && !/^0x0{40}$/i.test(o.harvest);
}

/** The destination to send with the launch, or undefined to keep today's path (0, or routing not available here). */
export function liveCreatorFeeDestination(
  dest: CreatorFeeDestination,
  o: { private?: boolean; harvest?: string | null } = {},
): 1 | 2 | undefined {
  if (dest === CREATOR_FEE_DESTINATION.creator) return undefined;
  return creatorFeeRoutingAvailable(o) ? dest : undefined;
}

export function isCreatorFeeDestination(value: number): value is CreatorFeeDestination {
  return value === 0 || value === 1 || value === 2;
}

export function parseCreatorFeeDestination(value: string | number | null | undefined): CreatorFeeDestination {
  if (value == null || value === "") return DEFAULT_CREATOR_FEE_DESTINATION;
  const n = typeof value === "number" ? value : Number(value);
  return isCreatorFeeDestination(n) ? n : DEFAULT_CREATOR_FEE_DESTINATION;
}

export function readStoredCreatorFeeDestination(storage?: Pick<Storage, "getItem"> | null): CreatorFeeDestination {
  try {
    const raw = (storage ?? (typeof localStorage !== "undefined" ? localStorage : null))?.getItem(CREATOR_FEE_STORE_KEY);
    return parseCreatorFeeDestination(raw);
  } catch {
    return DEFAULT_CREATOR_FEE_DESTINATION;
  }
}

export function storeCreatorFeeDestination(value: CreatorFeeDestination, storage?: Pick<Storage, "setItem"> | null): void {
  try {
    (storage ?? (typeof localStorage !== "undefined" ? localStorage : null))?.setItem(CREATOR_FEE_STORE_KEY, String(value));
  } catch { /* private mode */ }
}

export function readStoredUpload(storage?: Pick<Storage, "getItem"> | null): string | null {
  try {
    const raw = (storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : null))?.getItem(UPLOAD_STORE_KEY);
    return raw && raw.startsWith("data:image/") ? raw : null;
  } catch {
    return null;
  }
}

export function storeUpload(uri: string | null, storage?: Pick<Storage, "setItem" | "removeItem"> | null): void {
  try {
    const store = storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : null);
    if (!store) return;
    if (!uri) store.removeItem(UPLOAD_STORE_KEY);
    else store.setItem(UPLOAD_STORE_KEY, uri);
  } catch { /* private mode */ }
}

/** A First BOOST "has an amount" when the field parses to a number greater than 0. */
export function boostHasAmount(value: string): boolean {
  const n = Number.parseFloat(value.trim().replace(/,/g, "."));
  return Number.isFinite(n) && n > 0;
}

/**
 * The switch reads "Pseudo" only on Hard or Trench when First BOOST has an amount.
 * It stays "Anon" when there is no First BOOST, and on Easy even with a First BOOST
 * (on Easy, the creator's coins stay locked until the rocket moves to the open market).
 */
export function isPseudoLaunch(boostValue: string, mode: number): boolean {
  return boostHasAmount(boostValue) && mode !== MODE.EASY;
}

export function privateLaunchTitle(boostValue: string, mode: number): "Anon" | "Pseudo" {
  return isPseudoLaunch(boostValue, mode) ? QUICK_LAUNCH_COPY.pseudo : QUICK_LAUNCH_COPY.anon;
}

export function privateLaunchHelp(boostValue: string, mode: number): string {
  if (isPseudoLaunch(boostValue, mode)) return QUICK_LAUNCH_COPY.pseudoHelp;
  return QUICK_LAUNCH_COPY.anonHelp;
}

/** Gold launch button: "Launch" at $0, "Launch + BOOST $5" when there's an amount. */
export function launchButtonLabel(boostValue: string): string {
  if (!boostHasAmount(boostValue)) return "Launch";
  const n = Number.parseFloat(boostValue.trim().replace(/,/g, "."));
  const shown = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return `Launch + BOOST $${shown}`;
}

/** r4 Max chip: "Max $248.10" once we know the dollar cap; "Max" before that. */
export function maxBoostChipLabel(usd: number | null): string {
  if (usd == null || !Number.isFinite(usd)) return "Max";
  const shown = usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `Max $${shown}`;
}

/**
 * Sign-in gate for the launch button (existing rule from #103 / today's /create page):
 * on a live deployment, signed-out users open the existing Privy sign-in instead of launching.
 * Static previews and undeployed networks do not require it.
 */
export function launchNeedsSignIn(opts: { deployed: boolean; staticPreview: boolean; signedIn: boolean }): boolean {
  return opts.deployed && !opts.staticPreview && !opts.signedIn;
}

/** Website field: prefix https:// when no scheme was typed (existing /create helper). */
export const withHttps = (w: string) => {
  const t = w.trim();
  return !t || /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t.replace(/^\/+/, "")}`;
};

function firstPathSeg(value: string): string {
  return value.split(/[/?#\s]/)[0] ?? "";
}

/**
 * Turn a typed X username or URL into https://x.com/handle.
 * Follows the usual profile-link pattern (X, Telegram, websites): add the public URL prefix if it is missing.
 */
export function normalizeTwitter(value: string): string | undefined {
  const t = value.trim();
  if (!t) return undefined;
  const bare = t.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  const hostMatch = bare.match(/^(?:x\.com|twitter\.com)\/(.+)$/i);
  if (hostMatch) {
    const handle = firstPathSeg(hostMatch[1].replace(/^@/, ""));
    return handle ? `https://x.com/${handle}` : undefined;
  }
  const handle = firstPathSeg(t.replace(/^@/, ""));
  if (!handle || handle.includes(".")) return t.includes(".") ? withHttps(t) : undefined;
  return `https://x.com/${handle}`;
}

/** Turn @name or a t.me URL into https://t.me/name. */
export function normalizeTelegram(value: string): string | undefined {
  const t = value.trim();
  if (!t) return undefined;
  const bare = t.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  const hostMatch = bare.match(/^(?:t\.me|telegram\.me)\/(.+)$/i);
  if (hostMatch) {
    const handle = firstPathSeg(hostMatch[1].replace(/^@/, ""));
    return handle ? `https://t.me/${handle}` : undefined;
  }
  const handle = firstPathSeg(t.replace(/^@/, ""));
  if (!handle) return undefined;
  return `https://t.me/${handle}`;
}

/** Add https:// to a website if the scheme is missing. */
export function normalizeWebsite(value: string): string | undefined {
  const t = value.trim();
  return t ? withHttps(t) : undefined;
}

export type LaunchSocials = NonNullable<LaunchCoinParams["socials"]>;

/**
 * Build the object that protocol-viem packs with JSON.stringify into LaunchParams.socialsURI.
 * Keys match LaunchCoinParams.socials: twitter, telegram, website. Empty fields are omitted;
 * an all-empty input returns undefined so the URI stays blank.
 */
export function buildLaunchSocials(input: { twitter?: string; telegram?: string; website?: string }): LaunchSocials | undefined {
  const twitter = normalizeTwitter(input.twitter ?? "");
  const telegram = normalizeTelegram(input.telegram ?? "");
  const websiteRaw = (input.website ?? "").trim();
  const website = websiteRaw ? withHttps(websiteRaw) : undefined;
  const socials: LaunchSocials = {};
  if (twitter) socials.twitter = twitter;
  if (telegram) socials.telegram = telegram;
  if (website) socials.website = website;
  return socials.twitter || socials.telegram || socials.website ? socials : undefined;
}

/** Same encoding launchCoin uses (web/lib/protocol-viem.ts). */
export const socialsURI = (socials: LaunchSocials | undefined) => (socials ? JSON.stringify(socials) : "");
