"use client";
/** Coin page header art: pair art + name, compact chip docked in the empty foot of the sidebar rail (top-left next to the menu on mobile), clear of the HUD panels. The page has no header band, so the 220px "header" size would cover HUD panels.. */
import { DEMO_POOL } from "@/lib/config";
import PairArt from "./PairArt";
import { basePair } from "@/lib/pairArt";

const AI_ICON = "https://cdn.dexscreener.com/cms/images/U6RIzs8Fm7Jar6GE?width=256&height=256&quality=95&format=png";

export default function CoinIdentity({ address, sp }: { address: string; sp: URLSearchParams }) {
  const demo = address.toLowerCase() === DEMO_POOL.address.toLowerCase();
  const icon = sp.get("icon") || (demo && !sp.get("cs") ? AI_ICON : null);
  const pair = sp.get("pair") || (demo ? "ETH" : "STRATEGY");
  const tk = sp.get("cs") || (demo ? "AI" : "");
  const name = sp.get("nm") || (demo && tk === "AI" ? "Artificial Inu" : tk);
  if (!icon && !tk) return null;
  const bp = basePair(pair);
  return (
    <div className="coin-id" title={`${name} · $${tk} · ${bp?.sym ?? pair}`} aria-label={`${name} paired with ${bp?.sym ?? pair}`}>
      <PairArt src={icon} pair={pair} tk={tk} size="list" px={38} eager />
      <div className="coin-id-txt">
        <b>{name}</b>
        <span>${tk} · {bp?.sym ?? pair}</span>
      </div>
    </div>
  );
}
