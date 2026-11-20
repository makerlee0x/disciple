"use client";
/** Coin page header art: pair art + name + ticker, the top row INSIDE the MARKET CAP card (desktop) (top-left next to the menu on mobile, art only), clear of the HUD panels. The page has no header band, so the 220px "header" size would cover HUD panels. */
import { useEffect, useRef, useState } from "react";
import { erc20Abi, isAddress, type Address } from "viem";
import { DEMO_POOL } from "@/lib/config";
import { deployment, isDeployed } from "@/lib/chains";
import { curveOf, publicClient, readCurveState } from "@/lib/protocol-viem";
import { launchpadAbi } from "@/lib/abi";
import { isLegacyCurve } from "@/lib/legacyGate";
import PairArt from "./PairArt";
import { basePair } from "@/lib/pairArt";
import { isPhoneUI, useCanvasCards } from "@/lib/game/cardLayoutStore";
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
  // 1e: always read name / symbol / pair from chain; ?nm / ?cs are first paint only and the chain values win. Gating the read
  // on ?cs showed "SPACE" for "Space Cowboy" (the launch redirect sent ?cs but no ?nm; maker 2026-11-20 mainnet test launch).
  const [chain, setChain] = useState<{ name: string; symbol: string; pair?: string } | null>(null);
  const [legacy, setLegacy] = useState(false);
  const needRead = !demo && isDeployed() && isAddress(address);
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
  // Legacy / archived (lee option B): curve.loginGate() ≠ live LoginGate — badge only; trades are never blocked by it.
  useEffect(() => {
    setLegacy(false);
    if (demo || !isDeployed() || !isAddress(address)) return;
    let alive = true;
    const pc = publicClient();
    curveOf(pc, address as Address)
      .then((c) => isLegacyCurve(pc, c))
      .then((v) => { if (alive) setLegacy(!!v); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [demo, address]);
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
  const tk = chain?.symbol || sp.get("cs") || (demo ? "AI" : "");
  const name = chain?.name || sp.get("nm") || (demo && tk === "AI" ? "Artificial Inu" : tk);
  const bp = basePair(pair);
  // Dollars-only rule (no ETH / gas wording on player surfaces): an ETH / WETH pair gets no pair badge or pair label;
  // the chip is the coin's own art + name. Other pairs keep their badge.
  const ethPair = bp?.tk === "eth" || /^w?eth$/i.test(pair);
  const pairSym = ethPair ? "" : bp?.sym ?? pair;
  // ticker/quote from the real coin data, written as TICKER/QUOTE (lee Nov 10: "GTNEAR/STRATEGY")
  const ticker = String(tk || "").replace(/^\$/, "").trim().toUpperCase();
  const quote = String(pairSym || "").replace(/^\$/, "").trim().toUpperCase();
  const sub = ticker && quote ? `${ticker}/${quote}` : ticker;
  // the engine's header card draws the name + TICKER/PAIR (window.__coinName / __coinPair, worker-mirrored); the desktop row stays hidden
  useEffect(() => { const w = window as unknown as { __coinName?: string; __coinPair?: string }; w.__coinName = name || ""; w.__coinPair = quote; return () => { w.__coinName = ""; w.__coinPair = ""; }; }, [name, quote]);
  // desktop: the coin's image before its name on the engine's header card (maker 2026-11-20); the engine leaves the room
  // (window.__coinIconOn) and publishes the spot (CARD_RECTS.header.icon), this draws it there
  useEffect(() => { const w = window as unknown as { __coinIconOn?: boolean }; w.__coinIconOn = !!icon; return () => { w.__coinIconOn = false; }; }, [icon]);
  if (!icon && !tk) return null;
  return (
    <>
    {icon && <CardIcon src={icon} tk={tk} />}
    <div ref={ref} className="coin-id" data-testid="coin-name" style={hc ? { transform: hc.dx || hc.dy ? `translate(${hc.dx}px, ${hc.dy}px)` : undefined, display: hc.min || hc.closed ? "none" : undefined } : undefined} title={sub ? `${name} · ${sub}` : name} aria-label={pairSym ? `${name} paired with ${pairSym}` : name}>
      <PairArt src={icon} pair={ethPair ? null : pair} tk={tk} size="list" px={38} eager />
      <div className="coin-id-txt">
        <b>{name}</b>
        {sub && <span data-testid="coin-id-sub">{sub}</span>}
        {legacy && <span className="coin-id-legacy" data-testid="coin-legacy" title="Launched under an older login gate. Easy buys are off.">Legacy</span>}
      </div>
    </div>
    </>
  );
}

function CardIcon({ src, tk }: { src: string; tk: string }) {
  const hc = useCanvasCards().cards.header as ({ x: number; y: number; dx: number; dy: number; min?: boolean; closed?: boolean; icon?: { x: number; y: number; s: number } } | undefined);
  const [wrap, setWrap] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const f = () => { const r = document.getElementById("wrap")?.getBoundingClientRect(); setWrap(r && !isPhoneUI() ? { x: r.left, y: r.top } : null); };
    f(); addEventListener("resize", f);
    return () => removeEventListener("resize", f);
  }, [hc?.x, hc?.y]);
  if (!hc?.icon || !wrap || hc.min || hc.closed) return null;
  return (
    <div data-testid="coin-card-icon" aria-hidden style={{ position: "fixed", zIndex: 61, pointerEvents: "none", left: wrap.x + hc.icon.x + (hc.dx || 0), top: wrap.y + hc.icon.y + (hc.dy || 0), width: hc.icon.s, height: hc.icon.s, borderRadius: "50%", overflow: "hidden" }}>
      <PairArt src={src} pair={null} tk={tk} size="icon" px={hc.icon.s} eager />
    </div>
  );
}
