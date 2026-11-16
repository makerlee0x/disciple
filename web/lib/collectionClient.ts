"use client";
/** Browser side of /api/collection (lib/server/collection.ts). Writes carry the Privy session; nothing throws. */
import { useCallback, useEffect, useState } from "react";
import { privyAccessToken } from "@/lib/aa/sessionState";
import { withBase, IS_STATIC_PREVIEW } from "@/lib/base-path";
import { XP_CHANGED_EVENT } from "@/lib/xpClient";
import { applyCatalog, catalogVersion, type Catalog, type Collection, type CollectionAction, type Copy, type Item, type Opened, type ShopStock } from "@/lib/collection";

export const COLLECTION_CHANGED_EVENT = "disciple:collection-changed";

export function useCollection(wallet: string | null) {
  const [col, setCol] = useState<Collection | null>(null);
  const [shop, setShop] = useState<ShopStock | null>(null);
  const load = useCallback(() => {
    if (IS_STATIC_PREVIEW) return;
    fetch(withBase(`/api/collection${wallet ? `?wallet=${wallet}` : ""}`), { cache: "no-store" }).then((r) => r.json())
      .then((j: { ok?: boolean; collection?: Collection | null; shop?: ShopStock; catalog?: Catalog | null }) => {
        if (!j?.ok) return;
        // the live catalogue (new drops and items set from /admin/catalog) goes in before anything renders with it
        if (j.catalog !== undefined && (j.catalog?.v ?? 0) !== catalogVersion()) applyCatalog(j.catalog ?? null);
        setCol(j.collection ?? null); setShop(j.shop ?? null);
      })
      .catch(() => {});
  }, [wallet]);
  useEffect(() => {
    load();
    addEventListener(COLLECTION_CHANGED_EVENT, load);
    return () => removeEventListener(COLLECTION_CHANGED_EVENT, load);
  }, [load]);
  return { col, shop, reload: load };
}

/** item/copy come back from a trade-up; xp from a scrap */
export type ActionResult = { ok: boolean; reason?: string; opened?: Opened; item?: Item; copy?: Copy; xp?: number };
export async function collectionAction(wallet: string, a: CollectionAction): Promise<ActionResult> {
  try {
    const t = await privyAccessToken();
    if (!t) return { ok: false, reason: "Sign in to use your Hangar." };
    const r = await fetch(withBase("/api/collection"), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t}`, "x-wallet": wallet }, body: JSON.stringify(a) });
    const j = (await r.json().catch(() => null)) as (Omit<ActionResult, "ok"> & { ok?: boolean }) | null;
    if (j?.ok) { dispatchEvent(new Event(COLLECTION_CHANGED_EVENT)); if (a.op !== "equip") dispatchEvent(new Event(XP_CHANGED_EVENT)); }
    return { ok: !!j?.ok, reason: j?.reason ?? (j?.ok ? undefined : "Couldn't reach the Hangar. Try again."), opened: j?.opened, item: j?.item, copy: j?.copy, xp: j?.xp };
  } catch { return { ok: false, reason: "Couldn't reach the Hangar. Try again." }; }
}
