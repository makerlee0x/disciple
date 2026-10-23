"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { usePathname } from "next/navigation";
import { encodeFunctionData, formatUnits, parseAbi, parseUnits } from "viem";
import { ACTIVE_CHAIN, GAS_FAUCET, MINTABLE_TEST_TOKENS, deployment, isDeployed } from "@/lib/chains";
import { decimalsOf, publicClient, readCurveState, tokenBalance, usdgRouteFor } from "@/lib/protocol-viem";
import { balanceLine, type BalancePart } from "@/lib/balanceLine";
import { payUsdg, routerUsdg } from "@/lib/trade/usdgRouter";
import {
  aaAvailable, activeAddress, connectLocal, importLocal, resetLocal, connectPrivy, connectSmartWithWallet, connectWallet, disconnect,
  execCalls, hasWallet, isSmartMode, onWallet, restoreSmart,
} from "@/lib/wallet";
import {
  DEV_WALLETS, SIGNER_MODE, SLIPPAGE_DEFAULT_BPS, SLIPPAGE_MAX_BPS, SLIPPAGE_MIN_BPS, aaSession, enableOneTap, endOneTap,
  legacyBalances, localExport, onSessionChange, sweepLegacy, oneTapAvailable, restartOneTap, oneTapStatus, oneTapSpendLimitUsd, setOneTapSpendLimitUsd,
} from "@/lib/aa/session";
import { loadPortfolio, type Portfolio } from "@/lib/portfolio";
import IdentitySigil from "@/components/profile/IdentitySigil";
import { pct } from "@/lib/aa/slippage";
import { fmtSessionExpiry } from "@/lib/aa/oneTap";
import type { Address } from "@/lib/protocol";
import Icon from "@/components/icons/Icon";

/** $1,234.56 (cash / portfolio cards). */
const usd2 = (n: number) => `$${(Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedUsd = (n: number) => `${n > 0.005 ? "+" : n < -0.005 ? "-" : ""}${usd2(Math.abs(n))}`;
const GREEN = "#8ff0c0", RED = "#ff9fb8";
/** Where "Deposit more" goes: the existing deposit / withdraw flow (private profile, Cash panel). */
const DEPOSIT_HREF = "/profile#cash";

const mintAbi = parseAbi(["function mint(address to, uint256 amount)"]);
const symAbi = parseAbi(["function symbol() view returns (string)"]);
const coinMeta = new Map<string, Promise<{ symbol: string; quote: Address } | null>>();
/** Symbol + pair (quote) token of a DISCIPLE coin, cached per page load. */
function metaOf(coin: Address) {
  const k = coin.toLowerCase();
  if (!coinMeta.has(k)) coinMeta.set(k, (async () => { const pc = publicClient(); const [symbol, st] = await Promise.all([pc.readContract({ address: coin, abi: symAbi, functionName: "symbol" }), readCurveState(pc, coin)]); return { symbol, quote: st.quote as Address }; })().catch(() => null));
  return coinMeta.get(k)!;
}

/**
 * Sign in once (Privy email / Google) → Privy embedded EOA owns an Alchemy MAv2 smart account (self-pay gas,
 * drip-funded on testnet) → "Enable one-tap" installs an on-chain session key → trades are one tap.
 * Dev options: an existing wallet as owner (one signature).
 * Legacy "plain wallet" path kept as fallback (one tx per action).
 */
export default function WalletButton({ compact = false }: { compact?: boolean } = {}) {
  const [addr, setAddr] = useState<Address | null>(null);
  const [busy, setBusy] = useState("");
  const [eth, setEth] = useState<bigint | null>(null);
  const [bal, setBal] = useState("");
  const [balTitle, setBalTitle] = useState("");
  const path = usePathname() || "";
  const coin = (/^\/coin\/(0x[0-9a-fA-F]{40})/.exec(path)?.[1] ?? null) as Address | null;
  const [err, setErr] = useState("");
  const [menu, setMenu] = useState(false);
  const [slipPct, setSlipPct] = useState(String(SLIPPAGE_DEFAULT_BPS / 100));
  // Opt-in one-tap spend limit ($, Advanced). Blank = no limit (default, per spec 05).
  const [limitUsd, setLimitUsd] = useState("");
  useEffect(() => { const v = oneTapSpendLimitUsd(); setLimitUsd(v ? String(v) : ""); }, []);
  const limitNum = () => { const n = Number(limitUsd.replace(/[$,\s]/g, "")); return Number.isFinite(n) && n > 0 ? n : null; };
  const saveLimit = () => setOneTapSpendLimitUsd(limitNum());
  const limitLabel = (v: number | null) => v ? `$${v.toLocaleString("en-US")} spend limit` : "no spend limit";
  const advancedLimit = (onApply: () => void, applyLabel: string) => (
    <details>
      <summary style={{ cursor: "pointer", opacity: 0.8 }}>Advanced</summary>
      <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>Spend limit $
        <input aria-label="one-tap spend limit $" inputMode="decimal" placeholder="none" value={limitUsd} onChange={(e) => setLimitUsd(e.target.value)} style={{ ...input, minWidth: 0, width: 80 }} />
        <button type="button" disabled={!!busy} onClick={onApply} style={{ ...pill, padding: "1px 6px", fontSize: 9, background: "#C9CED6", color: "#0B0C0E" }}>{applyLabel}</button>
      </label>
      <span style={{ opacity: 0.7 }}>Optional cap on what one-tap can spend per session. Leave blank for no limit. Price protection (max slippage) always applies.</span>
    </details>
  );
  const [, bump] = useState(0);
  const [copied, setCopied] = useState(false);
  const [acct, setAcct] = useState(false);
  const [shownKey, setShownKey] = useState("");
  const [imp, setImp] = useState("");
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

  async function refresh(a: Address) {
    try {
      const pc = publicClient();
      const e = await pc.getBalance({ address: a });
      setEth(e);
      const meta = coin ? await metaOf(coin) : null;
      // USDG pays only once the router supports it (#65); until then trades still spend the coin's quote
      const usdgPays = coin ? !!(await usdgRouteFor(pc, coin).catch(() => null)) : payUsdg() && !!(await routerUsdg(pc, deployment().router));
      const parts: BalancePart[] = [{ symbol: "ETH", amount: Number(formatUnits(e, 18)), role: "gas" }];
      const syms = MINTABLE_TEST_TOKENS.length ? MINTABLE_TEST_TOKENS : [{ symbol: "STRATEGY", address: deployment().defaultQuote }];
      const list: { symbol: string; address: Address; role: BalancePart["role"] }[] = syms.map((t) => ({ symbol: t.symbol, address: t.address, role: (usdgPays ? t.address.toLowerCase() === deployment().usdg.toLowerCase() : !!meta && t.address.toLowerCase() === meta.quote.toLowerCase()) ? "spend" : "other" }));
      if (meta) list.unshift({ symbol: meta.symbol, address: coin!, role: "held" });
      // USDG is shown as dollar "cash" in its own card (never as "USDG" in the header); keep it out of the token line
      if (usdgPays) for (let i = list.length - 1; i >= 0; i--) if (list[i].address.toLowerCase() === deployment().usdg.toLowerCase()) list.splice(i, 1);
      for (const t of list) {
        const [b, d] = await Promise.all([tokenBalance(pc, t.address, a), decimalsOf(pc, t.address)]);
        parts.push({ symbol: t.symbol, amount: Number(formatUnits(b, d)), role: t.role });
      }
      const l = balanceLine(parts, { payUsdg: usdgPays });
      setBal(l.text); setBalTitle(l.title);
    } catch { /* ignore */ }
    loadPortfolio(publicClient(), a, coin ? [coin] : []).then(setPf).catch(() => { /* keep last */ });
  }
  useEffect(() => { if (!addr) return; refresh(addr); const i = setInterval(() => refresh(addr), 15000); const t = () => setTimeout(() => refresh(addr), 1500);
    addEventListener("disciple:livetrade", t); return () => { clearInterval(i); removeEventListener("disciple:livetrade", t); }; }, [addr, coin]);   // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (e: unknown) => {
    const m = (e as Error).message.split("\n")[0];
    setErr(m.slice(0, 160));
  };
  async function run(label: string, f: () => Promise<unknown>) {
    setErr(""); setBusy(label);
    try { await f(); setMenu(false); } catch (e) { fail(e); } finally { setBusy(""); }
  }

  async function getFunds() {
    await run("minting", async () => {
      const pc = publicClient();
      const me = await activeAddress();
      const calls = [];
      for (const t of MINTABLE_TEST_TOKENS) {
        const d = await decimalsOf(pc, t.address);
        calls.push({ to: t.address, data: encodeFunctionData({ abi: mintAbi, functionName: "mint", args: [me, parseUnits(t.amount, d)] }) });
      }
      await execCalls(calls); // smart account: ONE userOp for all mints
      await refresh(me);
    });
  }

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
  const oneTap = oneTapStatus();
  const needFund = smart && eth !== null && eth < BigInt(3e12);
  const cardStyle: CSSProperties = { display: "flex", flexDirection: "column", justifyContent: "center", gap: 1, padding: compact ? "3px 9px" : "5px 11px",
    borderRadius: 12, background: "rgba(22,24,28,.88)", border: "1px solid rgba(201,206,214,.22)", lineHeight: 1.15 };
  const pill = { all: "unset" as const, cursor: "pointer", padding: "5px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700, letterSpacing: ".04em" };
  const input = { all: "unset" as const, padding: "5px 8px", borderRadius: 8, fontSize: 11, background: "rgba(255,255,255,.1)", minWidth: 180 };
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
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "nowrap", whiteSpace: "nowrap" }}>
          <span title="Network" style={{ fontSize: 10, padding: "4px 8px", borderRadius: 999, border: "1px solid rgba(201,206,214,.25)", color: "#C9CED6", opacity: 0.85 }}>{ACTIVE_CHAIN.name}</span>
          {addr ? (
            <>
              {pf && smart && (
                <div aria-label="cash and portfolio" style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
                  <div data-testid="cash-card" style={cardStyle} title="Your cash: what BOOST spends and DUMP pays out in.">
                    <span style={{ fontSize: 13, fontWeight: 800, color: "#E8EAEE" }}>{usd2(pf.cashUsd)} <span style={{ fontWeight: 600, opacity: 0.55 }}>cash</span></span>
                    <a href={DEPOSIT_HREF} style={{ fontSize: 10, fontWeight: 700, color: "#C9CED6", textDecoration: "none" }}>Deposit more</a>
                  </div>
                  <a href="/profile" data-testid="portfolio-card" style={{ ...cardStyle, flexDirection: "row", alignItems: "center", gap: 8, textDecoration: "none", color: "inherit" }}
                    title={`Total = cash ${usd2(pf.cashUsd)} + coins ${usd2(pf.holdingsUsd)} at current prices.\n24h: current holdings priced now vs 24h ago (no stored portfolio history; coins younger than 24h use their launch price).`}>
                    <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1 }}>
                      <span style={{ fontSize: 13, fontWeight: 800, color: "#E8EAEE" }}>{usd2(pf.totalUsd)}</span>
                      <span style={{ fontSize: 10, fontWeight: 700, color: pf.change24hUsd > 0.005 ? GREEN : pf.change24hUsd < -0.005 ? RED : "#C9CED6" }}>{signedUsd(pf.change24hUsd)} <span style={{ opacity: 0.6, color: "#C9CED6" }}>24h</span></span>
                    </span>
                    <IdentitySigil id="believer" size={26} />
                  </a>
                </div>
              )}
              {MINTABLE_TEST_TOKENS.length > 0 && (
                <button type="button" disabled={!!busy} onClick={getFunds} style={{ ...pill, background: "#2E323A", color: "#C9CED6" }}>
                  {busy || "Get test funds"}
                </button>
              )}
              <button type="button" title={smart ? `Smart account (owner ${sess?.owner}) — click to copy` : "Wallet"} onClick={() => { if (smart) { setAcct((v) => !v); return; } navigator.clipboard?.writeText(addr); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
                style={{ ...pill, background: "rgba(31,111,74,.9)", color: "#c8ffe4" }}>
                {smart ? <><Icon name="bolt" size={12} style={{ verticalAlign: -1 }} /> </> : ""}{copied ? "copied" : `${addr.slice(0, 6)}…${addr.slice(-4)}`}
              </button>
              {smart && SIGNER_MODE !== "local" && <button type="button" onClick={() => run("", disconnect)} style={{ ...pill, background: "rgba(255,255,255,.08)" }} aria-label="Disconnect"><Icon name="close" size={16} /></button>}
            </>
          ) : (
            aaAvailable() && SIGNER_MODE === "local" ? (
              <button type="button" onClick={() => run("creating account", connectLocal)} disabled={!!busy} style={{ ...pill, background: "#C9CED6", color: "#0B0C0E" }}>
                {busy || <><Icon name="play" size={16} /> Play</>}
              </button>
            ) : (
            <button type="button" onClick={() => setMenu((m) => !m)} disabled={!!busy} style={{ ...pill, background: "#C9CED6", color: "#0B0C0E" }}>
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
        {addr && acct && smart && sess?.kind !== "local" && (
          <div aria-label="account" role="menu" style={{ ...popover, width: 300, fontSize: 10 }}>
            <span style={{ wordBreak: "break-all" }}>Smart account: {addr} <button type="button" onClick={() => navigator.clipboard?.writeText(addr)} style={{ ...pill, padding: "1px 6px", fontSize: 9 }}>copy</button></span>
            <span style={{ opacity: 0.7, wordBreak: "break-all" }}>Owner (Privy wallet): {sess?.owner}</span>
            {bal && <span title={balTitle}>{bal}</span>}
            {sess?.oneTap ? (
              <>
                <span style={{ color: "#c8ffe4" }}>One-tap on · max slippage {(sess.oneTap.maxSlippageBps / 100).toString()}% · {limitLabel(oneTapSpendLimitUsd())} · {fmtSessionExpiry(sess.oneTap.validUntil)}</span>
                <button type="button" disabled={!!busy} onClick={() => run("ending session", endOneTap)} style={{ ...pill, background: "rgba(255,255,255,.08)", textAlign: "center" }}>End one-tap session</button>
                {advancedLimit(() => run("restarting session", async () => { saveLimit(); await restartOneTap(sess.oneTap!.maxSlippageBps); }), "Apply (new session)")}
              </>
            ) : oneTapAvailable() && oneTap.settingUp ? (
              <span style={{ color: "#C9CED6" }}>Setting up one-tap trading in the background… trades already go through without prompts (your wallet signs them silently).</span>
            ) : oneTapAvailable() ? (
              <>
                <span style={{ opacity: 0.8 }}>Trades go through without prompts (your wallet signs them silently).{oneTap.error ? ` One-tap session setup failed: ${oneTap.error}` : ""}</span>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>Max slippage
                  <input aria-label="session max slippage %" type="number" min={SLIPPAGE_MIN_BPS / 100} max={SLIPPAGE_MAX_BPS / 100} step={0.1} value={slipPct} onChange={(e) => setSlipPct(e.target.value)} style={{ ...input, minWidth: 0, width: 60 }} />%
                </label>
                <button type="button" disabled={!!busy} onClick={() => run("approve session", () => { saveLimit(); return enableOneTap({ maxSlippageBps: Math.round(Number(slipPct) * 100), spendLimitUsd: limitNum() }); })} style={{ ...pill, background: "#C9CED6", color: "#0B0C0E", textAlign: "center" }}>Enable one-tap trading</button>
                {advancedLimit(saveLimit, "Save")}
                <span style={{ opacity: 0.7 }}>Optional: a 24h session key (a little gas) caps slippage on-chain. Trades above this slippage are rejected on-chain.</span>
              </>
            ) : (
              <span style={{ opacity: 0.7 }}>Trades are signed by your Privy wallet in the background.</span>
            )}
            <a href={GAS_FAUCET} target="_blank" rel="noreferrer" style={{ color: "#C9CED6" }}>ETH faucet</a>
            <button type="button" onClick={() => { setAcct(false); run("", disconnect); }} style={{ ...pill, background: "rgba(255,255,255,.08)", textAlign: "center" }}>Sign out</button>
          </div>
        )}
        {addr && acct && smart && sess?.kind === "local" && (
          <div aria-label="account" role="menu" style={{ ...popover, width: 300, fontSize: 10 }}>
            <span style={{ color: "#C9CED6" }}>Testnet wallet stored in this browser. Clearing site data loses it — export the key to back it up.</span>
            <span style={{ wordBreak: "break-all" }}>Account: {addr} <button type="button" onClick={() => navigator.clipboard?.writeText(addr)} style={{ ...pill, padding: "1px 6px", fontSize: 9 }}>copy</button></span>
            <span style={{ opacity: 0.7, wordBreak: "break-all" }}>Owner key address: {sess?.owner}</span>
            {bal && <span title={balTitle}>{bal}</span>}
            <a href={GAS_FAUCET} target="_blank" rel="noreferrer" style={{ color: "#C9CED6" }}>ETH faucet</a>
            {shownKey ? (
              <span style={{ wordBreak: "break-all", color: "#ffb0c0" }}>{shownKey} <button type="button" onClick={() => setShownKey("")} style={{ ...pill, padding: "1px 6px", fontSize: 9 }}>hide</button></span>
            ) : (
              <button type="button" onClick={() => { if (confirm("Reveal your private key? Anyone with it controls this account. Never share it.")) setShownKey(localExport() || ""); }} style={{ ...pill, background: "#2E323A", textAlign: "center" }}>Export key</button>
            )}
            <div style={{ display: "flex", gap: 4 }}>
              <input aria-label="import key" placeholder="0x… private key" value={imp} onChange={(e) => setImp(e.target.value)} style={{ ...input, minWidth: 0, flex: 1 }} />
              <button type="button" disabled={!imp || !!busy} onClick={() => { if (confirm("Replace this browser's wallet with the imported key? Export the current key first if it holds funds.")) run("importing", async () => { await importLocal(imp); setImp(""); setAcct(false); }); }} style={{ ...pill, background: "#2E323A" }}>Import</button>
            </div>
            <button type="button" onClick={() => { if (confirm("Reset wallet? This deletes the key from this browser. Funds are lost unless you exported the key.")) run("", async () => { await resetLocal(); setAcct(false); setShownKey(""); }); }} style={{ ...pill, background: "#7a1f2f", color: "#ffd0d8", textAlign: "center" }}>Reset wallet</button>
          </div>
        )}
      </div>
      {addr && bal && !compact && <span title={balTitle} style={{ fontSize: 10, opacity: 0.8 }}>{bal}{smart ? " · self-pay gas" : ""} · <a href={GAS_FAUCET} target="_blank" rel="noreferrer" style={{ color: "#C9CED6" }}>ETH faucet</a></span>}
      {needFund && <span role="status" style={{ fontSize: 10, color: "#C9CED6", maxWidth: 320, textAlign: "right" }}>Low on gas — fund your account ({addr?.slice(0, 8)}…) with test ETH from the <a href={GAS_FAUCET} target="_blank" rel="noreferrer" style={{ color: "#fff" }}>faucet</a>.</span>}
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
