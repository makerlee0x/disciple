"use client";
/**
 * Data the Hangar needs beyond the old profile hooks: the lobby's rockets (to show fleet cards with tier, crew and
 * difficulty, and to count rockets this pilot launched), the pilot's hull and flare (own: this browser plus the server
 * copy; someone else's Hangar: their saved look) and their earned trophies.
 */
import { useEffect, useState } from "react";
import { IS_STATIC_PREVIEW, withBase } from "@/lib/base-path";
import { PARTS, type Slot } from "@/lib/parts";
import { LOADOUT_KEY, thrusterById } from "@/lib/rocketSkin";
import { FLARES, HULLS, isUnlocked, type Progress } from "@/lib/unlocks";
import { saveLooksSigned } from "@/lib/xpClient";
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
const writeStored = (eq: Partial<Record<Slot, string>>) => { try { localStorage.setItem(LOADOUT_KEY, JSON.stringify({ ...readStored(), equipped: eq })); } catch { /* private mode */ } };

/** A pilot's saved look from GET /api/looks (null: none saved, or offline). */
async function fetchLooks(wallet: string): Promise<{ hull: string; flare: string } | null> {
  if (IS_STATIC_PREVIEW) return null;
  try {
    const r = await fetch(withBase(`/api/looks?wallets=${wallet}`), { cache: "no-store" });
    const j = r.ok ? ((await r.json()) as { looks?: Record<string, { hull: string; flare: string }> }) : null;
    return j?.looks?.[wallet.toLowerCase()] ?? null;
  } catch { return null; }
}

/**
 * The pilot's rocket look. Own Hangar: the looks equipped in this browser, replaced by the server copy when there is one
 * (so it follows the pilot across devices), clamped to what `progress` has unlocked (lib/unlocks; until progress loads only
 * the free looks show). setHull / setFlare equip, save here and save to the server (signed) so other pilots see it on
 * the host's flights and on boosts. Someone else's Hangar: their saved look, or stock.
 */
export function useLoadout(own: boolean, progress: Progress | null, wallet: string | null) {
  const [eq, setEq] = useState<Partial<Record<Slot, string>>>({});
  const [note, setNote] = useState("");
  useEffect(() => {
    let alive = true;
    setEq(own ? readStored().equipped ?? {} : {});
    if (wallet) fetchLooks(wallet).then((l) => {
      if (!alive || !l) return;
      setEq((e) => { const n = { ...e, body: `body-${l.hull}`, thrusters: `thr-${l.flare}` }; if (own) writeStored({ ...readStored().equipped, ...n }); return n; });
    });
    return () => { alive = false; };
  }, [own, wallet]);
  const ref = (slot: Slot) => PARTS.find((p) => p.id === eq[slot] && p.slot === slot)?.ref;
  const allowed = (list: typeof HULLS, id: string | undefined) => {
    const l = list.find((x) => x.id === id);
    if (!own) return l ? l.id : list[0].id;   // the server already checked their unlocks
    return l && (progress ? isUnlocked(l.rule, progress) : l.rule.kind === "free") ? l.id : list[0].id;
  };
  const hull = allowed(HULLS, ref("body"));
  const flare = allowed(FLARES, ref("thrusters"));
  const coin = (own && ref("coin")) || STOCK.coin;
  const save = (slot: Slot, partId: string) => {
    const next = { ...readStored().equipped, ...eq, [slot]: partId };
    setEq(next); writeStored(next); setNote("");
    if (!own || !wallet) return;
    const h = slot === "body" ? partId.replace(/^body-/, "") : hull, f = slot === "thrusters" ? partId.replace(/^thr-/, "") : flare;
    saveLooksSigned(wallet, h, f).then((r) => { if (!r.ok) setNote(r.reason || "Couldn't save your look. It still shows here."); });
  };
  const loadout: Loadout = { skin: hull, coin, flame: thrusterById(flare).flame };
  return { loadout, hull, flare, note, setHull: (id: string) => save("body", `body-${id}`), setFlare: (id: string) => save("thrusters", `thr-${id}`) };
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
