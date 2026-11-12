"use client";
/**
 * Data the Hangar needs beyond the old profile hooks: the lobby's rockets (to show fleet cards with tier, crew and
 * difficulty, and to count rockets this pilot launched), the pilot's Rocket Factory loadout (kept in this browser, so
 * only the owner's own Hangar shows it; others see the stock rocket) and their earned trophies.
 */
import { useEffect, useState } from "react";
import { IS_STATIC_PREVIEW, withBase } from "@/lib/base-path";
import { PARTS, type Slot } from "@/lib/parts";
import { LOADOUT_KEY, thrusterById } from "@/lib/rocketSkin";
import type { HomeCoin, HomeData } from "@/lib/home/trending";

/** Every rocket on the lobby, by token (lower case). null while loading. */
export function useHomeCoins(): Map<string, HomeCoin> | null {
  const [m, setM] = useState<Map<string, HomeCoin> | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(withBase("/api/home"), { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
      .then((d: HomeData | null) => { if (alive) setM(new Map((d?.coins ?? []).map((c) => [c.token.toLowerCase(), c]))); })
      .catch(() => { if (alive) setM(new Map()); });
    return () => { alive = false; };
  }, []);
  return m;
}

export type Loadout = { skin: string; coin: string; flame: string };
const STOCK: Loadout = { skin: "chrome", coin: "halo", flame: thrusterById("stock").flame };

/** The equipped Rocket Factory parts in this browser (own Hangar only). */
export function useLoadout(own: boolean): Loadout {
  const [l, setL] = useState<Loadout>(STOCK);
  useEffect(() => {
    if (!own) { setL(STOCK); return; }
    try {
      const raw = localStorage.getItem(LOADOUT_KEY);
      const eq = raw ? ((JSON.parse(raw) as { equipped?: Partial<Record<Slot, string>> }).equipped ?? {}) : {};
      const ref = (slot: Slot) => PARTS.find((p) => p.id === eq[slot] && p.slot === slot)?.ref;
      setL({ skin: ref("body") || STOCK.skin, coin: ref("coin") || STOCK.coin, flame: thrusterById(ref("thrusters") || "stock").flame });
    } catch { setL(STOCK); }
  }, [own]);
  return l;
}

/** Trophy ids this wallet has earned, with when (ms). null while loading. */
export function useTrophies(wallet: string | null): Map<string, number> | null {
  const [m, setM] = useState<Map<string, number> | null>(null);
  useEffect(() => {
    if (!wallet || IS_STATIC_PREVIEW) { setM(new Map()); return; }
    let alive = true;
    setM(null);
    fetch(withBase(`/api/achievements?wallet=${wallet}`), { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
      .then((j: { items?: { id: string; unlockedAt?: number }[] } | null) => {
        if (alive) setM(new Map((j?.items ?? []).filter((i) => i.unlockedAt).map((i) => [i.id, i.unlockedAt!])));
      })
      .catch(() => { if (alive) setM(new Map()); });
    return () => { alive = false; };
  }, [wallet]);
  return m;
}
