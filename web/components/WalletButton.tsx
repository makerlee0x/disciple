"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { usePathname } from "next/navigation";
import { formatUnits, parseAbi } from "viem";
import { MINTABLE_TEST_TOKENS, deployment, isDeployed } from "@/lib/chains";

import { decimalsOf, publicClient, readCurveState, usdgRouteFor } from "@/lib/protocol-viem";
import { cashLine, type BalancePart } from "@/lib/balanceLine";
import { payUsdg, routerUsdg } from "@/lib/trade/usdgRouter";
import {
  aaAvailable, connectLocal, connectPrivy, connectWallet, disconnect,
  hasWallet, isSmartMode, onWallet, restoreSmart,
} from "@/lib/wallet";
import {
  DEV_WALLETS, SIGNER_MODE, aaSession,
  legacyBalances, onSessionChange, sweepLegacy, restartOneTap,
} from "@/lib/aa/session";
import { bookedPortfolio, hangarValueUsd, loadPortfolio, type Portfolio } from "@/lib/portfolio";
import { SIGN_IN_COPY, SIGN_IN_FAILED_EVENT, WALLET_CTA_CLICK_EVENT, WALLET_CTA_EVENT, WALLET_ID_EVENT, type WalletId } from "@/lib/walletCta";
import { hasSavedSession, onPrivy, privyAuthenticated, privyLoaded } from "@/lib/aa/sessionState";
import { lastPill, saveLastPill, type LastPill } from "@/lib/walletState";
import dynamic from "next/dynamic";
import WelcomeToast, { TOPBAR_POPOVER_EVENT, markSignInStarted } from "@/components/account/WelcomeToast";
import SoldToast from "@/components/account/SoldToast";
import { COIN_DECIMALS, knownDecimals, usdgDecimals } from "@/lib/usdg";
import { BOOKED_EVENT, blockOf, bookFill, fillBook, readAtOrAfter, txBlock, type FillReceiptDetail } from "@/lib/fillBook";
import { pct } from "@/lib/aa/slippage";
import type { Address } from "@/lib/protocol";
import Icon from "@/components/icons/Icon";
import LevelRing from "@/components/xp/LevelRing";
import { usePilotPfp } from "@/lib/pilotPfp";
import { levelInfo } from "@/lib/xp";
import { useXp } from "@/lib/xpClient";
import { playerError } from "@/lib/playerError";
import { chipLabel as nameChip, clearNameCache, lookupFirstName } from "@/lib/nameLookup";
import { fetchProfileMeta } from "@/lib/profileMetaClient";
import { GuildTagFor } from "@/components/guilds/GuildChip";
import { GUILDS_ENABLED } from "@/lib/features";
import { PROFILE_CHANGED_EVENT } from "@/lib/profile";
import { DEPOSIT_HREF, SETTINGS_HREF, onDepositClick, onSettingsClick } from "@/lib/cashLink";
import { CASH_ARRIVED_EVENT } from "@/lib/testCash";
import { onTurboCash, setTurboWallet } from "@/lib/turbo/turboCash";

// The account menu reads Rewards (the whole claims stack), so it loads for signed-in players only: fetched once the page is
// idle after sign-in, shown on the first tap (speed pass 2026-11-21). Signed-out visitors never download it.
const loadAccountMenu = () => import("@/components/account/AccountMenu");
const AccountMenu = dynamic(loadAccountMenu, { ssr: false });

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
 * Sign in once (Privy: email / Google / X / Apple; no external-wallet sign-in) → Privy embedded EOA owns an Alchemy MAv2 smart account (self-pay gas,
 * user-funded native ETH) → "Enable one-tap" installs an on-chain session key → trades are one tap.
 * Dev options: an existing wallet as owner (one signature).
 * Legacy "plain wallet" path kept as fallback (one tx per action).
 */
/** maker 2026-11-17: the picture sits plain in the pill; the level progress runs around the pill's own border and the
 *  level number is a chip in the pill. */
function usePilotParts(wallet: string | null, last: LastPill | null) {
  const { xp } = useXp(wallet);
  const pfp = usePilotPfp(wallet);
  // until this wallet's picture / XP load, keep what the pill showed last time (no level-1 ring flash on a refresh)
  const was = last && wallet && last.address.toLowerCase() === wallet.toLowerCase() ? last : null;
  const img = pfp.loaded ? pfp.img : pfp.img ?? was?.img ?? null, nft = pfp.loaded || pfp.img ? pfp.nft : !!was?.nft;
  const info = xp?.level ?? (was?.level ? { ...levelInfo(0), level: was.level, progress: was.progress ?? 0 } : levelInfo(0));
  return { info, avatar: img
    // eslint-disable-next-line @next/next/no-img-element
    ? <span className={nft ? "wb-pfp pfp-hex" : "wb-pfp"}><img className="pfp-img" src={img} alt="" width={36} height={36} /></span>
    : <LevelRing info={{ ...info, progress: 0 }} size={36} />, hasPfp: !!img, img, nft };
}
/** Gold progress stroke around the pill's border, starting top-centre, clockwise. Sized to the pill (ResizeObserver). */
function PillProgress({ progress }: { progress: number }) {
  const ref = useRef<SVGSVGElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current?.parentElement; if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.offsetWidth, h: el.offsetHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const p = Math.max(0, Math.min(1, progress));
  const sw = 2.5, s = sw / 2;
  const d = box ? (() => {
    const { w, h } = box, r = h / 2 - s;
    return `M ${w / 2} ${s} H ${w - h / 2} A ${r} ${r} 0 0 1 ${w - h / 2} ${h - s} H ${h / 2} A ${r} ${r} 0 0 1 ${h / 2} ${s} Z`;
  })() : "";
  return (
    <svg ref={ref} className="wb-prog" width={box?.w ?? 0} height={box?.h ?? 0} aria-hidden>
      {/* nothing at 0 XP: a zero-length round-capped dash paints a stray gold dot */}
      {d && p > 0 && <path d={d} pathLength={100} fill="none" stroke="var(--dsc3-light-gold)" strokeWidth={sw} strokeLinecap="round" strokeDasharray={`${p * 100} 100`} />}
    </svg>
  );
}

export default function WalletButton({ compact = false, hideCash = false }: { compact?: boolean; /** profile pages: no cash / total cards */ hideCash?: boolean } = {}) {
  const [addr, setAddr] = useState<Address | null>(null);
  // Sign-in speed (2026-11-18): Privy takes seconds to reconnect on a refresh (SDK chunk, session check, wallet iframe).
  // Until it answers, a browser with a saved session shows its last pill (address, @name, cash) at once: display only, no
  // menu and no trades (those wait for the real session). Privy saying signed out, or 20 s without a Privy sign-in, drops it.
  // read on the first render (this component is client-only, AppShell ssr:false): the pill is in its first paint, never
  // a one-frame Sign in that would move the top bar
  const out = () => privyLoaded() && !privyAuthenticated();
  const [guess, setGuess] = useState<LastPill | null>(() => (typeof window !== "undefined" && hasSavedSession() && !out() ? lastPill() : null));
  useEffect(() => {
    const off = onPrivy(() => { if (out()) setGuess(null); });
    const t = setTimeout(() => { if (!privyAuthenticated()) setGuess(null); }, 20000);
    return () => { off(); clearTimeout(t); };
  }, []);
  useEffect(() => { if (addr) setGuess(null); }, [addr]);
  const shown: Address | null = addr ?? (guess?.address as Address | undefined) ?? null;
  const [remembered] = useState<LastPill | null>(() => (typeof window !== "undefined" ? lastPill() : null));
  const pilot = usePilotParts(shown, remembered);
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
  useEffect(() => {
    if (!addr) return;
    const w = window as Window & { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number };
    const t = setTimeout(() => (w.requestIdleCallback ? w.requestIdleCallback(() => void loadAccountMenu(), { timeout: 4000 }) : void loadAccountMenu()), 2000);
    return () => clearTimeout(t);
  }, [addr]);
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
  const readFor = useRef<string | null>(null);
  useEffect(() => { const addr = shown; if (readFor.current !== addr) { readFor.current = addr; setPf(null); lastRead.current = null; } if (!addr) return; refresh(addr); const i = setInterval(() => refresh(addr), 15000); const t = () => setTimeout(() => refresh(addr), 1500);
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
    return () => { clearInterval(i); removeEventListener("disciple:livetrade", t); removeEventListener("disciple:fillreceipt", r); removeEventListener("disciple:op", op); removeEventListener(CASH_ARRIVED_EVENT, cash); }; }, [shown, coin]);   // eslint-disable-line react-hooks/exhaustive-deps

  // live retest #5: the chip shows the claimed @name (the account's, else its owner's), not only the short address
  const [uname, setUname] = useState<string | null>(null);
  const [dname, setDname] = useState<string | null>(null);
  /** pill text: display name, else @username, else the call sign (never 0x) */
  const chipLabel = (u: string | null, a: string) => dname || nameChip(u, a);
  const ownerAddr = addr ? aaSession()?.owner : undefined;
  useEffect(() => {
    if (!shown) { setUname(null); setDname(null); return; }
    // paint the name this browser last showed for this wallet, then confirm it from the server
    const last = lastPill();
    setUname(last && last.address.toLowerCase() === shown.toLowerCase() ? last.name : null);
    let alive = true;
    const load = () => {
      lookupFirstName([shown, ownerAddr]).then((n) => { if (alive) setUname(n); });
      // the display name from Edit profile wins over @username in the pill (maker 2026-11-20: set a name, pill kept the address)
      fetchProfileMeta(shown).then((m) => { if (alive) setDname(m.name?.trim() || null); }).catch(() => undefined);
    };
    const changed = () => { clearNameCache(); load(); };
    load();
    addEventListener(PROFILE_CHANGED_EVENT, changed);
    return () => { alive = false; removeEventListener(PROFILE_CHANGED_EVENT, changed); };
  }, [shown, ownerAddr]);
  // the top-bar pill is ONE number: the Hangar value (maker 2026-11-20), Cash + rockets + Turbo cash, same sum as the
  // Hangar value card (lib/portfolio hangarValueUsd). The Cash popup splits Cash and Turbo cash.
  const [turboUsd, setTurboUsd] = useState(0);
  useEffect(() => onTurboCash((t) => setTurboUsd(t.usd)), []);
  useEffect(() => { setTurboWallet(addr); }, [addr]);
  // until this wallet's first read lands, show the total this browser last saw for it (never a blink to $0 and back)
  const seenTotal = useMemo(() => { const p = lastPill(); return p && shown && p.address.toLowerCase() === shown.toLowerCase() ? p.cashUsd : null; }, [shown]);
  const totalUsd = pf ? hangarValueUsd(pf.cashUsd, pf.holdings, turboUsd) : seenTotal ?? turboUsd;
  // remember the real pill for the next refresh
  useEffect(() => {
    if (!addr) return;
    const prev = lastPill();
    const keep = prev && prev.address.toLowerCase() === addr.toLowerCase() ? prev : null;
    const cashUsd = pf ? totalUsd : keep?.cashUsd ?? null;   // the saved pill holds the total it showed
    saveLastPill({ address: addr, name: uname, cashUsd, cash: cashUsd == null ? undefined : usd2(cashUsd), label: dname || nameChip(uname, addr),
      img: pilot.img, nft: pilot.nft, level: pilot.info.level, progress: pilot.info.progress });
  }, [addr, uname, dname, pf, totalUsd, pilot.img, pilot.nft, pilot.info.level, pilot.info.progress]);

  // premium sidebar: the Sidebar's account card shows the same address + name (display only; lib/walletCta.ts)
  useEffect(() => {
    const id: WalletId | null = shown ? { address: shown, name: uname } : null;
    (window as unknown as { __walletId?: WalletId | null }).__walletId = id;
    dispatchEvent(new CustomEvent(WALLET_ID_EVENT, { detail: id }));
  }, [shown, uname]);
  useEffect(() => () => {
    (window as unknown as { __walletId?: WalletId | null }).__walletId = null;
    dispatchEvent(new CustomEvent(WALLET_ID_EVENT, { detail: null }));
  }, []);

  const fail = (e: unknown) => setErr(playerError(e).slice(0, 160));
  // step 5 board: after the Privy window closes, the button holds "Setting up…" until the account exists; a failed
  // setup shows the pink retry line under it
  const [authed, setAuthed] = useState(false);
  useEffect(() => { const f = () => setAuthed(privyAuthenticated()); f(); return onPrivy(f); }, []);
  const settingUp = authed && !addr && SIGNER_MODE !== "local";
  const [signFail, setSignFail] = useState<false | string>(false);
  // detail.message: a specific blocker (an email that already signed in another way); else the generic retry line
  useEffect(() => { const f = (e: Event) => setSignFail((e as CustomEvent<{ message?: string } | null>).detail?.message || SIGN_IN_COPY.failed); addEventListener(SIGN_IN_FAILED_EVENT, f); return () => removeEventListener(SIGN_IN_FAILED_EVENT, f); }, []);
  useEffect(() => { if (addr) setSignFail(false); }, [addr]);
  /** Sign in goes straight to the Privy window (the old "Email or Google" box only stays for dev wallet options). */
  const signIn = () => {
    setErr(""); setSignFail(false); markSignInStarted();
    if (DEV_WALLETS) { setMenu((m) => !m); return; }
    try { connectPrivy(); } catch (e) { fail(e); }
  };
  async function run(label: string, f: () => Promise<unknown>) {
    setErr(""); setBusy(label);
    try { await f(); setMenu(false); } catch (e) { fail(e); } finally { setBusy(""); }
  }

  // Phones (≤760px): the signed-out pill ("Sign in") is hidden from the top bar (it pushed GAME's ✕ out of
  // the corner; CSS .ap-wallet-cta in globals.css) and the same action lives in the Sidebar menu. Publish the pill's
  // label for the Sidebar and run the pill's own action when the Sidebar item is tapped.
  const ctaLabel = !isDeployed() || shown ? null : aaAvailable() ? "Sign in" : "Connect wallet";
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
    if (shown || busy) return;
    if (aaAvailable() && SIGNER_MODE === "local") { markSignInStarted(); run("creating account", connectLocal); }
    else if (aaAvailable()) signIn();
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
    // pointerdown: in-wallet WebViews often skip a reliable mousedown before the next tap target
    const onDown = (e: PointerEvent) => {
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
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, acct]);

  // the top bar keeps clear of this fixed strip by its real width (cash amount and name length vary), so Play now never slides under the "?"
  useEffect(() => {
    const el = rootRef.current;
    if (!compact || !el || typeof ResizeObserver === "undefined") return;
    const html = document.documentElement;
    const set = () => html.style.setProperty("--wb-w", `${Math.ceil(el.getBoundingClientRect().width)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => { ro.disconnect(); html.style.removeProperty("--wb-w"); };
  }, [compact, addr]);

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
    <div ref={rootRef} aria-label="wallet" className="wb-root" data-compact={compact ? "true" : "false"}>
      <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
        {/* .wb-row: one line on desktop; on phones (≤480px) it wraps right-aligned instead of running off the left edge (GAME 390×844) */}
        <div className="wb-row" style={{ display: "flex", gap: 8, alignItems: "center", whiteSpace: "nowrap" }}>
          {shown ? (
            <>
              {compact ? (
                <>
                  {/* lobby routes: one pilot pill (level ring, @name, balance under it; maker 2026-11-19 "too crowded").
                      The "?" lives in the pilot menu now. The separate cash chip only shows when there is no split pill. */}
                  {!hideCash && !!addr && !smart && (
                    <a href={DEPOSIT_HREF} onClick={onDepositClick} className="wb-cash" data-testid="cash-card" aria-label="Your cash: open Cash" title="Cash. Boosts spend it, dumps pay it. Tap to add.">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /></svg>
                      <b>{usd2(totalUsd)}</b>
                      <svg className="wb-cash-plus" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
                    </a>
                  )}
                  {addr && smart ? (
                    /* pilot pill (maker 2026-11-18): the pill goes straight to the Hangar, only the arrow opens the menu.
                       Phones have no arrow, so there the arrow button covers the whole pill and a tap opens the menu. */
                    <div className="wb-pilot wb-pilot-split">
                      {pilot.avatar}
                      <span className="wb-id">
                        <span className="wb-name">{chipLabel(uname, shown)}</span>
                        {!hideCash && (
                          <a href={DEPOSIT_HREF} onClick={onDepositClick} className="wb-bal" data-testid="cash-card" aria-label="Your cash: open Cash">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /></svg>
                            <b>{usd2(totalUsd)}</b>
                          </a>
                        )}
                      </span>
                      {pilot.hasPfp && <b className="wb-lv" aria-label={`Level ${pilot.info.level}`}>{pilot.info.level}</b>}
                      <PillProgress progress={pilot.info.progress} />
                      <Link href="/profile" className="wb-pilot-go" aria-label="Your Hangar" data-testid="pilot-hangar" onClick={() => setAcct(false)} />
                      <button type="button" className="wb-chevbtn" aria-label="Your pilot menu" aria-haspopup="menu" aria-expanded={acct} data-testid="pilot-menu"
                        onClick={() => { if (!acct) dispatchEvent(new Event(TOPBAR_POPOVER_EVENT)); setAcct((v) => !v); }}>
                        <svg className="wb-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="wb-pilot" aria-label="Your pilot menu" aria-haspopup={smart ? "menu" : undefined} aria-expanded={smart ? acct : undefined} aria-busy={!addr || undefined}
                      onClick={() => { if (!addr) return; if (smart) { if (!acct) dispatchEvent(new Event(TOPBAR_POPOVER_EVENT)); setAcct((v) => !v); return; } navigator.clipboard?.writeText(addr); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
                      {pilot.avatar}
                      {/* while the session loads (saved pill) it already looks like the signed-in pill: name + balance */}
                      <span className="wb-id">
                        <span className="wb-name">{copied ? "Copied" : chipLabel(uname, shown)}</span>
                        {!hideCash && !(addr && !smart) && <span className="wb-bal"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /></svg><b>{usd2(totalUsd)}</b></span>}
                      </span>
                      {pilot.hasPfp && <b className="wb-lv" aria-label={`Level ${pilot.info.level}`}>{pilot.info.level}</b>}
                      <PillProgress progress={pilot.info.progress} />
                      {(smart || !addr) && <svg className="wb-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden><path d="M6 9l6 6 6-6" /></svg>}
                    </button>
                  )}
                </>
              ) : (
              <>
              {pf && smart && !hideCash && (
                  <div aria-label="cash and portfolio" className="wb-cards" style={{ display: "flex", gap: 6, alignItems: "stretch", minWidth: 0 }}>
                    <div data-testid="cash-card" style={cardStyle} title="Cash. Boosts spend it, dumps pay it.">
                      <span style={{ fontSize: 13, fontWeight: 800, color: "#E8EAEE" }}>{usd2(pf.cashUsd)} <span style={{ fontWeight: 600, opacity: 0.55 }}>cash</span></span>
                      <a href={DEPOSIT_HREF} onClick={onDepositClick} style={{ fontSize: 10, fontWeight: 700, color: "#C9CED6", textDecoration: "none" }}>Deposit more</a>
                    </div>
                    {/* total holdings bubble next to cash (back on lee's request, Oct 30 coin-screen cleanup) */}
                    <a href="/profile" data-testid="portfolio-card" style={{ ...cardStyle, textDecoration: "none", color: "inherit" }}
                      title={`Cash ${usd2(pf.cashUsd)} + coins ${usd2(pf.holdingsUsd)}.\n24h: your coins now vs. a day ago.`}>
                      <span style={{ fontSize: 13, fontWeight: 800, color: "#E8EAEE" }}>{usd2(pf.totalUsd)} <span style={{ fontWeight: 600, opacity: 0.55 }}>total</span></span>
                      <span style={{ fontSize: 10, fontWeight: 700, color: pf.change24hUsd > 0.005 ? GREEN : pf.change24hUsd < -0.005 ? RED : "#C9CED6" }}>{signedUsd(pf.change24hUsd)} <span style={{ opacity: 0.6, color: "#C9CED6" }}>24h</span></span>
                    </a>
                  </div>
                )}
                <button type="button" title={smart ? `Smart account (owner ${sess?.owner}) — click to copy` : "Wallet"} onClick={() => { if (!addr) return; if (smart) { setAcct((v) => !v); return; } navigator.clipboard?.writeText(addr); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
                  style={{ ...pill, background: "rgba(31,111,74,.9)", color: "#c8ffe4" }}>
                  {smart ? <><Icon name="bolt" size={12} style={{ verticalAlign: -1 }} /> </> : ""}{copied ? "copied" : chipLabel(uname, shown)}{!copied && GUILDS_ENABLED && <> <GuildTagFor address={shown} markOnly /></>}
                </button>
              </>
              )}
              {/* coin page cleanup (lee, Oct 30): no ✕ next to the chip; Sign out lives in the account menu + Sidebar */}
            </>
          ) : (
            aaAvailable() && SIGNER_MODE === "local" ? (
              <button type="button" className={`ap-wallet-cta${compact ? " wb-signin" : ""}`} onClick={() => { markSignInStarted(); run("creating account", connectLocal); }} disabled={!!busy} style={compact ? undefined : { ...pill, background: "#C9CED6", color: "#0B0C0E" }}>
                {busy ? <><span className="am-spin" aria-hidden />{SIGN_IN_COPY.settingUp}</> : SIGN_IN_COPY.signIn}
              </button>
            ) : (
            <button type="button" className={`ap-wallet-cta${compact ? " wb-signin" : ""}`} onClick={() => (aaAvailable() ? signIn() : setMenu((m) => !m))} disabled={!!busy || settingUp} style={compact ? undefined : { ...pill, background: "#C9CED6", color: "#0B0C0E" }} data-testid="signin-btn">
              {busy || settingUp ? <><span className="am-spin" aria-hidden />{SIGN_IN_COPY.settingUp}</> : aaAvailable() ? SIGN_IN_COPY.signIn : "Connect wallet"}
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
                <button type="button" disabled={!!busy || !hasWallet()} onClick={() => run("connecting", connectWallet)} style={{ ...pill, fontSize: 10, opacity: 0.7, textAlign: "center" }}>Plain wallet (sign every tx)</button>
                </>}
              </>
            ) : (
              <button type="button" disabled={!!busy} onClick={() => hasWallet() ? run("connecting", connectWallet) : setErr("We couldn't find a wallet in this browser. Install one, then try connecting again.")} style={{ ...pill, background: "#C9CED6", color: "#0B0C0E", textAlign: "center" }}>Connect wallet</button>
            )}
          </div>
        )}
        {/* account settings (one-tap session, max price move, Advanced, sign out) moved to Profile → Settings
            (SITE Oct 30); the chip opens this slim menu */}
        {addr && acct && smart && (
          <AccountMenu wallet={addr} name={chipLabel(uname, addr)} initial={(dname || uname || "P").replace(/^@/, "").charAt(0).toUpperCase()}
            cashUsd={pf?.cashUsd ?? 0} onClose={() => setAcct(false)} onSignOut={() => run("", disconnect)} />
        )}
        {!shown && signFail && (
          <div className="r2-note err wb-fail" role="alert" data-testid="signin-failed">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></svg>
            <span>{signFail} <button type="button" className="wb-retry" onClick={signIn}>{SIGN_IN_COPY.retry}</button></span>
          </div>
        )}
      </div>
      {/* top right stays minimal (lee, Oct 30): one cash figure + the account chip; no token / STRATEGY balance line */}
      {shown && !pf && cashText && !compact && <span title="Cash. Boosts spend it, dumps pay it." style={{ fontSize: 10, opacity: 0.8 }}>{cashText}</span>}
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
      {compact && <WelcomeToast wallet={addr} />}
      {compact && <SoldToast wallet={addr} />}
      {err && <span role="alert" style={{ fontSize: 10, color: "#ffb0c0", maxWidth: 320, textAlign: "right" }}>{err}</span>}
    </div>
  );
}
