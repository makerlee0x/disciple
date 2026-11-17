"use client";
/**
 * /mint (maker 2026-11-17): finish the Disciples drop on our own Candy Machine (same verified collection as the first 175).
 * Art, minted count, price, 7 per wallet, one Mint button. Solana wallet via Wallet Standard; Umi is loaded only here.
 * Web only: the iPhone app can't sell NFTs outside Apple's in-app purchase.
 * Copy rule (CLAUDE.md): money facts only (price + network fee); no explainer lines.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import type { WalletAccount } from "@wallet-standard/base";
import type { Umi } from "@metaplex-foundation/umi";
import { fetchMintStatus, short, type MintStatus } from "@/lib/nft/client";
import { DISCIPLE_SUPPLY, IMAGE_BASE, MINT_LIMIT, MINT_PRICE_SOL } from "@/lib/nft/config";
import { solConnect, type SolWallet, type EvmWallet } from "@/lib/nft/wallets";
import { isNativeApp } from "@/lib/native";
import WalletChooser from "./WalletChooser";

const ART = [0, 181, 412, 600, 776, 333].map((i) => `${IMAGE_BASE}${i}`);
type Done = { mint: string; sig: string };

function errLine(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/reject|denied|cancel/i.test(m)) return "Cancelled in your wallet.";
  if (/insufficient|0x1\b|Attempt to debit/i.test(m)) return "Not enough SOL.";
  if (/MintLimit|0x1792|limit/i.test(m)) return `You've minted ${MINT_LIMIT}. That's the limit per wallet.`;
  if (/CandyMachineEmpty|NotEnoughItems|sold out/i.test(m)) return "Sold out.";
  if (/Timed out/i.test(m)) return m;
  return "Mint failed. Nothing was charged unless your wallet shows it.";
}

export default function MintView() {
  const [web, setWeb] = useState<boolean | null>(null);
  useEffect(() => setWeb(!isNativeApp()), []);
  const [st, setSt] = useState<MintStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const read = () => void fetchMintStatus().then((s) => { if (alive && s) setSt(s); });
    read();
    const t = setInterval(read, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const [art, setArt] = useState(0);
  useEffect(() => { const t = setInterval(() => setArt((i) => (i + 1) % ART.length), 2600); return () => clearInterval(t); }, []);

  const [choose, setChoose] = useState(false);
  const [w, setW] = useState<{ sw: SolWallet; acc: WalletAccount } | null>(null);
  const [umi, setUmi] = useState<Umi | null>(null);
  const [mine, setMine] = useState<number | null>(null);
  const [bal, setBal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<Done[]>([]);

  const cm = st?.candyMachine ?? null;
  const minted = st?.minted ?? null;
  const soldOut = minted !== null && minted >= DISCIPLE_SUPPLY;
  const pct = minted !== null ? Math.min(100, (minted / DISCIPLE_SUPPLY) * 100) : 0;

  // wallet's own count (7 per wallet) and SOL balance, after connecting and after each mint
  useEffect(() => {
    if (!umi || !w || !cm) return;
    let alive = true;
    void import("@/lib/nft/candy").then(async ({ mintedBy }) => {
      const [n, b] = await Promise.all([mintedBy(umi, cm, w.acc.address).catch(() => null), umi.rpc.getBalance(umi.identity.publicKey).then((x) => Number(x.basisPoints) / 1e9).catch(() => null)]);
      if (alive) { setMine(n); setBal(b); }
    });
    return () => { alive = false; };
  }, [umi, w, cm, done.length]);

  async function connect(sw: SolWallet | EvmWallet) {
    if (sw.kind !== "sol") return;
    setErr(""); setBusy(true);
    try {
      const acc = await solConnect(sw);
      const { makeUmi } = await import("@/lib/nft/umi");
      setW({ sw, acc }); setUmi(makeUmi(sw, acc)); setChoose(false);
    } catch (e) { setErr(e instanceof Error && e.message ? e.message : "Couldn't connect."); }
    setBusy(false);
  }
  async function mint() {
    if (!umi || !cm) return;
    setErr(""); setBusy(true);
    try {
      const { mintOne } = await import("@/lib/nft/candy");
      const r = await mintOne(umi, cm, st?.lut ?? null);
      setDone((d) => [r, ...d]);
    } catch (e) { console.warn("[disciple] mint failed", e); setErr(errLine(e)); }
    setBusy(false);
  }

  const atLimit = mine !== null && mine >= MINT_LIMIT;
  const poor = bal !== null && bal < MINT_PRICE_SOL + 0.03;
  const action = (() => {
    if (soldOut) return <span className="dsc3-btn nft-off" aria-disabled>Sold out</span>;
    if (!cm) return <span className="dsc3-btn nft-off" aria-disabled>Not live yet</span>;
    if (!w) return <button type="button" className="dsc3-btn dsc3-btn-primary dsc3-btn-lg" onClick={() => setChoose(true)} disabled={busy} data-testid="mint-connect">Connect wallet</button>;
    if (atLimit) return <span className="dsc3-btn nft-off" aria-disabled>{MINT_LIMIT} / {MINT_LIMIT} minted</span>;
    return <button type="button" className="dsc3-btn dsc3-btn-primary dsc3-btn-lg" onClick={() => void mint()} disabled={busy || poor} data-testid="mint-btn">{busy ? "Minting…" : "Mint"}</button>;
  })();

  if (web === false) return <section className="mk-app"><b>Mint&apos;s on the web</b><p>disciple.vip/mint</p></section>;

  return (
    <div className="nft-mint" data-testid="mint-page">
      <div className="nft-mint-art dsc3-panel">
        {ART.map((u, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={u} src={u} alt="" className={i === art ? "on" : ""} fetchPriority={i === 0 ? "high" : "low"} />
        ))}
      </div>
      <div className="nft-mint-side">
        <h1>Disciples</h1>
        <div className="nft-mint-chips">
          <span className="nft-chip">Solana</span>
          <span className="nft-chip">{DISCIPLE_SUPPLY} supply</span>
          <span className="nft-chip">{MINT_LIMIT} per wallet</span>
        </div>
        <div className="nft-mint-count" aria-live="polite">
          <b>{minted !== null ? minted : "…"}</b><span>/ {DISCIPLE_SUPPLY}</span>
          <div className="nft-bar" role="progressbar" aria-label="Minted" aria-valuemin={0} aria-valuemax={DISCIPLE_SUPPLY} aria-valuenow={minted ?? 0}><i style={{ width: `${pct}%` }} /></div>
        </div>
        <div className="nft-mint-price"><b>{MINT_PRICE_SOL} SOL</b><span>+ network fee</span></div>

        {action}
        {choose && !w && <WalletChooser chain="sol" busy={busy} onPick={(x) => void connect(x)} />}
        {w && (
          <div className="nft-mint-wallet">
            <span>{short(w.acc.address)}</span>
            {mine !== null && <span>{mine} / {MINT_LIMIT}</span>}
            {bal !== null && <span>{bal.toFixed(3)} SOL</span>}
          </div>
        )}
        {poor && !atLimit && !soldOut && cm && <p className="p5-err" role="alert">Not enough SOL.</p>}
        {err && <p className="p5-err" role="alert">{err}</p>}

        {done.length > 0 && (
          <ul className="nft-done" aria-label="Minted">
            {done.map((d) => (
              <li key={d.mint}>
                <b>Minted</b>
                <a href={`https://solscan.io/token/${d.mint}`} target="_blank" rel="noopener noreferrer">{short(d.mint)} ↗</a>
                <Link href="/profile">Set as picture</Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
