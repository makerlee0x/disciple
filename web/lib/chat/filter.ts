/** Pure chat text filter: trim, collapse whitespace, strip links, mask profanity. No deps (unit-tested). */
import { CHAT_LIMITS } from "./types";

const LINK_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|xyz|gg|app|dev|co|me|ly|link|site|fun|finance|money|vip|top|ru|cn|tk|to|sh|so|ai|cc|tv|in|us|uk|info|biz|click|live|lol)\b(?:\/\S*)?/gi;
// Basic list; matched on word stems, leetspeak-normalized. Slurs + common profanity.
// STEMS match as prefix (fucking, shitcoin); EXACT only as the whole word (+s) so "cockpit"/"spice" survive.
const STEMS = ["fuck", "shit", "cunt", "bitch", "nigger", "nigga", "faggot", "retard", "whore", "asshole", "bastard", "pussy", "tranny"];
const EXACT = ["fag", "slut", "dick", "cock", "kike", "spic", "chink", "twat"];
const isBad = (n: string) => STEMS.some((b) => n.startsWith(b) || n.endsWith(b)) || EXACT.some((b) => n === b || n === b + "s");
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" };
const norm = (w: string) => w.toLowerCase().replace(/[013457@$!]/g, (c) => LEET[c]).replace(/[^a-z]/g, "");
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

export type FilterResult = { ok: true; text: string } | { ok: false; error: "too_long" | "filtered" };

export function maskProfanity(text: string): string {
  return text.replace(new RegExp("[\\p{L}\\p{N}@$!]+", "gu"), (w) => {
    const n = norm(w);
    return n && isBad(n) ? w[0] + "*".repeat(Math.max(1, w.length - 1)) : w;
  });
}
export function stripLinks(text: string): string { return text.replace(LINK_RE, "[link]"); }

export function filterText(raw: unknown): FilterResult {
  const s = String(raw ?? "").replace(CTRL, "").replace(/\s+/g, " ").trim();
  if (Array.from(s).length > CHAT_LIMITS.maxLen) return { ok: false, error: "too_long" };
  const out = maskProfanity(stripLinks(s)).trim();
  if (!out || out === "[link]") return { ok: false, error: "filtered" };
  return { ok: true, text: out };
}
