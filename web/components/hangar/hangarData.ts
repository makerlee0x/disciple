"use client";
/**
 * Data the Hangar needs beyond the old profile hooks: the lobby's rockets (to show fleet cards with tier, crew and
 * difficulty, and to count rockets this pilot launched), the pilot's equipped hull and flare (kept in this browser, so
 * only the owner's own Hangar shows them; others see the stock rocket) and their earned trophies.
 */
import { useEffect, useState } from "react";
import { IS_STATIC_PREVIEW, withBase } from "@/lib/base-path";
import { PARTS, type Slot } from "@/lib/parts";
import { LOADOUT_KEY, thrusterById } from "@/lib/rocketSkin";
import { FLARES, HULLS, isUnlocked, type Progress } from "@/lib/unlocks";
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

type Stored = { equipped?: Partial<Record<Slot, string>> };
const readStored = (): Stored => { try { return JSON.parse(localStorage.getItem(LOADOUT_KEY) || "{}") as Stored; } catch { return {}; } };

/**
 * The equipped looks in this browser (own Hangar only; others see the stock rocket). Hull and flare are clamped to what
 * `progress` has unlocked (lib/unlocks); until progress loads only the free looks show. setHull / setFlare equip and save.
 */
export function useLoadout(own: boolean, progress: Progress | null) {
  const [eq, setEq] = useState<Partial<Record<Slot, string>>>({});
  useEffect(() => { setEq(own ? readStored().equipped ?? {} : {}); }, [own]);
  const ref = (slot: Slot) => PARTS.find((p) => p.id === eq[slot] && p.slot === slot)?.ref;
  const allowed = (list: typeof HULLS, id: string | undefined) => {
    const l = list.find((x) => x.id === id);
    return l && (progress ? isUnlocked(l.rule, progress) : l.rule.kind === "free") ? l.id : list[0].id;
  };
  const hull = own ? allowed(HULLS, ref("body")) : STOCK.skin;
  const flare = own ? allowed(FLARES, ref("thrusters")) : "stock";
  const coin = (own && ref("coin")) || STOCK.coin;
  const save = (slot: Slot, partId: string) => {
    const next = { ...readStored().equipped, ...eq, [slot]: partId };
    setEq(next);
    try { localStorage.setItem(LOADOUT_KEY, JSON.stringify({ ...readStored(), equipped: next })); } catch { /* private mode: still equipped for this visit */ }
  };
  const loadout: Loadout = { skin: hull, coin, flame: thrusterById(flare).flame };
  return { loadout, hull, flare, setHull: (id: string) => save("body", `body-${id}`), setFlare: (id: string) => save("thrusters", `thr-${id}`) };
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
