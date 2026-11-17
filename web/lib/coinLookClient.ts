"use client";
/** Browser side of coin looks (lib/coinLook, POST /api/collection op "coinlook"). Never throws: a coin with no look flies chrome. */
import { privyAccessToken } from "@/lib/aa/sessionState";
import { withBase } from "@/lib/base-path";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { coinLookMessage, isClassic, lookArt, lookFilter, trailRgb, type CoinLook } from "@/lib/coinLook";
import { STARTER_SKIN } from "@/lib/collection";

/**
 * Stamp the look on a coin the host just launched. The coin may take a moment to show on chain, so it retries.
 * `stealthEph` (a hidden launch: the stealth owner's ephemeral key) signs with that coin's stealth owner key instead of
 * sending the session, so the server can check it's the host without learning who they are.
 */
export async function saveCoinLook(token: string, look: CoinLook, stealthEph?: Hex, tries = 4): Promise<boolean> {
  let sig: Hex | null = null;
  if (stealthEph) {
    try {
      const { myStealthKeys, stealthKeyFor } = await import("@/lib/privateLaunch");
      const acct = privateKeyToAccount(stealthKeyFor(await myStealthKeys(), stealthEph) as Hex);
      sig = await acct.signMessage({ message: coinLookMessage(token, look.skin, look.trail) });
    } catch { return false; }
  }
  for (let i = 0; i < tries; i++) {
    try {
      const t = sig ? null : await privyAccessToken();
      if (!sig && !t) return false;
      const r = await fetch(withBase("/api/collection"), { method: "POST", headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) },
        body: JSON.stringify({ op: "coinlook", token, skin: look.skin, trail: look.trail, ...(sig ? { sig } : {}) }) });
      if (r.ok) return true;
      if (r.status !== 409 && r.status < 500) return false;
      const j = (await r.json().catch(() => null)) as { reason?: string } | null;
      if (j?.reason && /already has/.test(j.reason)) return true;
    } catch { /* network: retry */ }
    await new Promise((res) => setTimeout(res, 800 * (i + 1)));
  }
  return false;
}

/** A pilot's stored looks (GET /api/looks, lib/server/looks): the Hangar skin + trail they wear, with their copy's fx and art. */
export type OwnLooks = { skin?: string; trail?: string; fx?: { skin?: { burn: number; seed: number } }; art?: { skin?: string; geo?: [number, unknown] } };

/**
 * What the flight engine's setHull takes (public/flight/engine.js) for the rocket YOU fly: your Hangar skin, its shape and
 * badge spot, your trail colour. null = keep the chrome rocket (nothing worn, or only the starter Bullet).
 */
export function ownHull(l: OwnLooks) {
  if (!l.skin || l.skin === STARTER_SKIN) return null;
  const look: CoinLook = { skin: l.skin, trail: l.trail || "trail-gold", ...(l.fx?.skin ? { fx: l.fx.skin } : {}) };
  const a = lookArt(look);
  const src = l.art?.skin ?? a.src;
  if (!src) return null;
  const aspect = typeof l.art?.geo?.[0] === "number" ? l.art.geo[0] : a.aspect;
  return { src: /^https:/.test(src) ? src : withBase(src), aspect, badge: a.badge, rgb: trailRgb(look.trail), filter: isClassic(look) ? "" : lookFilter(look) ?? "", key: `${look.skin}|${look.trail}` };
}
