"use client";
/** Client side of /api/xp, /api/shop/buy and /api/xp/prestige (lib/server/xp.ts has the ledger). */
import { useCallback, useEffect, useState } from "react";
import { IS_STATIC_PREVIEW } from "./base-path";
import { onWallet } from "./walletState";   // light: no viem in the lobby level chip (mobile plan speed fix 1)
import { dayPeriod, levelInfo, looksMessage, missionsFor, prestigeMessage, shopBuyMessage, weekPeriod, type XpSummary } from "./xp";

const isAddr = (a: string | null | undefined): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);
export const XP_CHANGED_EVENT = "disciple:xp-changed";
const POLL_MS = 60_000;

export async function fetchXp(wallet: string | null | undefined): Promise<XpSummary | null> {
  if (IS_STATIC_PREVIEW || !isAddr(wallet)) return null;
  try {
    const r = await fetch(`/api/xp?wallet=${wallet.toLowerCase()}`, { cache: "no-store" });
    return r.ok ? ((await r.json()) as XpSummary) : null;
  } catch { return null; }
}

/** The signed-in pilot's wallet (lowercase) or null. */
export function usePilotWallet(): string | null {
  const [w, setW] = useState<string | null>(null);
  useEffect(() => onWallet((a) => setW(a ? a.toLowerCase() : null)), []);
  return w;
}

/** XP summary for a wallet: loads, re-polls every minute and on XP_CHANGED_EVENT. */
export function useXp(wallet: string | null) {
  const [xp, setXp] = useState<XpSummary | null>(null);
  const [ready, setReady] = useState(false);
  const load = useCallback(() => { fetchXp(wallet).then((x) => { setXp(x); setReady(true); }); }, [wallet]);
  useEffect(() => {
    setXp(null); setReady(false); load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, POLL_MS);
    addEventListener(XP_CHANGED_EVENT, load);
    return () => { clearInterval(t); removeEventListener(XP_CHANGED_EVENT, load); };
  }, [load]);
  return { xp, ready, reload: load };
}

async function signedPost(address: string, url: string, msg: (a: string, n: string) => string, extra: Record<string, unknown> = {}): Promise<{ ok: boolean; reason?: string } & Record<string, unknown>> {
  try {
    const a = address.toLowerCase();
    const { nonce } = (await (await fetch(`/api/xp?nonce=1&address=${a}`, { cache: "no-store" })).json()) as { nonce?: string };
    if (!nonce) return { ok: false, reason: "Could not reach the server." };
    const { signWalletMessage } = await import("./profile");   // wallet stack loads only when the pilot signs
    const s = await signWalletMessage(msg(a, nonce), a);
    if (!s) return { ok: false, reason: "Signing was cancelled." };
    const r = (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: a, nonce, ...s, ...extra }) })).json()) as { ok?: boolean; reason?: string };
    if (r.ok) window.dispatchEvent(new Event(XP_CHANGED_EVENT));
    return { ...r, ok: !!r.ok };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "Something went wrong." };
  }
}

export const buyPartWithXp = (address: string, part: string) => signedPost(address, "/api/shop/buy", (a, n) => shopBuyMessage(a, part, n), { part });
export const prestigeWithXp = (address: string) => signedPost(address, "/api/xp/prestige", prestigeMessage);
/** Save the Hangar look (hull + flare) on the server so other pilots see it (POST /api/looks). */
export const saveLooksSigned = (address: string, hull: string, flare: string) => signedPost(address, "/api/looks", (a, n) => looksMessage(a, hull, flare, n), { hull, flare });

/** "4h 12m" until ts. */
export function untilLabel(ts: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((ts - now) / 60_000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`;
}

/** This period's missions with no progress (signed out, or before the first score). Same roll for every pilot. */
export function blankXp(now = Date.now()): XpSummary {
  const d = dayPeriod(now), w = weekPeriod(now);
  const view = (p: typeof d) => ({ period: p.id, resetsAt: p.end, missions: missionsFor(p).map((m) => ({ id: m.id, title: m.title, xp: m.xp, target: m.target, progress: 0, done: false })) });
  return { wallet: "", totalXp: 0, spendableXp: 0, level: levelInfo(0), daily: view(d), weekly: view(w), owned: [], weekXp: 0, recent: [], evaluatedAt: null };
}
