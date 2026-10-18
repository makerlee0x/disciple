"use client";
/**
 * Coin page claim pills (floating, outside the HUD):
 *  - creator: "Your fees: X · Claim" when the viewer is this rocket's creator (v3 live)
 *  - crew (REDEPLOY, PVE only): "Crew rewards: X · Claim" + "Crew earned X from this DUMP" feed from ProfitTaxCharged
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { coinFacts } from "@/lib/protocol-viem";
import { creatorClaimable, creatorClaimCalls, isCreatorOf, sendCreatorClaims } from "@/lib/claims/creatorFees";
import { claimCrew, coinMode, crewFeed, crewPending, isPve, type CrewFeedRow } from "@/lib/claims/crew";
import { assetMeta, claimErrorText, fmtAmount, type Asset } from "@/lib/claims/common";
import { demoFeed, demoRedeploy } from "@/lib/claims/demo";
import { ConfirmSheet, TxLink, pc, useCaps, useWalletAddr } from "./ui";

const ADDR = /^0x[0-9a-fA-F]{40}$/;

export default function CoinClaims({ token }: { token: string }) {
  const me = useWalletAddr();
  const { caps, ready, demo } = useCaps();
  const [quote, setQuote] = useState<Asset | null>(null);
  const [mine, setMine] = useState<bigint | null>(null);
  const [crew, setCrew] = useState<bigint | null>(null);
  const [feed, setFeed] = useState<CrewFeedRow[]>([]);
  const [sheet, setSheet] = useState<"creator" | "crew" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Hex | null>(null);
  const valid = ADDR.test(token);

  const load = useCallback(async () => {
    if (!valid) return;
    const t = token as Address;
    if (demo) {
      const { demoRockets } = await import("@/lib/claims/demo");
      const r = demoRockets(demoRedeploy())[0];
      setQuote(r.quote); setMine(r.claimable);
      if (caps.crew) { setCrew(BigInt("640250000000000000000")); setFeed(demoFeed()); }
      return;
    }
    if (!ready) return;
    const c = pc();
    try {
      const f = await coinFacts(c, t);
      const q = await assetMeta(c, f.quote as Address);
      setQuote(q);
      if (me && caps.creatorFees && (await isCreatorOf(c, t, me))) setMine(await creatorClaimable(c, t, me));
      else setMine(null);
      if (caps.crew && isPve(await coinMode(c, t))) {
        if (me) setCrew((await crewPending(c, t, me))?.pending ?? null);
        setFeed(await crewFeed(c, t, 5));
      }
    } catch { /* coin not on this deployment */ }
  }, [token, valid, me, ready, demo, caps]);
  useEffect(() => { void load(); const id = setInterval(() => void load(), 30_000); return () => clearInterval(id); }, [load]);

  const confirm = async () => {
    setBusy(true); setErr(null);
    try {
      if (demo) { await new Promise((r) => setTimeout(r, 500)); setDone(`0x${"ef".repeat(32)}` as Hex); return; }
      if (sheet === "creator" && mine != null) setDone((await sendCreatorClaims(creatorClaimCalls([{ token: token as Address, claimable: mine, tokenSide: null }], caps))).txHash);
      if (sheet === "crew") setDone((await claimCrew([token as Address])).txHash);
      void load();
    } catch (e) { setErr(claimErrorText(e)); } finally { setBusy(false); }
  };

  if (!quote || (mine == null && crew == null && !feed.length)) return null;
  return (
    <>
      <div className="cl-coin" data-testid="coin-claims">
        {mine != null && (
          <div className="cl-coin-pill creator" data-testid="creator-badge">
            <span className="cl-dot" aria-hidden="true" />
            <span className="lbl">Your fees</span>
            <strong>{fmtAmount(mine, quote, 2)}</strong>
            {mine > BigInt(0) ? <button type="button" onClick={() => { setErr(null); setDone(null); setSheet("creator"); }}>Claim</button> : <Link href="/creator">Dashboard</Link>}
          </div>
        )}
        {crew != null && (
          <div className="cl-coin-pill crew" data-testid="crew-pill">
            <span className="lbl">Crew rewards</span>
            <strong>{fmtAmount(crew, quote, 2)}</strong>
            {crew > BigInt(0) && <button type="button" onClick={() => { setErr(null); setDone(null); setSheet("crew"); }}>Claim</button>}
          </div>
        )}
        {feed.slice(0, 3).map((r) => (
          <div key={r.tx + r.seller} className="cl-coin-feed" data-testid="crew-feed">
            Crew earned <strong>{fmtAmount(r.tax, quote, 2)}</strong> from this DUMP <TxLink hash={r.tx}>↗</TxLink>
          </div>
        ))}
      </div>
      {sheet && (
        <ConfirmSheet title={sheet === "creator" ? "Claim creator fees" : "Claim crew rewards"}
          lines={[{ label: sheet === "creator" ? "Creator fees" : "Crew rewards", raw: (sheet === "creator" ? mine : crew) ?? BigInt(0), asset: quote }]}
          to={me} busy={busy} error={err} done={done} onConfirm={confirm} onClose={() => setSheet(null)} />
      )}
    </>
  );
}

