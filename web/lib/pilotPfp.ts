"use client";
/**
 * The signed-in pilot's picture for the top bar pill and the account menu (maker 2026-11-17): the saved profile picture,
 * and whether it is a Disciple NFT (drawn in the gold hex frame, like the profile). Re-read after Edit profile saves.
 */
import { useEffect, useState } from "react";
import { fetchProfileMeta } from "./profileMetaClient";
import { pfpUrl } from "./profileMeta";
import { withBase } from "./base-path";
import { PROFILE_CHANGED_EVENT } from "./profile";

export type PilotPfp = { img: string | null; nft: boolean };
const cache = new Map<string, PilotPfp>();

export function usePilotPfp(wallet: string | null): PilotPfp {
  const key = wallet?.toLowerCase() ?? "";
  const [v, setV] = useState<PilotPfp>(() => cache.get(key) ?? { img: null, nft: false });
  useEffect(() => {
    if (!key) { setV({ img: null, nft: false }); return; }
    let alive = true;
    const c = cache.get(key); if (c) setV(c);
    const read = () => {
      void fetchProfileMeta(key).then((m) => {
        const u = pfpUrl(m.pfp);
        const next = { img: u ? withBase(u) : null, nft: !!u && !!m.nft };
        cache.set(key, next);
        if (alive) setV(next);
      });
    };
    read();
    window.addEventListener(PROFILE_CHANGED_EVENT, read);
    return () => { alive = false; window.removeEventListener(PROFILE_CHANGED_EVENT, read); };
  }, [key]);
  return v;
}
