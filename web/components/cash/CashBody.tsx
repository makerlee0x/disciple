"use client";
/**
 * Cash (round 2 board "Cash", signed off by maker 2026-11-13): one body shared by the Cash popup (CashHost, opened from
 * the top-bar cash chip and Add cash in the Hangar) and /wallet for old links.
 *  - Your cash, then Add cash (QR + your cash address + Copy) and Cash out (big $ amount, quick picks, Send to + Paste,
 *    You receive / Network fee, gold Cash out $x). No test cash, no confirm() dialog: the fee and the fine print are
 *    shown before you press.
 *  - Sent: a plain receipt. Errors: plain words (never "relayer not configured").
 *  - Signed out: a sign-in moment.
 * Withdraw logic is the old CashPanel's (gasless quote + signed withdraw, or a plain USDG transfer), unchanged.
 * Cash and Turbo cash side by side (maker 2026-11-18): two balances, never one total here (the top-bar pill is the
 * combined one). "To Turbo" moves cash into Turbo's venue (Lighter, lib/lighter/deposit) where this browser trades there.
 * Desktop fits a ~790px-tall window with no scroll (like Settings, #482).
 */
import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, formatUnits, isAddress, parseAbi, parseUnits, type Hex } from "viem";
import { ACTIVE_CHAIN, deployment, isDeployed } from "@/lib/chains";
import { decimalsOf, publicClient, tokenBalance } from "@/lib/protocol-viem";
import { clientGaslessMode } from "@/lib/aa/sponsorshipMode";
import { execCalls, gaslessSigner, onWallet } from "@/lib/wallet";
import { CANCELLED_MSG, playerError } from "@/lib/playerError";
import type { Address } from "@/lib/protocol";
import { CASH_ARRIVED_EVENT } from "@/lib/testCash";
import { OPEN_CASH_EVENT, type CashTab } from "@/lib/cashLink";
import { WALLET_CTA_CLICK_EVENT } from "@/lib/walletCta";
import { withBase } from "@/lib/base-path";
import { CashHead, Check, ErrIcon, Warn, usd2 } from "./bits";
import { FUND_CARD_FEE_EST, FUND_COPY, FUND_DEFAULT_USD, FUND_MAX_USD, FUND_MIN_USD, FUND_PICKS, fundAmountInput, startFunding } from "@/lib/fund";
import { DEPOSIT_COPY } from "@/lib/deposit";
import { onTurboCash, refreshTurboCash, setTurboWallet, turboCashDev, type TurboCash } from "@/lib/turbo/turboCash";
import { clearLanding, landing, onLanding, startLanding, type Landing } from "@/lib/turbo/landing";
import SendCrypto from "./SendCrypto";
import SignInMarks from "@/components/SignInMarks";
import UserPicker, { RecipientCard } from "@/components/ui/UserPicker";
import { rememberRecipient, type Recipient } from "@/lib/send/recipient";

const erc20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

export const CASH_COPY = {
  title: "Cash",
  yourCash: "Cash",
  turboCash: "Turbo cash",
  moveBack: "To cash",
  moving: "Moving…",
  moveFailed: "Couldn't move it right now. Your fuel is still in Turbo.",
  tabs: { add: "Deposit", turbo: "Turbo", out: "Transfer" },
  dirs: { in: "To Turbo", back: "To Cash" },
  toCash: (v: string) => `Move ${v} to Cash`,
  landsCash: "Lands in Cash",
  turboFee: "Transfer fee",
  canMove: (v: string) => `You can move ${v}`,
  movingBack: "Moving…",
  backFine: (min: number) => `Lands in a few minutes. Min $${min}.`,
  backDone: (v: string) => `${v} on its way to Cash.`,
  toTurbo: (v: string) => `Move ${v} to Turbo`,
  turboMin: (v: string) => `${v} minimum deposit`,
  lands: "Lands in Turbo cash",
  turboSteps: { address: "Sending…", sending: "Sending…", arriving: "Landing in Turbo…", setup: "Setting up Turbo…", done: "Done" },
  /** the countdown beside "Landing in Turbo" (est., from Relay's time + Lighter's credit) */
  turboEta: (left: string) => `~${left}`,
  turboEtaOver: "any sec",
  turboDone: (v: string) => `${v} moved to Turbo cash.`,
  addTitle: "Send USDG to your cash address",
  addBody: "From an exchange or another wallet, on Robinhood Chain. It shows up as cash when it lands.",
  addBodyPhone: "Send USDG on Robinhood Chain to this address. It shows up as cash when it lands.",
  addrLabel: "Your cash address",
  copy: "Copy", copied: "Copied", copyAddr: "Copy address",
  warn: "Only USDG on Robinhood Chain counts as cash. Other coins or networks won't show up here.",
  warnPhone: "Only USDG on Robinhood Chain counts as cash.",
  howMuch: "How much",
  youHave: (v: string) => `You have ${v}`,
  receive: "You receive",
  theyGet: "They get",
  fee: "Network fee",
  cashOut: (v: string) => `Send ${v}`,
  sending: "Sending…",
  fine: "Can't be undone",
  sent: (v: string) => `${v} sent`,
  sentTo: (left: string) => `Your cash is now ${left}.`,
  receipt: "View receipt",
  done: "Done",
  badAddr: "That address doesn't look right. It starts with 0x and has 42 characters.",
  down: "Cash out is down for a moment. Nothing was sent. Try again in a few minutes.",
  tooMuch: (v: string) => `That's more than you have. You can cash out up to ${v}.`,
  tooLittle: (v: string) => `That's below the smallest send. Try more than ${v}.`,
  signInTitle: "Sign in to add cash",
  signIn: "Sign in",
} as const;

const PICKS = [["25%", 0.25], ["40%", 0.4], ["Half", 0.5], ["All", 1]] as const;
/** 83 → "1:23" */
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

export function Amount({ v, big }: { v: number; big?: boolean }) {
  const [w, c] = usd2(v).split(".");
  return <div className={`cx-amt${big ? "" : " sm"}`}>{w}<small>.{c}</small></div>;
}

/** Add cash board 2 (maker 2026-11-14): How much (big number + $10/$25/$50/$100) → You pay / You get about → one gold
 *  "Pay with card or Apple Pay" (Privy card on-ramp → USDC on Base → Relay deposit address → USDG) → "or" → "Send USDG" (maker 2026-11-20: the Free play link left
 *  this card; USDG is the only coin taken). */
function CardFund({ addr, onPaid, onSend }: { addr: string; onPaid: () => void; onSend: () => void }) {
  // typed or picked (maker 2026-11-20: "i should be able to type in how much i want to deposit")
  const [amt, setAmt] = useState<string>(String(FUND_DEFAULT_USD));
  const usd = Number(amt) || 0;
  const low = usd < FUND_MIN_USD, high = usd > FUND_MAX_USD;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const go = async () => {
    setBusy(true); setNote(null);
    const r = await startFunding({ address: addr, usd });
    setBusy(false);
    // shutting the checkout without paying says nothing (maker 2026-11-20)
    if (r.closed) return;
    setNote(r.ok ? { ok: true, text: FUND_COPY.done } : { ok: false, text: r.message || FUND_COPY.unavailable });
    if (r.ok) onPaid();
  };
  return (
    <div className="cx-card" data-testid="cash-card-fund">
      <label className="r2-lbl" htmlFor="cx-famt">{FUND_COPY.howMuch}</label>
      <div className="r2-field cx-big">
        <span className="r2-g cx-dollar">$</span>
        <input id="cx-famt" inputMode="decimal" placeholder="0" value={amt} autoComplete="off" data-testid="cash-card-amount"
          onChange={(e) => { setNote(null); setAmt(fundAmountInput(e.target.value)); }} />
      </div>
      <div className="r2-chips" role="group" aria-label="Amount to add">
        {FUND_PICKS.map((v) => <button key={v} type="button" className={usd === v ? "on" : ""} aria-pressed={usd === v} onClick={() => { setNote(null); setAmt(String(v)); }}>${v}</button>)}
      </div>
      <div className="r2-box cx-paygrid">
        <div className="r2-r"><div className="t"><span>{FUND_COPY.youPay}</span></div><b>{usd2(usd)}</b></div>
        <div className="r2-r"><div className="t"><span>{FUND_COPY.youGet}</span></div><b className="cx-get" data-testid="cash-card-get">{usd2(usd * (1 - FUND_CARD_FEE_EST))}</b></div>
      </div>
      <button type="button" className="r2-gold cx-cardbtn" disabled={busy || low || high} onClick={go} data-testid="cash-card-btn">
        {busy ? FUND_COPY.opening : FUND_COPY.button}
      </button>
      {(low || high) && amt !== "" && <div className="r2-note warn" role="status" data-testid="cash-card-limit"><span>{low ? FUND_COPY.min : FUND_COPY.max}</span></div>}
      {note && <div className={`r2-note ${note.ok ? "ok" : "warn"}`} role="status"><span>{note.text}</span></div>}
      <div className="cx-or" aria-hidden><span>{FUND_COPY.or}</span></div>
      <button type="button" className="cx-sendrow" onClick={onSend} data-testid="cash-send-crypto-btn">
        <span className="t"><b>{FUND_COPY.sendTitle}</b><span>{FUND_COPY.sendSub}</span></span>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M6 3l5 5-5 5" /></svg>
      </button>
    </div>
  );
}

/** To Turbo: cash → the player's Lighter account (lighterAddCash: gasless cash-out to the Lighter deposit address, then
 *  Lighter set-up runs on its own). The cash-out network fee comes off the amount, so "Lands in Turbo cash" is net. */
export function ToTurbo({ balUsd, feeUsd, min, onMoved }: { balUsd: number; feeUsd: number; min: number; onMoved: () => void }) {
  const [amt, setAmt] = useState("");
  // the transfer runs in lib/turbo/landing, so it keeps going (with its countdown chip) after this popup closes
  const [land, setLand] = useState<Landing>(() => landing());
  useEffect(() => onLanding(setLand), []);
  const step = land.step && land.step !== "done" ? land.step : null;
  const [err, setErr] = useState<string | null>(null);
  // "Landing in Turbo" countdown (maker 2026-11-20: a spinner + est. time so it doesn't look frozen)
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!step) return; const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, [step]);
  const n = Number(amt) || 0;
  const pickOn = (f: number) => amt !== "" && Math.abs(Math.floor(balUsd * f * 100) / 100 - n) < 0.005;
  const left = land.landsAt != null && step === "arriving" ? Math.ceil((land.landsAt - now) / 1000) : null;
  // the real credited amount (maker 2026-11-20: "says $5.99 moved when only $5.95 did")
  const done = land.step === "done" ? CASH_COPY.turboDone(usd2(land.creditedUsd ?? Math.max(0, n - feeUsd))) : null;
  const go = async () => {
    setErr(null); clearLanding();
    if (n > balUsd + 1e-9) return setErr(CASH_COPY.tooMuch(usd2(balUsd)));
    const owner = gaslessSigner();
    if (!owner) { window.dispatchEvent(new Event(WALLET_CTA_CLICK_EVENT)); return; }
    const r = await startLanding(async (onStep) => {
      const [{ lighterAddCash }, { lighterFetcher }, { aaSignMessage }] = await Promise.all([import("@/lib/lighter/deposit"), import("@/lib/lighter/duel"), import("@/lib/aa/session")]);
      const sign = async (m: string) => { const x = await aaSignMessage(m); if (!x) throw new Error("Your wallet didn't sign."); return x.sig; };
      return lighterAddCash(lighterFetcher(owner.address.toLowerCase()), n, sign, onStep);
    });
    // r.error is already player copy, made from the real error in lib/turbo/landing
    if (r.error) setErr(r.error);
    else setAmt("");
    onMoved();
  };
  return (
    <>
      <div>
        <div className="cx-split"><label className="r2-lbl" htmlFor="cx-tamt">{CASH_COPY.howMuch}</label><span className="r2-lbl">{CASH_COPY.youHave(usd2(balUsd))}</span></div>
        <div className="r2-field cx-big">
          <span className="r2-g cx-dollar">$</span>
          <input id="cx-tamt" inputMode="decimal" placeholder="0.00" value={amt} autoComplete="off" data-testid="cash-turbo-amount"
            onChange={(e) => { setErr(null); clearLanding(); setAmt(e.target.value.replace(/[^0-9.]/g, "")); }} />
        </div>
        <div className="r2-chips">
          {PICKS.map(([l, f]) => (
            <button key={l} type="button" className={pickOn(f) ? "on" : ""} onClick={() => { setErr(null); clearLanding(); setAmt((Math.floor(balUsd * f * 100) / 100).toFixed(2)); }}>{l}</button>
          ))}
        </div>
      </div>
      <div className="r2-box">
        <div className="r2-r"><div className="t"><b>{CASH_COPY.lands}</b></div><span className="r2-g cx-recv">{usd2(Math.max(0, n - feeUsd))}</span></div>
        {feeUsd > 0 && <div className="r2-r"><div className="t"><span>{CASH_COPY.fee}</span></div><span className="cx-fee">{usd2(feeUsd)}</span></div>}
      </div>
      {err && <div className="r2-note err" role="alert"><ErrIcon /><span>{err}</span></div>}
      {done && <div className="r2-note ok" role="status"><span>{done}</span></div>}
      <button type="button" className="r2-gold" disabled={!!step || n < min - 1e-9} onClick={go} data-testid="cash-turbo-btn" aria-busy={!!step || undefined}>
        {step && <span className="am-spin" aria-hidden />}
        {step ? CASH_COPY.turboSteps[step] : n >= min - 1e-9 ? CASH_COPY.toTurbo(usd2(n)) : CASH_COPY.turboMin(usd2(min))}
        {left != null && <span className="cx-eta" data-testid="cash-turbo-eta">{left > 0 ? CASH_COPY.turboEta(mmss(left)) : CASH_COPY.turboEtaOver}</span>}
      </button>
    </>
  );
}

/** To Cash: Turbo cash → Cash (lighterWithdraw: a Lighter fast withdrawal to the player's cash address). Lighter's
 *  transfer fee is charged on top, so "Lands in Cash" is the amount typed and the fee row shows what else comes off. */
export function FromTurbo({ cashAddr, onMoved }: { cashAddr: string; onMoved: () => void }) {
  const [amt, setAmt] = useState("");
  const [info, setInfo] = useState<{ usd: number; fee: number; min: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const fetcher = useCallback(async () => {
    const { lighterFetcher } = await import("@/lib/lighter/duel");
    const owner = gaslessSigner();
    if (!owner) throw new Error("Sign in first.");
    return lighterFetcher(owner.address.toLowerCase());
  }, []);
  const load = useCallback(async () => {
    if (turboCashDev()) { setInfo({ usd: 250, fee: 0.02, min: 1 }); return; }
    try { const { lighterWithdrawInfo } = await import("@/lib/lighter/withdraw"); setInfo(await lighterWithdrawInfo(await fetcher())); }
    catch (e) { setErr(playerError(e).replace(/Lighter/g, "Turbo")); }
  }, [fetcher]);
  useEffect(() => { void load(); }, [load]);
  const max = info?.usd ?? 0;
  const n = Number(amt) || 0;
  const pickOn = (f: number) => amt !== "" && Math.abs(Math.floor(max * f * 100) / 100 - n) < 0.005;
  const go = async () => {
    setErr(null); setDone(null);
    if (info && n > info.usd + 1e-9) return setErr(CASH_COPY.tooMuch(usd2(info.usd)));
    setBusy(true);
    try {
      const [{ lighterWithdraw }, { aaSignMessage }] = await Promise.all([import("@/lib/lighter/withdraw"), import("@/lib/aa/session")]);
      const sign = async (m: string) => { const r = await aaSignMessage(m); if (!r) throw new Error("Your wallet didn't sign."); return r.sig; };
      const r = await lighterWithdraw(await fetcher(), n, cashAddr, sign);
      setDone(CASH_COPY.backDone(usd2(r.usd || n))); setAmt("");
      void load();
    } catch (e) {
      const t = playerError(e);
      setErr(t === CANCELLED_MSG ? t : t.replace(/Lighter/g, "Turbo"));
    } finally { setBusy(false); onMoved(); }
  };
  return (
    <>
      <div>
        <div className="cx-split"><label className="r2-lbl" htmlFor="cx-bamt">{CASH_COPY.howMuch}</label><span className="r2-lbl">{CASH_COPY.canMove(usd2(max))}</span></div>
        <div className="r2-field cx-big">
          <span className="r2-g cx-dollar">$</span>
          <input id="cx-bamt" inputMode="decimal" placeholder="0.00" value={amt} autoComplete="off" data-testid="cash-back-amount"
            onChange={(e) => { setErr(null); setDone(null); setAmt(e.target.value.replace(/[^0-9.]/g, "")); }} />
        </div>
        <div className="r2-chips">
          {PICKS.map(([l, f]) => (
            <button key={l} type="button" className={pickOn(f) ? "on" : ""} disabled={!max} onClick={() => { setErr(null); setDone(null); setAmt((Math.floor(max * f * 100) / 100).toFixed(2)); }}>{l}</button>
          ))}
        </div>
      </div>
      <div className="r2-box">
        <div className="r2-r"><div className="t"><b>{CASH_COPY.landsCash}</b></div><span className="r2-g cx-recv">{usd2(n)}</span></div>
        {info && info.fee > 0 && <div className="r2-r"><div className="t"><span>{CASH_COPY.turboFee}</span></div><span className="cx-fee">{usd2(info.fee)}</span></div>}
      </div>
      {err && <div className="r2-note err" role="alert"><ErrIcon /><span>{err}</span></div>}
      {done && <div className="r2-note ok" role="status"><span>{done}</span></div>}
      <button type="button" className="r2-gold" disabled={busy || n <= 0} onClick={go} data-testid="cash-back-btn">
        {busy ? CASH_COPY.movingBack : n > 0 ? CASH_COPY.toCash(usd2(n)) : CASH_COPY.dirs.back}
      </button>
      <span className="cx-fine">{CASH_COPY.backFine(info?.min ?? 1)}</span>
    </>
  );
}

/** A thrown withdraw error in plain words: relay / quote / server trouble reads as "down for a moment". */
function cashOutError(e: unknown): string {
  const t = playerError(e);
  if (t === CANCELLED_MSG) return t;
  const err = e as { data?: { notSent?: boolean }; status?: number; message?: string };
  if (err?.data?.notSent || (err?.status ?? 0) >= 500 || /relay|not configured|quote|HTTP|fetch|network|timeout/i.test(err?.message ?? "")) return CASH_COPY.down;
  return t;
}

export default function CashBody({ onClose, initialTab = "add" }: { onClose: () => void; initialTab?: CashTab }) {
  const [addr, setAddr] = useState<Address | null>(null);
  const [bal, setBal] = useState<{ raw: bigint; dec: number; token: Address } | null>(null);
  const [tab, setTab] = useState<CashTab>(initialTab);
  const [rcpt, setRcpt] = useState<Recipient | null>(null);
  const to = rcpt?.address ?? "";
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<{ recv: number; to: Recipient; left: number; tx: Hex | null } | null>(null);
  const [sendView, setSendView] = useState(false);
  const [turbo, setTurbo] = useState<TurboCash | null>(null);
  const [dir, setDir] = useState<"in" | "back">("in");
  const fuel = turbo?.fuel ?? null;
  const [fuelBusy, setFuelBusy] = useState(false);
  const [fuelErr, setFuelErr] = useState<string | null>(null);
  useEffect(() => onTurboCash(setTurbo), []);
  const [quote, setQuote] = useState<{ fee: bigint; minAmount: bigint; feeTo: string; usdgDecimals: number } | null>(null);
  useEffect(() => onWallet(setAddr), []);
  useEffect(() => { setTurboWallet(addr); }, [addr]);

  const refresh = useCallback(async (a: Address) => {
    // dev only (screenshots): window.__portfolioDev.cashUsd stands in for the USDG read
    const dev = process.env.NODE_ENV !== "production" ? (window as unknown as { __portfolioDev?: { cashUsd: number } }).__portfolioDev : undefined;
    if (dev) { setBal({ raw: BigInt(Math.round(dev.cashUsd * 1e6)), dec: 6, token: a }); return; }
    if (!isDeployed()) return;
    try {
      const pc = publicClient();
      const usdg = deployment().usdg as Address;
      const [b, d] = await Promise.all([tokenBalance(pc, usdg, a), decimalsOf(pc, usdg)]);
      setBal({ raw: b, dec: d, token: usdg });
    } catch { /* rpc hiccup: keep the last read */ }
  }, []);
  useEffect(() => {
    if (!addr) return;
    void refresh(addr);
    const i = setInterval(() => refresh(addr), 20000);
    const cash = () => { void refresh(addr); };
    window.addEventListener(CASH_ARRIVED_EVENT, cash);
    return () => { clearInterval(i); window.removeEventListener(CASH_ARRIVED_EVENT, cash); };
  }, [addr, refresh]);
  // a cash link clicked while this body is already showing (e.g. on /wallet): switch tab in place
  useEffect(() => {
    const f = (e: Event) => { const t = (e as CustomEvent<{ tab?: CashTab } | null>).detail?.tab; setSent(null); setSendView(false); setTab(t ?? "add"); };
    window.addEventListener(OPEN_CASH_EVENT, f);
    return () => window.removeEventListener(OPEN_CASH_EVENT, f);
  }, []);

  const gasless = clientGaslessMode();
  useEffect(() => {
    if (!gasless || tab === "add" || !addr) return;
    let alive = true;
    import("@/lib/trade/gaslessWithdrawClient").then(({ quoteGaslessWithdraw }) => quoteGaslessWithdraw({ signer: addr }))
      .then((q) => { if (alive) setQuote({ fee: q.fee, minAmount: q.minAmount, feeTo: q.feeTo, usdgDecimals: q.usdgDecimals }); })
      .catch(() => { if (alive) setQuote(null); });
    return () => { alive = false; };
  }, [gasless, tab, addr]);

  // "To Turbo" only where this browser can move cash there; a turbo link elsewhere lands on Add cash
  useEffect(() => { if (tab === "turbo" && turbo && !turbo.canAdd) setTab("add"); }, [tab, turbo]);
  const balUsd = bal ? Number(formatUnits(bal.raw, bal.dec)) : 0;
  const amtNum = Number(amt) || 0;
  const feeUsd = gasless && quote ? Number(formatUnits(quote.fee, quote.usdgDecimals)) : 0;
  const recvUsd = Math.max(0, amtNum - feeUsd);
  const pickOn = (f: number) => amt !== "" && Math.abs(Math.floor(balUsd * f * 100) / 100 - amtNum) < 0.005;

  async function cashOut() {
    setErr(null);
    if (!bal || !addr) return;
    if (!isAddress(to, { strict: false })) return setErr(CASH_COPY.badAddr);
    let amount: bigint;
    try { amount = parseUnits(amt || "0", bal.dec); } catch { amount = BigInt(0); }
    if (amount <= BigInt(0)) return;
    if (amount > bal.raw) return setErr(CASH_COPY.tooMuch(usd2(balUsd)));
    setBusy(true);
    try {
      if (gasless) {
        const owner = gaslessSigner();
        if (!owner) { window.dispatchEvent(new Event(WALLET_CTA_CLICK_EVENT)); return; }
        const { quoteGaslessWithdraw, signGaslessWithdraw, submitGaslessWithdraw } = await import("@/lib/trade/gaslessWithdrawClient");
        const { privyIdentityToken } = await import("@/lib/aa/session");
        const q = await quoteGaslessWithdraw({ amount, signer: owner.address });
        setQuote({ fee: q.fee, minAmount: q.minAmount, feeTo: q.feeTo, usdgDecimals: q.usdgDecimals });
        if (amount < q.minAmount) { setErr(CASH_COPY.tooLittle(usd2(Number(formatUnits(q.fee, q.usdgDecimals))))); return; }
        const tokenP = privyIdentityToken().catch(() => null);
        const req = await signGaslessWithdraw(publicClient() as never, owner, { amount, destination: to as Address, quote: q });
        const res = await submitGaslessWithdraw(req, "/api/gasless", fetch, await tokenP);
        const recv = Number(formatUnits(amount - q.fee, q.usdgDecimals));
        setSent({ recv, to: rcpt!, left: Math.max(0, balUsd - amtNum), tx: res.txHash }); rememberRecipient(rcpt!);
      } else {
        const tx = await execCalls([{ to: bal.token, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [to as Address, amount] }) }]);
        setSent({ recv: amtNum, to: rcpt!, left: Math.max(0, balUsd - amtNum), tx: tx.txHash }); rememberRecipient(rcpt!);
      }
      setAmt("");
      void refresh(addr);
    } catch (e) { setErr(cashOutError(e)); }
    finally { setBusy(false); }
  }

  if (!addr) {
    return (
      <>
        <CashHead title={CASH_COPY.title} onClose={onClose} />
        <div className="r2-body" data-testid="cash-signed-out">
          <div className="cx-sky" style={{ backgroundImage: `url(${withBase("/home/sky/t6.webp")})` }} aria-hidden />
          <b className="r2-g cx-h">{CASH_COPY.signInTitle}</b>
          <SignInMarks size={16} />
          <button type="button" className="r2-gold" onClick={() => { onClose(); window.dispatchEvent(new Event(WALLET_CTA_CLICK_EVENT)); }}>{CASH_COPY.signIn}</button>
        </div>
      </>
    );
  }

  if (sent) {
    const base = ACTIVE_CHAIN.blockExplorers?.default.url;
    return (
      <div className="r2-body cx-sent" data-testid="cash-sent" role="status">
        <div className="r2-ok"><Check /></div>
        <div className="r2-g cx-senth">{CASH_COPY.sent(usd2(sent.recv))}</div>
        <div className="cx-sentto"><RecipientCard r={sent.to} /></div>
        <span className="cx-p14">{CASH_COPY.sentTo(usd2(sent.left))}</span>
        <div className="cx-row2">
          {base && sent.tx
            ? <a className="r2-btn" href={`${base}/tx/${sent.tx}`} target="_blank" rel="noreferrer noopener">{CASH_COPY.receipt}</a>
            : <span className="r2-btn" aria-disabled>{CASH_COPY.receipt}</span>}
          <button type="button" className="r2-btn r2-white" onClick={() => { setSent(null); onClose(); }} data-autofocus>{CASH_COPY.done}</button>
        </div>
      </div>
    );
  }

  return (
    <>
      <CashHead title={sendView ? DEPOSIT_COPY.title : CASH_COPY.title} onClose={onClose} onBack={sendView ? () => setSendView(false) : undefined} />
      <div className="r2-body">
        {!sendView && (
          <div className="cx-bals">
            <div className="cx-bal" data-testid="cash-balance">
              <span className="r2-lbl up">{CASH_COPY.yourCash}</span>
              <Amount v={balUsd} big />
            </div>
            <div className="cx-bal cx-turbo" data-testid="turbo-balance">
              <span className="r2-lbl cx-tlbl">{CASH_COPY.turboCash}</span>
              <Amount v={turbo?.usd ?? 0} big />
              {fuel && (
                <button type="button" className="cx-tback" disabled={fuelBusy} data-testid="cash-fuel-back"
                  onClick={async () => {
                    if (!fuel.toCash) { onClose(); window.location.assign(withBase("/turbo/duel")); return; }
                    setFuelErr(null); setFuelBusy(true);
                    try { await fuel.toCash(fuel.usd); void refresh(addr); } catch { setFuelErr(CASH_COPY.moveFailed); } finally { setFuelBusy(false); }
                  }}>{fuelBusy ? CASH_COPY.moving : CASH_COPY.moveBack}</button>
              )}
            </div>
          </div>
        )}
        {fuelErr && <span className="cx-help">{fuelErr}</span>}
        {sendView && <button type="button" className="cx-backlink" onClick={() => setSendView(false)} data-testid="cash-send-back">← {CASH_COPY.tabs.add}</button>}
        {!sendView && <div className="r2-tabs" role="tablist" aria-label="Cash">
          {(turbo?.canAdd ? (["add", "turbo", "out"] as const) : (["add", "out"] as const)).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => { setTab(t); setErr(null); }} data-testid={`cash-tab-${t}`}>{CASH_COPY.tabs[t]}</button>
          ))}
        </div>}
        {tab === "add" ? (
          sendView ? <SendCrypto cashAddr={addr} />
            : <CardFund addr={addr} onPaid={() => { void refresh(addr); }} onSend={() => setSendView(true)} />
        ) : tab === "turbo" ? (
          <>
            {turbo?.canWithdraw && (
              <div className="r2-chips cx-dir" role="group" aria-label="Direction">
                {(["in", "back"] as const).map((d) => (
                  <button key={d} type="button" className={dir === d ? "on" : ""} aria-pressed={dir === d} onClick={() => setDir(d)} data-testid={`cash-dir-${d}`}>{CASH_COPY.dirs[d]}</button>
                ))}
              </div>
            )}
            {dir === "back" && turbo?.canWithdraw
              ? <FromTurbo cashAddr={addr} onMoved={() => { void refresh(addr); void refreshTurboCash(); }} />
              : <ToTurbo balUsd={balUsd} feeUsd={feeUsd} min={turbo?.minIn ?? 5}
                  onMoved={() => { void refresh(addr); void refreshTurboCash(); }} />}
          </>
        ) : (
          <>
            <div>
              <div className="cx-split"><label className="r2-lbl" htmlFor="cx-amt">{CASH_COPY.howMuch}</label><span className="r2-lbl">{CASH_COPY.youHave(usd2(balUsd))}</span></div>
              <div className="r2-field cx-big">
                <span className="r2-g cx-dollar">$</span>
                <input id="cx-amt" inputMode="decimal" placeholder="0.00" value={amt} autoComplete="off" data-testid="cash-amount"
                  onChange={(e) => { setErr(null); setAmt(e.target.value.replace(/[^0-9.]/g, "")); }} />
              </div>
              <div className="r2-chips">
                {PICKS.map(([l, f]) => (
                  <button key={l} type="button" className={pickOn(f) ? "on" : ""} onClick={() => { setErr(null); setAmt((Math.floor(balUsd * f * 100) / 100).toFixed(2)); }}>{l}</button>
                ))}
              </div>
            </div>
            <UserPicker id="cx-to" value={rcpt} onChange={(r) => { setErr(null); setRcpt(r); }} me={addr} allowAddress />
            <div className="r2-box">
              <div className="r2-r"><div className="t"><b>{rcpt?.username ? CASH_COPY.theyGet : CASH_COPY.receive}</b>{gasless && quote && <span className="cx-p">{CASH_COPY.fee} {usd2(feeUsd)}</span>}</div><span className="r2-g cx-recv">{usd2(recvUsd)}</span></div>
              {gasless && quote && <div className="r2-r cx-d"><div className="t"><span>{CASH_COPY.fee}</span></div><span className="cx-fee">{usd2(feeUsd)}</span></div>}
            </div>
            {err && <div className="r2-note err" role="alert"><ErrIcon /><span>{err}</span></div>}
            <button type="button" className="r2-gold" disabled={busy || amtNum <= 0 || !rcpt} onClick={cashOut} data-testid="cash-out-btn">
              {busy ? CASH_COPY.sending : amtNum > 0 ? CASH_COPY.cashOut(usd2(amtNum)) : CASH_COPY.tabs.out}
            </button>
            <span className="cx-fine cx-final"><Warn />{CASH_COPY.fine}</span>
          </>
        )}
      </div>
    </>
  );
}
