"use client";
/**
 * Who you're sending to (maker 2026-11-19: "send usdg and any disciple holdings to other disciple users ... with @").
 * One recipient model for every send and redirect: Cash (USDG), rocket tokens, tradable items, and the creator rewards
 * redirect. An @username resolves to the one wallet behind it (/api/profile/username?resolve=, one wallet per Privy
 * login); a plain 0x address is allowed where the caller says so (Cash out, rewards redirect), never for items.
 * Recent recipients are a per-browser convenience in localStorage.
 */
import { USERNAME_STORED_RE, normalizeUsername } from "@/lib/profile";
import { fetchProfileMeta } from "@/lib/profileMetaClient";
import { pfpUrl } from "@/lib/profileMeta";

export type Recipient = {
  address: string;
  /** "" for a plain address with no Disciple name */
  username: string;
  /** display name, "" when none */
  name: string;
  /** image url, "" when none */
  pfp: string;
};

export type Lookup =
  | { state: "idle" }
  | { state: "looking" }
  | { state: "found"; r: Recipient }
  | { state: "none"; username: string }
  | { state: "self" }
  | { state: "bad" };

const RECENT_KEY = "disciple.send.recent";
const RECENT_MAX = 6;
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// dev only (screenshots): window.__sendDev({ kai: { address, name, pfp } }) answers lookups with no server
type DevBook = Record<string, Omit<Recipient, "username">>;
let devBook: DevBook | null = null;
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (window as unknown as { __sendDev?: (b: DevBook, recent?: string[]) => void }).__sendDev = (b, recent) => {
    devBook = b;
    if (recent) saveRecent(recent.map((u) => ({ username: u, ...b[u] })));
  };
}

async function byAddress(address: string): Promise<Recipient> {
  const dev = devBook && Object.entries(devBook).find(([, v]) => v.address.toLowerCase() === address.toLowerCase());
  if (dev) return { username: dev[0], ...dev[1] };
  const [u, m] = await Promise.all([
    fetch(`/api/profile/username?address=${address}`).then((r) => r.json()).catch(() => ({ username: null })),
    fetchProfileMeta(address).catch(() => null),
  ]);
  return { address, username: u?.username ?? "", name: m?.name ?? "", pfp: m ? pfpUrl(m.pfp) : "" };
}

/** Resolve what the player typed. `me` is their own wallet (sending to yourself is refused). */
export async function lookup(raw: string, { me, allowAddress }: { me: string | null; allowAddress: boolean }): Promise<Lookup> {
  const t = raw.trim();
  if (!t || t === "@") return { state: "idle" };
  const mine = (a: string) => !!me && a.toLowerCase() === me.toLowerCase();
  if (/^0x/i.test(t)) {
    if (!allowAddress || !isAddr(t)) return { state: "bad" };
    if (mine(t)) return { state: "self" };
    return { state: "found", r: await byAddress(t) };
  }
  const u = normalizeUsername(t);
  if (!USERNAME_STORED_RE.test(u)) return { state: "bad" };
  let address: string | null = null;
  if (devBook) address = devBook[u]?.address ?? null;
  else address = await fetch(`/api/profile/username?resolve=${encodeURIComponent(u)}`).then((r) => r.json()).then((j) => j?.address ?? null).catch(() => null);
  if (!address) return { state: "none", username: u };
  if (mine(address)) return { state: "self" };
  const r = await byAddress(address);
  return { state: "found", r: { ...r, username: r.username || u } };
}

export function recentRecipients(): Recipient[] {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); return Array.isArray(v) ? v.filter((x) => x && isAddr(x.address)).slice(0, RECENT_MAX) : []; }
  catch { return []; }
}
function saveRecent(list: Recipient[]) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch { /* private window */ }
}
/** Call after a send lands. */
export function rememberRecipient(r: Recipient) {
  saveRecent([r, ...recentRecipients().filter((x) => x.address.toLowerCase() !== r.address.toLowerCase())]);
}

/** "@kai" or "0x12ab…9f3c" */
export const recipientLabel = (r: Recipient) => (r.username ? `@${r.username}` : shortAddr(r.address));
