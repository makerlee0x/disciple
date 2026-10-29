"use client";
/**
 * Coin icons for list rows (Profile › Rockets): each coin's own image, from the same source as the coin header and the
 * home list (on-chain Launchpad.metaOf imageURI → moderated store, lib/coinImages). No approved image ⇒ no entry, and
 * PairArt keeps its current placeholder. No default art (lee, Oct 26 9:15 AM CT).
 */
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { deployment, isDeployed } from "@/lib/chains";
import { launchpadAbi } from "@/lib/abi";
import { publicClient } from "@/lib/protocol-viem";
import { moderatedSrcs } from "@/lib/coinImages";

const uriOf = new Map<string, Promise<string>>(); // coin → imageURI ("" = none / read failed), per page load
function readUri(coin: string): Promise<string> {
  const k = coin.toLowerCase();
  let p = uriOf.get(k);
  if (!p) {
    p = publicClient().readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "metaOf", args: [coin as Address] })
      .then((m) => String((m as readonly unknown[])[2] ?? "")).catch(() => "");
    uriOf.set(k, p);
  }
  return p;
}

/** coin (lowercase) → store src, for the coins that have an approved image. */
export function useCoinIcons(coins: string[]): Record<string, string> {
  const [icons, setIcons] = useState<Record<string, string>>({});
  const key = coins.map((c) => c.toLowerCase()).sort().join(",");
  useEffect(() => {
    const list = key ? key.split(",").filter((c) => /^0x[0-9a-f]{40}$/.test(c)) : [];
    if (!list.length || !isDeployed()) return;
    let alive = true;
    (async () => {
      const uris = await Promise.all(list.map(readUri));
      const srcs = await moderatedSrcs(uris.filter(Boolean));
      const out: Record<string, string> = {};
      list.forEach((c, i) => { const s = uris[i] ? srcs.get(uris[i]) : ""; if (s) out[c] = s; });
      if (alive) setIcons(out);
    })().catch((e) => console.warn("[disciple] profile: coin icons unavailable", e));
    return () => { alive = false; };
  }, [key]);
  return icons;
}
