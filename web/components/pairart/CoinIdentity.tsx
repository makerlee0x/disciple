"use client";
/** Coin page header art: pair art + name + ticker, docked right under the MARKET CAP panel (top-left next to the menu on mobile, art only), clear of the HUD panels. The page has no header band, so the 220px "header" size would cover HUD panels. */
import { useEffect, useState } from "react";
import { erc20Abi, isAddress, type Address } from "viem";
import { DEMO_POOL } from "@/lib/config";
import { deployment, isDeployed } from "@/lib/chains";
import { publicClient, readCurveState } from "@/lib/protocol-viem";
import { launchpadAbi } from "@/lib/abi";
import PairArt from "./PairArt";
import { basePair } from "@/lib/pairArt";
import { pickCoinIcon, resolveCoinStoredImage, type StoredImage } from "@/lib/coinPageImage";

const MCAP_FMT = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const AI_ICON = "https://cdn.dexscreener.com/cms/images/U6RIzs8Fm7Jar6GE?width=256&height=256&quality=95&format=png";

export default function CoinIdentity({ address, sp }: { address: string; sp: URLSearchParams }) {
  const demo = address.toLowerCase() === DEMO_POOL.address.toLowerCase();
  // The coin's own stored image: on-chain metaOf imageURI → moderated-store allowlist (/api/image/resolve), same source
  // as the home list. It wins over ?icon= (store-gated first paint only), so a crafted ?icon= link can't make the coin
  // page render some other image (W-3e); unapproved / unknown ⇒ letter placeholder. lib/coinPageImage.
  const [stored, setStored] = useState<StoredImage>(undefined);
  const readImage = !demo && isDeployed() && isAddress(address);
  useEffect(() => {
    setStored(undefined);
    if (!readImage) return;
    let alive = true;
    const pc = publicClient();
    resolveCoinStoredImage(() => pc.readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "metaOf", args: [address as Address] })
      .then((m) => String((m as readonly unknown[])[2] ?? "")))
      .then((s) => { if (alive) setStored(s); });
    return () => { alive = false; };
  }, [readImage, address]);
  const icon = pickCoinIcon(stored, sp.get("icon"), demo && !sp.get("cs") ? AI_ICON : null);
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
  // one header card (coin page cleanup, lee Oct 30): name + pair + market cap, from the engine's real mark (disciple:mark)
  const [mcap, setMcap] = useState(0);
  useEffect(() => {
    const on = (e: Event) => { const m = Number((e as CustomEvent<{ mcap?: number }>).detail?.mcap); if (Number.isFinite(m) && m > 0) setMcap(m); };
    addEventListener("disciple:mark", on);
    return () => removeEventListener("disciple:mark", on);
  }, []);
  const pair = sp.get("pair") || chain?.pair || (demo ? "ETH" : "STRATEGY");
  const tk = sp.get("cs") || chain?.symbol || (demo ? "AI" : "");
  const name = sp.get("nm") || chain?.name || (demo && tk === "AI" ? "Artificial Inu" : tk);
  if (!icon && !tk) return null;
  const bp = basePair(pair);
  // Dollars-only rule (no ETH / gas wording on player surfaces): an ETH / WETH pair gets no pair badge or pair label;
  // the chip is the coin's own art + name. Other pairs keep their badge.
  const ethPair = bp?.tk === "eth" || /^w?eth$/i.test(pair);
  const pairSym = ethPair ? "" : bp?.sym ?? pair;
  // the ticker shows once: "$TK" only when the name isn't already the ticker
  const sub = [name.trim().toUpperCase() !== tk.trim().toUpperCase() ? `$${tk}` : "", pairSym,
    mcap > 0 ? `${MCAP_FMT.format(mcap)} mcap` : ""].filter(Boolean).join(" · ");   // Copy pending lee approval ("mcap")
  return (
    <div className="coin-id" data-testid="coin-name" title={pairSym ? `${name} · $${tk} · ${pairSym}` : `${name} · $${tk}`} aria-label={pairSym ? `${name} paired with ${pairSym}` : name}>
      <PairArt src={icon} pair={ethPair ? null : pair} tk={tk} size="list" px={38} eager />
      <div className="coin-id-txt">
        <b>{name}</b>
        {sub && <span data-testid="coin-id-sub">{sub}</span>}
      </div>
    </div>
  );
}
