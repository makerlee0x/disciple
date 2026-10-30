"use client";
/** Coin page header art: pair art + name + ticker, the top row INSIDE the MARKET CAP card (desktop) (top-left next to the menu on mobile, art only), clear of the HUD panels. The page has no header band, so the 220px "header" size would cover HUD panels. */
import { useEffect, useRef, useState } from "react";
import { erc20Abi, isAddress, type Address } from "viem";
import { DEMO_POOL } from "@/lib/config";
import { deployment, isDeployed } from "@/lib/chains";
import { publicClient, readCurveState } from "@/lib/protocol-viem";
import { launchpadAbi } from "@/lib/abi";
import PairArt from "./PairArt";
import { basePair } from "@/lib/pairArt";
import { useCanvasCards } from "@/lib/game/cardLayoutStore";
import { pickCoinIcon, resolveCoinStoredImage, type StoredImage } from "@/lib/coinPageImage";

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
  // ONE header card (lee, Oct 30): this row sits INSIDE the engine's canvas card (icon · name · pair on top, then the card's
  // MARKET CAP label + big mcap). Publish its height so the card grows by it (engine.js coinIdRowH; 0 on phones, where the
  // row is art only next to the menu and the mcap lives in the phone pill).
  const ref = useRef<HTMLDivElement>(null);
  // pass 3 #4 (GAME): this row rides with the engine's header card when it is dragged / minimized (engine-published rect)
  const hc = useCanvasCards().cards.header;
  useEffect(() => {
    const el = ref.current, w = window as unknown as { __coinIdH?: number };
    if (!el) return;
    const pub = () => { w.__coinIdH = window.matchMedia?.("(max-width: 760px)").matches ? 0 : Math.ceil(el.getBoundingClientRect().height); };
    pub();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(pub) : null; ro?.observe(el);
    addEventListener("resize", pub);
    return () => { ro?.disconnect(); removeEventListener("resize", pub); w.__coinIdH = 0; };
  });
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
  // (the market cap is the card's big number right under this row, so it is not repeated here)
  const sub = [name.trim().toUpperCase() !== tk.trim().toUpperCase() ? `$${tk}` : "", pairSym].filter(Boolean).join(" · ");
  return (
    <div ref={ref} className="coin-id" data-testid="coin-name" style={hc ? { transform: hc.dx || hc.dy ? `translate(${hc.dx}px, ${hc.dy}px)` : undefined, display: hc.min || hc.closed ? "none" : undefined } : undefined} title={pairSym ? `${name} · $${tk} · ${pairSym}` : `${name} · $${tk}`} aria-label={pairSym ? `${name} paired with ${pairSym}` : name}>
      <PairArt src={icon} pair={ethPair ? null : pair} tk={tk} size="list" px={38} eager />
      <div className="coin-id-txt">
        <b>{name}</b>
        {sub && <span data-testid="coin-id-sub">{sub}</span>}
      </div>
    </div>
  );
}
