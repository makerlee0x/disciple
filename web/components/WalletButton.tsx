"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { usePathname } from "next/navigation";
import { formatUnits, parseAbi } from "viem";
import { ACTIVE_CHAIN, MINTABLE_TEST_TOKENS, deployment, isDeployed } from "@/lib/chains";

/** Robinhood Chain testnet: a plain "Test network" tag sits first in the wallet strip there (GAME play-test, Oct 26 2026). */
const TEST_NETWORK_ID = 46630;
import { decimalsOf, publicClient, readCurveState, usdgRouteFor } from "@/lib/protocol-viem";
import { cashLine, type BalancePart } from "@/lib/balanceLine";
import { payUsdg, routerUsdg } from "@/lib/trade/usdgRouter";
import {
  aaAvailable, connectLocal, connectPrivy, connectSmartWithWallet, connectWallet, disconnect,
  hasWallet, isSmartMode, onWallet, restoreSmart,
} from "@/lib/wallet";
import {
  DEV_WALLETS, SIGNER_MODE, aaSession,
  legacyBalances, onSessionChange, sweepLegacy, restartOneTap,
} from "@/lib/aa/session";
import { bookedPortfolio, loadPortfolio, type Portfolio } from "@/lib/portfolio";
import { WALLET_CTA_CLICK_EVENT, WALLET_CTA_EVENT } from "@/lib/walletCta";
import { COIN_DECIMALS, knownDecimals, usdgDecimals } from "@/lib/usdg";
import { BOOKED_EVENT, blockOf, bookFill, fillBook, readAtOrAfter, txBlock, type FillReceiptDetail } from "@/lib/fillBook";
import { pct } from "@/lib/aa/slippage";
import type { Address } from "@/lib/protocol";
import Icon from "@/components/icons/Icon";
import { playerError } from "@/lib/playerError";
import { chipLabel, clearNameCache, lookupFirstName } from "@/lib/nameLookup";
import { GuildTagFor } from "@/components/guilds/GuildChip";
import { PROFILE_CHANGED_EVENT } from "@/lib/profile";
import { DEPOSIT_HREF, SETTINGS_HREF, onDepositClick, onSettingsClick } from "@/lib/cashLink";
import { CASH_ARRIVED_EVENT } from "@/lib/testCash";

/** $1,234.56 (cash / portfolio cards). */
const usd2 = (n: number) => `$${(Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedUsd = (n: number) => `${n > 0.005 ? "+" : n < -0.005 ? "-" : ""}${usd2(Math.abs(n))}`;
const GREEN = "#8ff0c0", RED = "#ff9fb8";
/** Where "Deposit more" goes: the existing deposit / withdraw flow (private profile → Settings → Cash panel; lib/cashLink). */

const symAbi = parseAbi(["function symbol() view returns (string)"]);
const balAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const coinMeta = new Map<string, Promise<{ symbol: string; quote: Address } | null>>();
/** Symbol + pair (quote) token of a DISCIPLE coin, cached per page load. */
function metaOf(coin: Address) {
  const k = coin.toLowerCase();
  if (!coinMeta.has(k)) coinMeta.set(k, (async () => { const pc = publicClient(); const [symbol, st] = await Promise.all([pc.readContract({ address: coin, abi: symAbi, functionName: "symbol" }), readCurveState(pc, coin)]); return { symbol, quote: st.quote as Address }; })().catch(() => null));
  return coinMeta.get(k)!;
}

/**
 * Sign in once (Privy: email / Google / X / external wallet) → Privy embedded EOA owns an Alchemy MAv2 smart account (self-pay gas,
 * drip-funded on testnet) → "Enable one-tap" installs an on-chain session key → trades are one tap.
 * Dev options: an existing wallet as owner (one signature).
 * Legacy "plain wallet" path kept as fallback (one tx per action).
 */
export default function WalletButton({ compact = false }: { compact?: boolean } = {}) {
  const [addr, setAddr] = useState<Address | null>(null);
  const [busy, setBusy] = useState("");
  const [, setEth] = useState<bigint | null>(null);
  const [cashText, setCashText] = useState("");
  const path = usePathname() || "";
  const coin = (/^\/coin\/(0x[0-9a-fA-F]{40})/.exec(path)?.[1] ?? null) as Address | null;
  const [err, setErr] = useState("");
  const [menu, setMenu] = useState(false);
  const [, bump] = useState(0);
  const [copied, setCopied] = useState(false);
  const [acct, setAcct] = useState(false);
  const [pf, setPf] = useState<Portfolio | null>(null);
  useEffect(() => onWallet(setAddr), []);
  useEffect(() => { restoreSmart().catch(() => {}); }, []);
  useEffect(() => onSessionChange(() => bump((n) => n + 1)), []);
  // TEMP (testnet): old LightAccount of the same owner still holding funds ⇒ offer a one-click sweep. Remove after migration.
  const [legacy, setLegacy] = useState<Awaited<ReturnType<typeof legacyBalances>>>(null);
  useEffect(() => { if (!addr) { setLegacy(null); return; } legacyBalances().then(setLegacy).catch(() => setLegacy(null)); }, [addr]);
  const [slipCap, setSlipCap] = useState<{ maxBps: number; suggestBps: number } | null>(null);
  useEffect(() => {
    const f = (e: Event) => setSlipCap((e as CustomEvent<{ maxBps: number; suggestBps: number }>).detail);
    addEventListener("disciple:slippagecap", f);
    return () => removeEventListener("disciple:slippagecap", f);
  }, []);

  // SITE #137: the last balance reads (value + the block they were taken at). After our own fill the header is booked
  // from the fill's receipt (lib/fillBook) and re-derived from these WITHOUT a new RPC read; the follow-up read is
  // pinned at/after the receipt's block, so a lagging public-RPC node can't put the pre-fill balance back.
  const lastRead = useRef<{ parts: (BalancePart & { address: Address })[]; usdgPays: boolean; pf: Portfolio | null } | null>(null);
  const fillPx = useRef(new Map<string, number>());   // coin → $/token of our last fill (prices a first buy the indexer doesn't list yet)
  function show(a: Address) {
    const r = lastRead.current;
    if (!r) return;
    const parts = r.parts.map(({ address, ...p }) => ({ ...p, amount: fillBook.display(a, address) ?? p.amount }));
    setCashText(cashLine(parts));
    if (r.pf) setPf(bookedPortfolio(r.pf, a, deployment().usdg, fillPx.current));
  }

  async function refresh(a: Address) {
    const pc = publicClient(), startedAt = Date.now();
    try {
      const meta = coin ? await metaOf(coin) : null;
      // USDG pays only once the router supports it (#65); until then trades still spend the coin's quote
      const usdgPays = coin ? !!(await usdgRouteFor(pc, coin).catch(() => null)) : payUsdg() && !!(await routerUsdg(pc, deployment().router));
      // Users never need ETH (network fees are topped up for them): no ETH in the balance line
      const syms = MINTABLE_TEST_TOKENS.length ? MINTABLE_TEST_TOKENS : [{ symbol: "STRATEGY", address: deployment().defaultQuote }];
      const list: { symbol: string; address: Address; role: BalancePart["role"] }[] = syms.map((t) => ({ symbol: t.symbol, address: t.address, role: (usdgPays ? t.address.toLowerCase() === deployment().usdg.toLowerCase() : !!meta && t.address.toLowerCase() === meta.quote.toLowerCase()) ? "spend" : "other" }));
      if (meta) list.unshift({ symbol: meta.symbol, address: coin!, role: "held" });
      // USDG is shown as dollar "cash" in its own card (never as "USDG" in the header); keep it out of the token line
      // …except on a USDG-paired coin: USDG is that coin's quote, so the chip shows it (in dollars) as what pays
      const usdgQuote = !!meta && meta.quote.toLowerCase() === deployment().usdg.toLowerCase();
      if (usdgPays && !usdgQuote) for (let i = list.length - 1; i >= 0; i--) if (list[i].address.toLowerCase() === deployment().usdg.toLowerCase()) list.splice(i, 1);
      const extra = [...new Set([...(coin ? [coin] : []), ...fillBook.pendingTokens(a).filter((t) => t !== deployment().usdg.toLowerCase())])] as Address[];
      // one block for everything: ≥ our last receipt's block (fillBook.floor); a node that's behind errors ⇒ brief retry
      const { value, block } = await readAtOrAfter(pc, fillBook.floor(a), async (blockNumber) => {
        const [e, raws, pf]: [bigint, (BalancePart & { address: Address })[], Portfolio | null] = await Promise.all([
          pc.getBalance({ address: a, blockNumber }),
          Promise.all(list.map(async (t) => {
            const [b, d] = await Promise.all([pc.readContract({ address: t.address, abi: balAbi, functionName: "balanceOf", args: [a], blockNumber }), decimalsOf(pc, t.address)]);
            return { ...t, amount: Number(formatUnits(b, d)) };
          })),
          loadPortfolio(pc, a, extra, { blockNumber }),
        ]);
        return { e, raws, pf };
      });
      setEth(value.e);
      // every read goes through the book: it retires fills it includes and never replaces a newer-block read
      for (const t of value.raws) fillBook.observe(a, t.address, t.amount, block, startedAt);
      if (value.pf) {
        fillBook.observe(a, deployment().usdg, value.pf.cashUsd, block, startedAt);
        const held = new Set(value.pf.holdings.map((h) => h.coin.toLowerCase()));
        for (const h of value.pf.holdings) fillBook.observe(a, h.coin, h.tokens, block, startedAt);
        for (const c of extra) if (!held.has(c.toLowerCase())) fillBook.observe(a, c, 0, block, startedAt);   // read at ≥ block: really 0
      }
      lastRead.current = { parts: value.raws, usdgPays, pf: value.pf ?? lastRead.current?.pf ?? null };
      show(a);
    } catch { /* ignore: keep the last (booked) values */ }
  }
  useEffect(() => { if (!addr) return; refresh(addr); const i = setInterval(() => refresh(addr), 15000); const t = () => setTimeout(() => refresh(addr), 1500);
    // SITE #137: our relay's receipt block ('disciple:op' confirmed) ⇒ later reads are pinned at/after it
    const op = (e: Event) => { const d = (e as CustomEvent<{ phase?: string; blockNumber?: string }>).detail; const b = blockOf(d?.blockNumber); if (d?.phase === "confirmed" && b !== undefined) fillBook.raiseFloor(addr, b); };
    // the fill decoded from the receipt logs: book it and show it now (no RPC), then one read pinned at/after its block
    const r = (e: Event) => {
      const d = (e as CustomEvent<FillReceiptDetail>).detail;
      const fc = d?.token || coin;
      if (fc && d?.tokens && d.usd && d.tokens > 0) fillPx.current.set(fc.toLowerCase(), d.usd / d.tokens);
      const booked = bookFill(fillBook, d, { holder: addr, coin, usdg: deployment().usdg, usdgDecimals: usdgDecimals(), coinDecimals: COIN_DECIMALS, decimals: (t) => knownDecimals(t), block: txBlock(d?.txHash) });
      if (booked.length) { show(addr); dispatchEvent(new CustomEvent(BOOKED_EVENT, { detail: { holder: addr, tokens: booked, txHash: d?.txHash } })); }
      refresh(addr);
    };
    const cash = () => refresh(addr);   // "Get test cash" landed (lib/testCash)
    addEventListener("disciple:livetrade", t); addEventListener("disciple:fillreceipt", r); addEventListener("disciple:op", op); addEventListener(CASH_ARRIVED_EVENT, cash);
    return () => { clearInterval(i); removeEventListener("disciple:livetrade", t); removeEventListener("disciple:fillreceipt", r); removeEventListener("disciple:op", op); removeEventListener(CASH_ARRIVED_EVENT, cash); }; }, [addr, coin]);   // eslint-disable-line react-hooks/exhaustive-deps

  // live retest #5: the chip shows the claimed @name (the account's, else its owner's), not only the short address
  const [uname, setUname] = useState<string | null>(null);
  const ownerAddr = addr ? aaSession()?.owner : undefined;
  useEffect(() => {
    if (!addr) { setUname(null); return; }
    let alive = true;
    const load = () => { lookupFirstName([addr, ownerAddr]).then((n) => { if (alive) setUname(n); }); };
    const changed = () => { clearNameCache(); load(); };
    load();
    addEventListener(PROFILE_CHANGED_EVENT, changed);
    return () => { alive = false; removeEventListener(PROFILE_CHANGED_EVENT, changed); };
  }, [addr, ownerAddr]);

  const fail = (e: unknown) => setErr(playerError(e).slice(0, 160));
  async function run(label: string, f: () => Promise<unknown>) {
    setErr(""); setBusy(label);
    try { await f(); setMenu(false); } catch (e) { fail(e); } finally { setBusy(""); }
  }

  // Phones (< 740px): the signed-out pill ("Play" / "Sign in") is hidden from the top bar (it pushed GAME's ✕ out of
  // the corner; CSS .ap-wallet-cta in globals.css) and the same action lives in the Sidebar menu. Publish the pill's
  // label for the Sidebar and run the pill's own action when the Sidebar item is tapped.
  const ctaLabel = !isDeployed() || addr ? null : aaAvailable() && SIGNER_MODE === "local" ? "Play" : aaAvailable() ? "Sign in" : "Connect wallet";
  useEffect(() => {
    (window as unknown as { __walletCta?: string | null }).__walletCta = ctaLabel;
    dispatchEvent(new CustomEvent(WALLET_CTA_EVENT, { detail: { label: ctaLabel } }));
  }, [ctaLabel]);
  useEffect(() => () => {
    (window as unknown as { __walletCta?: string | null }).__walletCta = null;
    dispatchEvent(new CustomEvent(WALLET_CTA_EVENT, { detail: { label: null } }));
  }, []);
  const ctaClick = useRef<() => void>(() => {});
  ctaClick.current = () => {
    if (addr || busy) return;
    if (aaAvailable() && SIGNER_MODE === "local") run("creating account", connectLocal);
    else setMenu(true);
  };
  useEffect(() => {
    const f = () => ctaClick.current();
    addEventListener(WALLET_CTA_CLICK_EVENT, f);
    return () => removeEventListener(WALLET_CTA_CLICK_EVENT, f);
  }, []);

  const rootRef = useRef<HTMLDivElement>(null);
  // Close sign-in / account popovers on outside click or Escape (menus are absolute so they
  // must not rely on layout collapse for dismissal).
  useEffect(() => {
    if (!menu && !acct) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setMenu(false);
        setAcct(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(false);
        setAcct(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, acct]);

  if (!isDeployed()) return null;
  const smart = isSmartMode();
  const sess = aaSession();
  const cardStyle: CSSProperties = { display: "flex", flexDirection: "column", justifyContent: "center", gap: 1, padding: compact ? "3px 9px" : "5px 11px",
    borderRadius: 12, background: "rgba(22,24,28,.88)", border: "1px solid rgba(201,206,214,.22)", lineHeight: 1.15 };
  const pill = { all: "unset" as const, cursor: "pointer", padding: "5px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700, letterSpacing: ".04em" };
  // Popover panel: out of flow so [aria-label=wallet] layout height stays the trigger strip
  // (GAME / FlightCanvas measures that bottom edge to stack Share/Exit).
  const popover: CSSProperties = {
    position: "absolute", top: "100%", right: 0, marginTop: 4, zIndex: 70,
    display: "flex", flexDirection: "column", gap: 6, padding: 10, borderRadius: 12,
    background: "rgba(22,24,28,.96)", alignItems: "stretch",
    boxShadow: "0 8px 24px rgba(0,0,0,.45)",
  };
  return (
    <div ref={rootRef} aria-label="wallet" style={{ position: "fixed", top: compact ? 12 : 10, right: 16, maxWidth: "calc(100vw - 32px)", zIndex: 60, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4,
      fontFamily: "ui-monospace,monospace", color: "#E8EAEE" }}>
      <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
        {/* .wb-row: one line on desktop; on phones (≤480px) it wraps right-aligned instead of running off the left edge (GAME 390×844) */}
        <div className="wb-row" style={{ display: "flex", gap: 8, alignItems: "center", whiteSpace: "nowrap" }}>
          {/* coin / game screen cleanup (lee, Oct 30): no "Test network" tag on a coin page */}
          {ACTIVE_CHAIN.id === TEST_NETWORK_ID && !coin && <span className="wb-testnet" role="note">Test network</span>}
          {addr ? (
            <>
              {pf && smart && (
                <div aria-label="cash and portfolio" className="wb-cards" style={{ display: "flex", gap: 6, alignItems: "stretch", minWidth: 0 }}>
                  <div data-testid="cash-card" style={cardStyle} title="Your cash: what BOOST spends and DUMP pays out in.">
                    <span style={{ fontSize: 13, fontWeight: 800, color: "#E8EAEE" }}>{usd2(pf.cashUsd)} <span style={{ fontWeight: 600, opacity: 0.55 }}>cash</span></span>
                    <a href={DEPOSIT_HREF} onClick={onDepositClick} style={{ fontSize: 10, fontWeight: 700, color: "#C9CED6", textDecoration: "none" }}>Deposit more</a>
                  </div>
                  {/* total holdings bubble next to cash (back on lee's request, Oct 30 coin-screen cleanup) */}
                  <a href="/profile" data-testid="portfolio-card" style={{ ...cardStyle, textDecoration: "none", color: "inherit" }}
                    title={`Total = cash ${usd2(pf.cashUsd)} + coins ${usd2(pf.holdingsUsd)} at current prices.\n24h: current holdings priced now vs 24h ago (no stored portfolio history; coins younger than 24h use their launch price).`}>
                    <span style={{ fontSize: 13, fontWeight: 800, color: "#E8EAEE" }}>{usd2(pf.totalUsd)} <span style={{ fontWeight: 600, opacity: 0.55 }}>total</span></span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: pf.change24hUsd > 0.005 ? GREEN : pf.change24hUsd < -0.005 ? RED : "#C9CED6" }}>{signedUsd(pf.change24hUsd)} <span style={{ opacity: 0.6, color: "#C9CED6" }}>24h</span></span>
                  </a>
                </div>
              )}
              <button type="button" title={smart ? `Smart account (owner ${sess?.owner}) — click to copy` : "Wallet"} onClick={() => { if (smart) { setAcct((v) => !v); return; } navigator.clipboard?.writeText(addr); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
                style={{ ...pill, background: "rgba(31,111,74,.9)", color: "#c8ffe4" }}>
                {smart ? <><Icon name="bolt" size={12} style={{ verticalAlign: -1 }} /> </> : ""}{copied ? "copied" : chipLabel(uname, addr)}{!copied && <> <GuildTagFor address={addr} markOnly /></>}
              </button>
              {/* coin page cleanup (lee, Oct 30): no ✕ next to the chip; Sign out lives in the account menu + Sidebar */}
            </>
          ) : (
            aaAvailable() && SIGNER_MODE === "local" ? (
              <button type="button" className="ap-wallet-cta" onClick={() => run("creating account", connectLocal)} disabled={!!busy} style={{ ...pill, background: "#C9CED6", color: "#0B0C0E" }}>
                {busy || <><Icon name="play" size={16} /> Play</>}
              </button>
            ) : (
            <button type="button" className="ap-wallet-cta" onClick={() => setMenu((m) => !m)} disabled={!!busy} style={{ ...pill, background: "#C9CED6", color: "#0B0C0E" }}>
              {busy || (aaAvailable() ? "Sign in" : "Connect wallet")}
            </button>
            )
          )}
        </div>
        {!addr && menu && (
          <div role="menu" style={{ ...popover, minWidth: 240 }}>
            {aaAvailable() ? (
              <>
                <span style={{ fontSize: 10, opacity: 0.8 }}>Sign in once — then every trade is one tap, no popups.</span>
                <button type="button" disabled={!!busy} onClick={() => run("opening login", async () => connectPrivy())} style={{ ...pill, background: "#C9CED6", color: "#0B0C0E", textAlign: "center" }}>Email or Google</button>
                {DEV_WALLETS && <>
                <button type="button" disabled={!!busy || !hasWallet()} onClick={() => run("sign once in wallet", connectSmartWithWallet)} style={{ ...pill, background: "#2E323A", color: "#C9CED6", textAlign: "center" }}>Use my wallet as owner</button>
                <button type="button" disabled={!!busy || !hasWallet()} onClick={() => run("connecting", connectWallet)} style={{ ...pill, fontSize: 10, opacity: 0.7, textAlign: "center" }}>Plain wallet (sign every tx)</button>
                </>}
              </>
            ) : (
              <button type="button" disabled={!!busy} onClick={() => hasWallet() ? run("connecting", connectWallet) : setErr("No browser wallet found. Install MetaMask/Rabby.")} style={{ ...pill, background: "#C9CED6", color: "#0B0C0E", textAlign: "center" }}>Connect wallet</button>
            )}
          </div>
        )}
        {/* account settings (one-tap session, max price move, Advanced, sign out) moved to Profile → Settings
            (components/account/AccountSettings, SITE Oct 30); the chip opens this slim menu */}
        {addr && acct && smart && (
          <div aria-label="account" role="menu" style={{ ...popover, minWidth: 160, fontSize: 11 }}>
            <a role="menuitem" href="/profile" onClick={() => setAcct(false)} style={{ ...pill, background: "rgba(255,255,255,.08)", textAlign: "center" }}>Profile</a>
            <Link role="menuitem" href={SETTINGS_HREF} scroll={false} onClick={(e) => { setAcct(false); onSettingsClick(e); }} style={{ ...pill, background: "rgba(255,255,255,.08)", textAlign: "center" }}>Settings</Link>
            <button role="menuitem" type="button" onClick={() => { setAcct(false); run("", disconnect); }} style={{ ...pill, background: "rgba(255,255,255,.08)", textAlign: "center" }}>Sign out</button>
          </div>
        )}
      </div>
      {/* top right stays minimal (lee, Oct 30): one cash figure + the account chip; no token / STRATEGY balance line */}
      {addr && !pf && cashText && !compact && <span title="Your cash: what BOOST spends and DUMP pays out in." style={{ fontSize: 10, opacity: 0.8 }}>{cashText}</span>}
      {addr && legacy && (
        <span role="status" aria-label="sweep old account" style={{ fontSize: 10, color: "#C9CED6", maxWidth: 320, textAlign: "right" }}>
          Your old account {legacy.account.slice(0, 8)}… still holds {[legacy.eth > BigInt(0) ? `${Number(formatUnits(legacy.eth, 18)).toFixed(5)} ETH` : "", ...legacy.tokens.map((t) => t.symbol)].filter(Boolean).join(", ")}.{" "}
          <button type="button" disabled={!!busy} onClick={() => run("sweeping", async () => { await sweepLegacy(); setLegacy(await legacyBalances().catch(() => null)); await refresh(addr); })} style={{ ...pill, padding: "1px 6px", fontSize: 9, background: "#C9CED6", color: "#0B0C0E" }}>Sweep old account</button>
        </span>
      )}
      {slipCap && sess?.oneTap && (
        <span role="status" aria-label="slippage cap" style={{ fontSize: 10, color: "#C9CED6", maxWidth: 320, textAlign: "right" }}>
          Slippage capped at {pct(slipCap.maxBps)} by your session. Start a new session with a higher max (up to 50%)?{" "}
          <button type="button" disabled={!!busy} onClick={() => run("restarting session", async () => { await restartOneTap(slipCap.suggestBps); setSlipCap(null); })} style={{ ...pill, padding: "1px 6px", fontSize: 9, background: "#C9CED6", color: "#0B0C0E" }}>New session at {pct(slipCap.suggestBps)}</button>{" "}
          <button type="button" onClick={() => setSlipCap(null)} style={{ ...pill, padding: "1px 6px", fontSize: 9, background: "rgba(255,255,255,.08)" }}>Keep {pct(slipCap.maxBps)}</button>
        </span>
      )}
      {err && <span role="alert" style={{ fontSize: 10, color: "#ffb0c0", maxWidth: 320, textAlign: "right" }}>{err}</span>}
    </div>
  );
}
