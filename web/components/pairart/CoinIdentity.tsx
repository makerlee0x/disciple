"use client";
/** Coin page header art: pair art + name, compact chip docked in the empty foot of the sidebar rail (top-left next to the menu on mobile), clear of the HUD panels. The page has no header band, so the 220px "header" size would cover HUD panels.. */
import { useEffect, useState } from "react";
import { erc20Abi, isAddress, type Address } from "viem";
import { DEMO_POOL } from "@/lib/config";
import { isDeployed } from "@/lib/chains";
import { publicClient, readCurveState } from "@/lib/protocol-viem";
import PairArt from "./PairArt";
import { basePair } from "@/lib/pairArt";
import { isStoreSrc } from "@/lib/coinImages";

const AI_ICON = "https://cdn.dexscreener.com/cms/images/U6RIzs8Fm7Jar6GE?width=256&height=256&quality=95&format=png";

export default function CoinIdentity({ address, sp }: { address: string; sp: URLSearchParams }) {
  const demo = address.toLowerCase() === DEMO_POOL.address.toLowerCase();
  // only moderated-store images (what the launchpad list hands out) or the demo icon: a crafted ?icon= link can't
  // make the coin page render an arbitrary image (W-3e)
  const q = sp.get("icon");
  const icon = (isStoreSrc(q) ? q : null) || (demo && !sp.get("cs") ? AI_ICON : null);
  // 1e: a direct /coin/0x… link has no ?cs/?nm ⇒ read name / symbol / pair from chain so the name always shows
  const [chain, setChain] = useState<{ name: string; symbol: string; pair?: string } | null>(null);
  const needRead = !demo && !sp.get("cs") && isDeployed() && isAddress(address);
  useEffect(() => {
    if (!needRead) return;
    let alive = true;
    const pc = publicClient(), coin = address as Address;
    Promise.all([
      pc.readContract({ address: coin, abi: erc20Abi, functionName: "name" }),
      pc.readContract({ address: coin, abi: erc20Abi, functionName: "symbol" }),
      readCurveState(pc, coin).then((st) => pc.readContract({ address: st.quote as Address, abi: erc20Abi, functionName: "symbol" })).catch(() => undefined),
    ]).then(([name, symbol, pair]) => { if (alive) setChain({ name: String(name), symbol: String(symbol), pair: pair ? String(pair) : undefined }); }).catch(() => undefined);
    return () => { alive = false; };
  }, [needRead, address]);
  const pair = sp.get("pair") || chain?.pair || (demo ? "ETH" : "STRATEGY");
  const tk = sp.get("cs") || chain?.symbol || (demo ? "AI" : "");
  const name = sp.get("nm") || chain?.name || (demo && tk === "AI" ? "Artificial Inu" : tk);
  if (!icon && !tk) return null;
  const bp = basePair(pair);
  return (
    <div className="coin-id" data-testid="coin-name" title={`${name} · $${tk} · ${bp?.sym ?? pair}`} aria-label={`${name} paired with ${bp?.sym ?? pair}`}>
      <PairArt src={icon} pair={pair} tk={tk} size="list" px={38} eager />
      <div className="coin-id-txt">
        <b>{name}</b>
        <span>${tk} · {bp?.sym ?? pair}</span>
      </div>
    </div>
  );
}
