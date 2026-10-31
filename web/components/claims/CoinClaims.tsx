"use client";
/**
 * Coin page claim pills (floating, outside the HUD):
 *  - (no creator fee pill here: it covered the top bar right after launch; creators claim on /creator + profile, in $)
 *  - crew (PVE only): "Crew rewards: X · Claim" (BondingCurve.pendingRewards → Launchpad.claim) + "Crew earned X from
 *    this DUMP" feed from ProfitTaxCharged
 */
import { useCallback, useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { coinFacts } from "@/lib/protocol-viem";
import { claimCrew, coinMode, crewClaimCall, crewFeed, crewPending, isPve, type CrewFeedRow } from "@/lib/claims/crew";
import { assetMeta, claimErrorText, fmtAmount, preflight, type Asset } from "@/lib/claims/common";
import { demoFeed, demoRedeploy } from "@/lib/claims/demo";
import { ConfirmSheet, TxLink, pc, useCaps, useWalletAddr } from "./ui";

const ADDR = /^0x[0-9a-fA-F]{40}$/;

export default function CoinClaims({ token }: { token: string }) {
  const me = useWalletAddr();
  const { caps, ready, demo } = useCaps();
  const [quote, setQuote] = useState<Asset | null>(null);
  const [crew, setCrew] = useState<bigint | null>(null);
  const [feed, setFeed] = useState<CrewFeedRow[]>([]);
  const [sheet, setSheet] = useState<"crew" | null>(null);
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
      setQuote(r.quote);
      if (caps.crew) { setCrew(BigInt("640250000000000000000")); setFeed(demoFeed()); }
      return;
    }
    if (!ready) return;
    const c = pc();
    try {
      const f = await coinFacts(c, t);
      const q = await assetMeta(c, f.quote as Address);
      setQuote(q);
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
      if (sheet === "crew") { if (me) await preflight(pc(), [crewClaimCall(token as Address)], me); setDone((await claimCrew([token as Address])).txHash); }
      void load();
    } catch (e) { setErr(claimErrorText(e)); } finally { setBusy(false); }
  };

  if (!valid) return null;
  const claims = !!quote && (crew != null || feed.length > 0);
  return (
    <>
      <div className="cl-coin" data-testid="coin-claims">
        {/* Coin page cleanup (lee, Oct 30): no "Floor support · Bins" pill on the coin page */}
        {/* Fix batch (lee, Oct 31): no creator "Your fees · Claim" pill on the coin screen (it covered the top bar right after launch) */}
        {claims && quote && crew != null && (
          <div className="cl-coin-pill crew" data-testid="crew-pill">
            <span className="lbl">Crew rewards</span>
            <strong>{fmtAmount(crew, quote, 2)}</strong>
            {crew > BigInt(0) && <button type="button" onClick={() => { setErr(null); setDone(null); setSheet("crew"); }}>Claim</button>}
          </div>
        )}
        {claims && quote && feed.slice(0, 3).map((r) => (
          <div key={r.tx + r.seller} className="cl-coin-feed" data-testid="crew-feed">
            Crew earned <strong>{fmtAmount(r.tax, quote, 2)}</strong> from this DUMP <TxLink hash={r.tx}>↗</TxLink>
          </div>
        ))}
      </div>
      {sheet && quote && (
        <ConfirmSheet title="Claim crew rewards"
          lines={[{ label: "Crew rewards", raw: crew ?? BigInt(0), asset: quote }]}
          to={me} busy={busy} error={err} done={done} onConfirm={confirm} onClose={() => setSheet(null)} />
      )}
    </>
  );
}

