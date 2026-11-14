/**
 * In-app browsers (maker, 2026-11-14 mobile first-run review): most crypto Twitter traffic opens inside X's own browser.
 * Google refuses sign-in inside embedded browsers ("disallowed_useragent"), so the Google button fails there. We hide
 * Google in those browsers (email, X and wallets still work) and offer "Open in Safari / Chrome".
 * Pure, tested (scripts/test-first-run.mts).
 */
export type InAppKind = "x" | "telegram" | "instagram" | "facebook" | "tiktok" | "discord" | "linkedin" | "other" | null;

const RULES: [InAppKind, RegExp][] = [
  ["x", /\bTwitter(?:Android)?\b|Twitter for iP(?:hone|ad)/i],
  ["telegram", /\bTelegram\b/i],
  ["instagram", /\bInstagram\b/i],
  ["facebook", /\bFBAN\/|\bFBAV\/|\bFB_IAB\b/i],
  ["tiktok", /musical_ly|\bBytedanceWebview\b|\bTikTok\b/i],
  ["discord", /\bDiscord\b/i],
  ["linkedin", /\bLinkedInApp\b/i],
];

/** Which app's built-in browser this is, or null for a real browser. */
export function inAppKind(ua: string): InAppKind {
  for (const [k, re] of RULES) if (re.test(ua)) return k;
  // Android WebView marks itself "; wv)"; it isn't a browser the player picked
  if (/Android/i.test(ua) && /;\s?wv\)/i.test(ua)) return "other";
  return null;
}

export const isIOS = (ua: string) => /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile/i.test(ua));
export const isAndroid = (ua: string) => /Android/i.test(ua);

const APP_NAME: Record<Exclude<InAppKind, null>, string> = {
  x: "X", telegram: "Telegram", instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", discord: "Discord", linkedin: "LinkedIn", other: "this app",
};
export const inAppName = (k: Exclude<InAppKind, null>) => APP_NAME[k];

/** Android: an intent: link that opens the same page in Chrome. iOS has no such link, so the banner copies the link instead. */
export function chromeIntent(url: string): string | null {
  try {
    const u = new URL(url);
    return `intent://${u.host}${u.pathname}${u.search}${u.hash}#Intent;scheme=${u.protocol.replace(":", "")};package=com.android.chrome;end`;
  } catch { return null; }
}

export function currentInApp(): InAppKind {
  if (typeof navigator === "undefined") return null;
  return inAppKind(navigator.userAgent || "");
}
