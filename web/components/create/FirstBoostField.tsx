"use client";

import { useEffect, useMemo, useState } from "react";
import { deployment, isDeployed } from "@/lib/chains";
import { TOTAL_SUPPLY_WEI as SUPPLY_WEI, launchBuyTokensOut, paramsFromQuotePrice } from "@/lib/curveMath";
import {
  FIRST_BOOST_COPY as COPY, bpsToPct, fmtAmount, fmtUsdWad, modeName, parseAmount, quoteRawToUsdWad, readFirstBoostLimits, readQuoteBalance, toInputString, usdToQuoteRaw,
  type FirstBoostLimits,
} from "@/lib/firstBoost";
import { DEFAULT_LAUNCH_MODE, LaunchMode, modesActive, readPveLoginVerified } from "@/lib/launchAbi";
import type { Address } from "@/lib/protocol";
import { launchUsdg, publicClient, quoteUsdgPairSwap, readCreatorBuyQuote } from "@/lib/protocol-viem";
import { usdgDecimals, usdgRawToUsd } from "@/lib/usdg";
import { onWallet } from "@/lib/wallet";

/** raw = pair-coin amount (legacy path); usdgIn = USDG the player pays (launchWithUsdg), null on the legacy path. */
export type FirstBoostState = { raw: bigint; usdgIn: bigint | null; error: string | null; ready: boolean };

const pctOfSupply = (tokens: bigint) => `${(Number((tokens * BigInt(1000000)) / SUPPLY_WEI) / 10000).toLocaleString(undefined, { maximumFractionDigits: 3 })}%`;

/**
 * First BOOST input for /create: the creator's optional buy in the launch tx (LaunchParams.creatorBuyQuoteIn),
 * denominated in the pair (quote) token. Cap = Launchpad.creatorBuyMaxBps() read live; estimate =
 * Launchpad.quoteCreatorBuy (local curve math shows instantly while the view loads). On the modes (v4) ABI the
 * launch mode sets the cap (Launchpad.firstBoostMaxBps: Easy 1.2%, Hard 3.33%, Trench creatorBuyMaxBps; lib/modeRules),
 * and a PVE First BOOST needs a login-verified wallet (note + check).
 * Paid in USDG (lee 2026-10-26): the player enters dollars, pays from their USDG cash, and DiscipleRouter.launchWithUsdg
 * swaps it into the pair coin in the same tx. Balance, max and errors are all in dollars; the pair coin is never asked for.
 * The legacy pair-token pull only runs on a network whose router has no USDG routing. Private launches: no First BOOST
 * (AnonLauncher pulls the pair coin; a USDG swap in the same op needs a gas-policy change, FLOW).
 */
export default function FirstBoostField({ pair, pairLabel, creatorTaxBps, ticker, value, onChange, onState, mode = DEFAULT_LAUNCH_MODE, privateLaunch = false }: {
  pair: Address | null; pairLabel: string; creatorTaxBps: number; ticker: string;
  value: string; onChange: (v: string) => void; onState: (s: FirstBoostState) => void; mode?: number; privateLaunch?: boolean;
}) {
  // USDG router (launchWithUsdg) on this network? undefined = still checking, null = legacy pair-token path.
  const [usdg, setUsdg] = useState<Address | null | undefined>(undefined);
  const [pairOut, setPairOut] = useState<{ usdgIn: bigint; raw: bigint } | null>(null);
  const [maxUsdg, setMaxUsdg] = useState<bigint | null>(null);
  const [limits, setLimits] = useState<FirstBoostLimits | null>(null);
  const [limitsErr, setLimitsErr] = useState(false);
  const [me, setMe] = useState<Address | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [viewOut, setViewOut] = useState<{ raw: bigint; tokens: bigint; exceedsCap: boolean } | null>(null);
  const [pveVerified, setPveVerified] = useState<boolean | null>(null);
  const deployed = isDeployed();
  const pve = modesActive() && mode === LaunchMode.PVE;

  useEffect(() => onWallet((a) => setMe(a)), []);
  useEffect(() => { let alive = true; launchUsdg(publicClient()).then((u) => { if (alive) setUsdg(u); }).catch(() => { if (alive) setUsdg(null); }); return () => { alive = false; }; }, []);

  useEffect(() => {
    if (!deployed || !pair) { setLimits(null); return; }
    let alive = true;
    setLimits(null); setLimitsErr(false);
    readFirstBoostLimits(publicClient(), pair, creatorTaxBps, mode)
      .then((l) => { if (alive) setLimits(l); })
      .catch(() => { if (alive) setLimitsErr(true); });
    return () => { alive = false; };
  }, [deployed, pair, creatorTaxBps, mode]);

  // PVE: the launch buy reverts NotVerified without a live (global) LoginGate attestation for this wallet.
  useEffect(() => {
    if (!deployed || !pve || !me) { setPveVerified(null); return; }
    let alive = true;
    readPveLoginVerified(publicClient(), deployment().launchpad, me)
      .then((v) => { if (alive) setPveVerified(v.verified); })
      .catch(() => { if (alive) setPveVerified(null); });
    return () => { alive = false; };
  }, [deployed, pve, me]);

  useEffect(() => {
    if (!limits || !me || usdg === undefined) { setBalance(null); return; }
    let alive = true;
    // USDG path: the balance that pays is the player's USDG cash (dollars), not the pair coin.
    readQuoteBalance(publicClient(), usdg ?? limits.quote, me).then((b) => { if (alive) setBalance(b); }).catch(() => { if (alive) setBalance(null); });
    return () => { alive = false; };
  }, [limits, me, usdg]);

  // USDG path: the max in dollars = the USDG the pair-coin max swaps back to, minus 1% for the swap fee both ways.
  useEffect(() => {
    if (!limits || !usdg) { setMaxUsdg(null); return; }
    let alive = true;
    quoteUsdgPairSwap(publicClient(), limits.quote, false, limits.maxQuoteIn)
      .then((u) => { if (alive) setMaxUsdg((u * BigInt(99)) / BigInt(100)); })
      .catch(() => { if (alive) setMaxUsdg(null); });
    return () => { alive = false; };
  }, [limits, usdg]);

  // 1b: the input is a $ amount; the pair-token amount the Launchpad pulls is derived from the live pair price
  const usdWad = privateLaunch ? BigInt(0) : parseAmount(value, 18);
  const usdgIn = usdg && usdWad != null ? parseAmount(value, usdgDecimals()) : null;   // dollars → USDG raw ($1 = 1 USDG)
  // pair coin the router would buy: the live USDG → pair swap quote when fresh, else the launch-price estimate
  const estRaw = usdWad == null ? null : usdWad === BigInt(0) ? BigInt(0) : limits ? usdToQuoteRaw(usdWad, limits.quotePriceUsd) ?? BigInt(0) : BigInt(0);
  const raw = usdg && usdgIn != null && pairOut && pairOut.usdgIn === usdgIn ? pairOut.raw : estRaw;
  const usd = (r: bigint) => (limits ? fmtUsdWad(quoteRawToUsdWad(r, limits.quotePriceUsd)) : "…");
  const cash = (r: bigint) => `$${usdgRawToUsd(r).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // USDG path: swap quote (debounced) so the estimate and the cap check include the swap.
  useEffect(() => {
    if (!limits || !usdg || usdgIn == null || usdgIn <= BigInt(0)) { setPairOut(null); return; }
    let alive = true;
    const t = setTimeout(() => {
      quoteUsdgPairSwap(publicClient(), limits.quote, true, usdgIn)
        .then((r) => { if (alive) setPairOut({ usdgIn, raw: r }); })
        .catch(() => { /* keep the estimate */ });
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [limits, usdg, usdgIn]);
  const localTokens = useMemo(() => {
    if (!limits || !raw || raw <= BigInt(0) || limits.quotePriceUsd <= BigInt(0)) return null;
    return launchBuyTokensOut(paramsFromQuotePrice(limits.quotePriceUsd), raw, BigInt(creatorTaxBps));
  }, [limits, raw, creatorTaxBps]);

  // Authoritative estimate from Launchpad.quoteCreatorBuy (debounced).
  useEffect(() => {
    if (!limits || !raw || raw <= BigInt(0)) { setViewOut(null); return; }
    let alive = true;
    const t = setTimeout(() => {
      readCreatorBuyQuote(publicClient(), limits.quote, raw, creatorTaxBps, limits.mode)
        .then((q) => { if (alive) setViewOut({ raw, tokens: q.tokensOut, exceedsCap: q.exceedsCap }); })
        .catch(() => { /* keep local estimate */ });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [limits, raw, creatorTaxBps]);

  const pct = limits ? bpsToPct(limits.capBps) : null;
  const symbol = limits?.symbol || pairLabel || "pair token";
  const fresh = viewOut && raw != null && viewOut.raw === raw ? viewOut : null;
  const tokens = fresh ? fresh.tokens : localTokens;
  // exceedsCap only knows creatorBuyMaxBps; the mode clamp (capTokens) is checked here too.
  const overCap = !!limits && raw != null && raw > BigInt(0) && (fresh ? fresh.exceedsCap || fresh.tokens > limits.capTokens : raw > limits.maxQuoteIn);
  const maxStr = limits ? (usdg ? (maxUsdg != null ? cash(maxUsdg) : "…") : usd(limits.maxQuoteIn)) : "";
  const spend = usdg ? usdgIn : raw;   // what the player pays from their balance (USDG on the dollar path)

  let error: string | null = null;
  if (raw == null) error = COPY.invalid;
  else if (raw > BigInt(0) && limits) {
    if (overCap) error = COPY.overCap(pct!, maxStr);
    else if (usdg && balance != null && spend != null && spend > balance) error = COPY.cash(cash(balance));
    else if (!usdg && balance != null && raw > balance) error = COPY.balance(usd(balance), symbol);
  } else if (raw > BigInt(0) && limitsErr) error = COPY.unavailable;
  const ready = usdWad === BigInt(0) || (!!limits && raw != null && raw > BigInt(0) && usdg !== undefined);

  useEffect(() => { onState({ raw: raw ?? BigInt(0), usdgIn: usdg ? usdgIn ?? BigInt(0) : null, error, ready }); }, [raw, usdgIn, usdg, error, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  if (privateLaunch) return (
    <div className="first-boost">
      <label className="first-boost-label" htmlFor="first-boost-input">{COPY.label}</label>
      <p className="first-boost-helper">{COPY.privateOff}</p>
    </div>
  );

  const showEstimate = !error && tokens != null && raw != null && raw > BigInt(0);
  return (
    <div className={`first-boost${error ? " has-error" : ""}`}>
      <label className="first-boost-label" htmlFor="first-boost-input">{COPY.label}</label>
      <p className="first-boost-helper">{COPY.helper(pct ?? "…")}</p>
      <div className="first-boost-row">
        <span className="first-boost-unit" aria-hidden>$</span>
        <input
          id="first-boost-input" inputMode="decimal" autoComplete="off" placeholder="0"
          aria-invalid={!!error} aria-describedby="first-boost-meta"
          value={value} onChange={(e) => onChange(e.target.value.replace(/,/g, "."))}
        />
        <button type="button" className="first-boost-max" disabled={!limits || limits.maxQuoteIn <= BigInt(0) || (!!usdg && !maxUsdg)}
          title="Fills just under the max, in case the price moves before your launch lands"
          onClick={() => limits && onChange(usdg ? (maxUsdg ? toInputString(maxUsdg, usdgDecimals(), 2) : "")
            : toInputString(quoteRawToUsdWad((limits.maxQuoteIn * BigInt(995)) / BigInt(1000), limits.quotePriceUsd), 18, 2))}>MAX</button>
      </div>
      <div id="first-boost-meta" className="first-boost-meta" aria-live="polite">
        {!deployed ? null : limitsErr ? <span>{COPY.unavailable}</span> : !limits ? <span>{COPY.loading}</span> : (
          <>
            <span>{COPY.max(maxStr, fmtAmount(limits.capTokens, 18), pct!)}</span>
            <span>{balance != null ? (usdg ? COPY.cashBalance(cash(balance)) : `Balance ${usd(balance)}`) : me ? "Balance …" : COPY.connect}</span>
            {raw != null && raw > BigInt(0) && <span data-testid="first-boost-pays">{usdg ? COPY.paysCash : COPY.pays(fmtAmount(raw, limits.decimals), symbol)}</span>}
          </>
        )}
      </div>
      {showEstimate && (
        <p className="first-boost-estimate">
          <span>You receive</span> <strong>{COPY.estimate(fmtAmount(tokens!, 18, 2), ticker || "TICKER", pctOfSupply(tokens!))}</strong>
          <span className="first-boost-note">{fresh ? "Launchpad quote" : "estimate"}{usdg ? " · swap included" : ""} · anti-snipe exempt · 1% fee{creatorTaxBps ? ` + ${creatorTaxBps / 100}% creator tax` : ""}</span>
        </p>
      )}
      {limits?.capBy === "mode" && <p className="first-boost-note first-boost-mode">{COPY.modeCap(modeName(limits.mode), pct!)}</p>}
      {pve && raw != null && raw > BigInt(0) && <p className="first-boost-note first-boost-mode">{COPY.easyLock}</p>}
      {pve && raw != null && raw > BigInt(0) && (
        <p className="first-boost-note first-boost-mode">{!me ? COPY.pveLoginUnknown : pveVerified === false ? COPY.pveLoginAttest : COPY.pveLogin}</p>
      )}
      {error && <p role="alert" className="first-boost-error">{error}</p>}
    </div>
  );
}
