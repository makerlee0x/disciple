/**
 * Quick Launch r4 copy and small helpers (BRAND mockups/quick-launch-r4 README).
 * Visible strings are the r4 board text, used exactly. Logic is unit-tested in
 * scripts/test-quick-launch.mts.
 */
import type { LaunchCoinParams } from "./protocol";

/** r4 Screen 2 mode cards, in the same order as the boards (Easy, Hard, Trench). */
export const QUICK_LAUNCH_MODE_COPY = {
  Easy: "At first, nobody can own more than 1% of the coins. That limit grows to 3.33% as the price goes up, until the rocket moves to the open market.",
  Hard: "At first, nobody can own more than 3.33% of the coins. That limit grows to 7.77% as the price goes up, until the rocket moves to the open market.",
  Trench: "There is no limit on how many coins one person can own.",
  footer: "You pick the mode when you launch, and you can't change it later. These limits only last until the rocket moves to the open market. After that, every rocket trades the same way.",
} as const;

export const QUICK_LAUNCH_COPY = {
  title: "Your rocket",
  pickMode: "Pick your mode",
  name: "Name",
  ticker: "Ticker",
  icon: "Badge",
  useOwnImage: "Use your own image",
  firstBoost: "First BOOST",
  firstBoostTip: "This is your first buy, at launch. You get first dibs on your own rocket.",
  custom: "Custom",
  chip0: "$0",
  chip5: "$5",
  chip20: "$20",
  modeChange: (label: string) => `Mode: ${label} · change`,
  advanced: "Advanced",
  pairCoin: "Pair coin",
  pairHelp: "Your rocket is bought and sold in this coin.",
  links: "Links",
  linkX: "X / social",
  linkXShort: "X",
  linkWebsite: "Website",
  linkTelegram: "Telegram",
  rewards: "Send your creator rewards to a different account",
  rewardsPlaceholder: "You",
  rewardsHelp: "Your rewards go to this account instead of you. You'll confirm this one extra time.",
  creatorTax: "Creator tax",
  creatorTaxHelp: "Permanent. A small cut of every trade goes to you. Higher tax can scare off players.",
  howLaunching: "How launching works",
  ready: (name: string) => `${name || "Your rocket"} · READY FOR LAUNCH`,
  liftoff: "3 · 2 · 1 · LIFTOFF",
  signInLine: "Sign in with email, Google, X or wallet",
  anon: "Anon launch",
  pseudo: "Pseudo launch",
  beta: "beta",
  anonHelp: "Your name isn't shown as the creator. This isn't fully private — the account that pays for the launch can still be seen.",
  pseudoHelp: "Your name isn't shown as the creator. Because you're buying in at launch, this isn't fully private — the account that pays can still be seen.",
  // Image rejected after a generated badge is in use (Oct 17 Quick Launch spec; not on the r4 boards).
  imageReverted: "That image can't be used. We've put your rocket's badge back.",
} as const;

/** localStorage key for the Advanced creator-tax slider (defaults to 0%). */
export const CREATOR_TAX_STORE_KEY = "disciple.create.creatorTax.v1";

export function readStoredCreatorTax(maxPct: number, storage?: Pick<Storage, "getItem"> | null): number {
  try {
    const raw = (storage ?? (typeof localStorage !== "undefined" ? localStorage : null))?.getItem(CREATOR_TAX_STORE_KEY);
    if (raw == null || raw === "") return 0;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, maxPct);
  } catch {
    return 0;
  }
}

export function storeCreatorTax(pct: number, storage?: Pick<Storage, "setItem"> | null): void {
  try {
    (storage ?? (typeof localStorage !== "undefined" ? localStorage : null))?.setItem(CREATOR_TAX_STORE_KEY, String(pct));
  } catch { /* private mode */ }
}

/** A First BOOST "has an amount" when the field parses to a number greater than 0. */
export function boostHasAmount(value: string): boolean {
  const n = Number.parseFloat(value.trim().replace(/,/g, "."));
  return Number.isFinite(n) && n > 0;
}

/** r4: $0 (or empty) → "Anon launch"; any First BOOST amount → "Pseudo launch". */
export function privateLaunchTitle(boostValue: string): "Anon launch" | "Pseudo launch" {
  return boostHasAmount(boostValue) ? "Pseudo launch" : "Anon launch";
}

export function privateLaunchHelp(boostValue: string): string {
  return boostHasAmount(boostValue) ? QUICK_LAUNCH_COPY.pseudoHelp : QUICK_LAUNCH_COPY.anonHelp;
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

export function normalizeTwitter(value: string): string | undefined {
  const t = value.trim().replace(/^@/, "");
  return t || undefined;
}

/** Telegram handle or URL, packed into socialsURI the same way twitter is (trim, strip a leading @). */
export function normalizeTelegram(value: string): string | undefined {
  const t = value.trim();
  if (!t) return undefined;
  if (/^(https?:\/\/|t\.me\/)/i.test(t)) return withHttps(t);
  return t.replace(/^@/, "") || undefined;
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
