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
 */
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { qrMatrix, qrPath } from "@/lib/qr";
import { CashHead, Check, ErrIcon, Warn, usd2 } from "./bits";

const erc20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

export const CASH_COPY = {
  title: "Cash",
  yourCash: "Your cash",
  balSub: "What boosts spend and dumps pay back.",
  tabs: { add: "Add cash", out: "Cash out" },
  addTitle: "Send USDG to your cash address",
  addBody: "From an exchange or another wallet, on Robinhood Chain. It shows up as cash when it lands.",
  addBodyPhone: "Send USDG on Robinhood Chain to this address. It shows up as cash when it lands.",
  addrLabel: "Your cash address",
  copy: "Copy", copied: "Copied", copyAddr: "Copy address",
  warn: "Only USDG on Robinhood Chain counts as cash. Other coins or networks won't show up here.",
  warnPhone: "Only USDG on Robinhood Chain counts as cash.",
  howMuch: "How much",
  youHave: (v: string) => `You have ${v}`,
  sendTo: "Send to",
  paste: "Paste",
  sendHelp: "An exchange deposit address or your own wallet, on Robinhood Chain.",
  receive: "You receive",
  fee: "Network fee",
  cashOut: (v: string) => `Cash out ${v}`,
  sending: "Sending…",
  fine: "Sent cash can't be pulled back, so check the address.",
  sent: (v: string) => `${v} sent`,
  sentTo: (to: string, left: string) => <>To <span className="r2-mono cx-sentaddr">{to}</span>. Your cash is now {left}.</>,
  receipt: "View receipt",
  done: "Done",
  badAddr: "That address doesn't look right. It starts with 0x and has 42 characters.",
  down: "Cash out is down for a moment. Nothing was sent. Try again in a few minutes.",
  tooMuch: (v: string) => `That's more than you have. You can cash out up to ${v}.`,
  tooLittle: (v: string) => `That's below the smallest cash out. Try more than ${v}.`,
  signInTitle: "Sign in to add cash",
  signInBody: "Email, Google, X or a wallet. Your cash lives in your own account.",
  signIn: "Sign in",
} as const;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const PICKS = [["25%", 0.25], ["40%", 0.4], ["Half", 0.5], ["All", 1]] as const;

function Qr({ text }: { text: string }) {
  const p = useMemo(() => { try { return qrPath(qrMatrix(text)); } catch { return null; } }, [text]);
  return (
    <div className="cx-qr" role="img" aria-label="QR code of your cash address">
      {p && <svg viewBox={`0 0 ${p.size} ${p.size}`} shapeRendering="crispEdges" aria-hidden><path d={p.d} fill="#121327" /></svg>}
    </div>
  );
}

function Amount({ v, big }: { v: number; big?: boolean }) {
  const [w, c] = usd2(v).split(".");
  return <div className={`cx-amt${big ? "" : " sm"}`}>{w}<small>.{c}</small></div>;
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
  const [to, setTo] = useState("");
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<{ recv: number; to: string; left: number; tx: Hex | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const [quote, setQuote] = useState<{ fee: bigint; minAmount: bigint; feeTo: string; usdgDecimals: number } | null>(null);
  useEffect(() => onWallet(setAddr), []);

  const refresh = useCallback(async (a: Address) => {
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
    const f = (e: Event) => { const t = (e as CustomEvent<{ tab?: CashTab } | null>).detail?.tab; setSent(null); setTab(t ?? "add"); };
    window.addEventListener(OPEN_CASH_EVENT, f);
    return () => window.removeEventListener(OPEN_CASH_EVENT, f);
  }, []);

  const gasless = clientGaslessMode();
  useEffect(() => {
    if (!gasless || tab !== "out" || !addr) return;
    let alive = true;
    import("@/lib/trade/gaslessWithdrawClient").then(({ quoteGaslessWithdraw }) => quoteGaslessWithdraw({ signer: addr }))
      .then((q) => { if (alive) setQuote({ fee: q.fee, minAmount: q.minAmount, feeTo: q.feeTo, usdgDecimals: q.usdgDecimals }); })
      .catch(() => { if (alive) setQuote(null); });
    return () => { alive = false; };
  }, [gasless, tab, addr]);

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
        setSent({ recv, to, left: Math.max(0, balUsd - amtNum), tx: res.txHash });
      } else {
        const tx = await execCalls([{ to: bal.token, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [to as Address, amount] }) }]);
        setSent({ recv: amtNum, to, left: Math.max(0, balUsd - amtNum), tx: tx.txHash });
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
          <span className="cx-p14">{CASH_COPY.signInBody}</span>
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
        <span className="cx-p14">{CASH_COPY.sentTo(short(sent.to), usd2(sent.left))}</span>
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
      <CashHead title={CASH_COPY.title} onClose={onClose} />
      <div className="r2-body">
        {tab === "add" && (
          <div className="cx-bal" data-testid="cash-balance">
            <span className="r2-lbl up">{CASH_COPY.yourCash}</span>
            <Amount v={balUsd} big />
            <span className="cx-balsub">{CASH_COPY.balSub}</span>
          </div>
        )}
        <div className="r2-tabs" role="tablist" aria-label="Cash">
          {(["add", "out"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => { setTab(t); setErr(null); }} data-testid={`cash-tab-${t}`}>{CASH_COPY.tabs[t]}</button>
          ))}
        </div>
        {tab === "add" ? (
          <>
            <div className="cx-addhow">
              <Qr text={addr} />
              <div className="cx-addtxt">
                <b className="cx-d">{CASH_COPY.addTitle}</b>
                <span className="cx-d">{CASH_COPY.addBody}</span>
                <span className="cx-p">{CASH_COPY.addBodyPhone}</span>
              </div>
            </div>
            <div className="cx-d">
              <label className="r2-lbl" htmlFor="cx-addr">{CASH_COPY.addrLabel}</label>
              <div className="cx-inrow">
                <input id="cx-addr" className="r2-field r2-mono cx-addr" readOnly value={addr} onFocus={(e) => e.currentTarget.select()} data-testid="cash-address" />
                <button type="button" className="r2-btn r2-white cx-copy" onClick={() => { navigator.clipboard?.writeText(addr); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? CASH_COPY.copied : CASH_COPY.copy}</button>
              </div>
            </div>
            <div className="cx-p r2-field r2-mono cx-addrwrap">{addr}</div>
            <button type="button" className="cx-p r2-gold" onClick={() => { navigator.clipboard?.writeText(addr); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? CASH_COPY.copied : CASH_COPY.copyAddr}</button>
            <div className="r2-note warn"><Warn /><span><span className="cx-d">{CASH_COPY.warn}</span><span className="cx-p">{CASH_COPY.warnPhone}</span></span></div>
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
            <div>
              <label className="r2-lbl" htmlFor="cx-to">{CASH_COPY.sendTo}</label>
              <div className="cx-inrow">
                <input id="cx-to" className="r2-field r2-mono cx-addr" placeholder="0x…" value={to} autoComplete="off" spellCheck={false} data-testid="cash-to"
                  onChange={(e) => { setErr(null); setTo(e.target.value.trim()); }} />
                <button type="button" className="r2-btn cx-copy" onClick={async () => { try { const t = await navigator.clipboard.readText(); if (t) { setErr(null); setTo(t.trim()); } } catch { /* no clipboard read */ } }}>{CASH_COPY.paste}</button>
              </div>
              <span className="cx-help cx-d">{CASH_COPY.sendHelp}</span>
            </div>
            <div className="r2-box">
              <div className="r2-r"><div className="t"><b>{CASH_COPY.receive}</b>{gasless && quote && <span className="cx-p">{CASH_COPY.fee} {usd2(feeUsd)}</span>}</div><span className="r2-g cx-recv">{usd2(recvUsd)}</span></div>
              {gasless && quote && <div className="r2-r cx-d"><div className="t"><span>{CASH_COPY.fee}</span></div><span className="cx-fee">{usd2(feeUsd)}</span></div>}
            </div>
            {err && <div className="r2-note err" role="alert"><ErrIcon /><span>{err}</span></div>}
            <button type="button" className="r2-gold" disabled={busy || amtNum <= 0} onClick={cashOut} data-testid="cash-out-btn">
              {busy ? CASH_COPY.sending : amtNum > 0 ? CASH_COPY.cashOut(usd2(amtNum)) : CASH_COPY.tabs.out}
            </button>
            <span className="cx-fine cx-d">{CASH_COPY.fine}</span>
          </>
        )}
      </div>
    </>
  );
}
