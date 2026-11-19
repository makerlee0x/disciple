"use client";
/**
 * Holder chips on a pilot's profile: DISCIPLE (holds a Disciple on Solana) and ACCESS KEY (holds one of The Twelve on
 * Ethereum). Status only, never a promise of anything (maker 2026-11-17). Renders nothing for non-holders.
 */
import { useEffect, useState } from "react";
import { EMPTY_HOLDER, fetchHolder } from "@/lib/nft/client";
import { PROFILE_CHANGED_EVENT } from "@/lib/profile";
import { FOUNDER_URL } from "@/lib/nft/config";

export default function HolderTags({ wallet }: { wallet: string }) {
  const [h, setH] = useState(EMPTY_HOLDER);
  useEffect(() => {
    let alive = true;
    const read = () => { void fetchHolder(wallet).then((x) => { if (alive) setH(x); }); };
    read();
    window.addEventListener(PROFILE_CHANGED_EVENT, read);
    return () => { alive = false; window.removeEventListener(PROFILE_CHANGED_EVENT, read); };
  }, [wallet]);
  if (!h.disciples && !h.founders) return null;
  return (
    <>
      {h.founders > 0 && <a className="nft-tag founder" href={FOUNDER_URL} target="_blank" rel="noopener noreferrer" data-testid="tag-founder" title={`${h.founders} ${h.founders === 1 ? "Access Key" : "Access Keys"} · OpenSea`}>Access key{h.founders > 1 ? ` ×${h.founders}` : ""}</a>}
      {h.disciples > 0 && <span className="nft-tag disciple" data-testid="tag-disciple" title={`${h.disciples} ${h.disciples === 1 ? "Disciple" : "Disciples"}`}>Disciple{h.disciples > 1 ? ` ×${h.disciples}` : ""}</span>}
    </>
  );
}
