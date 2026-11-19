"use client";
/**
 * Send sheet (maker 2026-11-19): give a rocket bag to another pilot by @username. Same round 2 popup as
 * Cash: centred on desktop, full screen with a back arrow on phones. Opens on OPEN_SEND_EVENT (lib/send/open).
 *  - Rocket: dollars with 25% / 40% / Half / All, the token count they get, the network fee, "Can't be undone".
 *  - Items never send here: they only change hands on the market, which takes its fee (maker 2026-11-19).
 * Cash (USDG) sends live in the Cash popup's Send tab with the same picker.
 */
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Sheet from "@/components/profile/Sheet";
import { CashHead, Check, ErrIcon, Warn, usd2 } from "@/components/cash/bits";
import UserPicker, { RecipientCard } from "@/components/ui/UserPicker";
import { OPEN_SEND_EVENT, type SendAsset } from "@/lib/send/open";
import { rememberRecipient, type Recipient } from "@/lib/send/recipient";
import { onWallet } from "@/lib/wallet";
import { fmtTokens } from "@/lib/pnl";
import { withBase } from "@/lib/base-path";
import { playerError } from "@/lib/playerError";

export const SEND_COPY = {
  title: "Send",
  howMuch: "How much",
  bag: (v: string) => `Bag ${v}`,
  theyGet: "They get",
  fee: "Network fee",
  free: "Free",
  send: (what: string) => `Send ${what}`,
  sending: "Sending…",
  fine: "Can't be undone",
  sent: (what: string) => `${what} sent`,
  done: "Done",
  tooMuch: "That's more than your bag.",
} as const;

const PICKS = [["25%", 0.25], ["40%", 0.4], ["Half", 0.5], ["All", 1]] as const;
// dev only (screenshots): a send that "lands" with no chain
const devSend = () => process.env.NODE_ENV !== "production" && typeof window !== "undefined" && !!(window as unknown as { __sendDev?: unknown }).__sendDev;

function RocketSend({ a, me, onSent }: { a: SendAsset; me: string | null; onSent: (what: string, to: Recipient) => void }) {
  const bagUsd = a.tokens * a.priceUsd;
  const [amt, setAmt] = useState("");
  const [to, setTo] = useState<Recipient | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const n = Number(amt) || 0;
  const tokens = a.priceUsd > 0 ? Math.min(a.tokens, n / a.priceUsd) : 0;
  const feeUsd = 0.02; // the gasless relay quote replaces this when wired
  const pickOn = (f: number) => amt !== "" && Math.abs(Math.floor(bagUsd * f * 100) / 100 - n) < 0.005;
  const go = async () => {
    setErr(null);
    if (n > bagUsd + 0.005) return setErr(SEND_COPY.tooMuch);
    if (!to) return;
    setBusy(true);
    try {
      if (!devSend()) throw new Error("Sending rockets is coming soon.");
      await new Promise((r) => setTimeout(r, 500));
      onSent(`${fmtTokens(tokens)} $${a.symbol}`, to);
    } catch (e) { setErr(playerError(e)); } finally { setBusy(false); }
  };
  const logo = a.icon ? (/^https?:|^\/api\//.test(a.icon) ? a.icon : withBase(a.icon)) : null;
  return (
    <>
      <div className="sd-asset">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <span className="sd-coin">{logo ? <img src={logo} alt="" width={44} height={44} /> : a.symbol.slice(0, 1)}</span>
        <span className="sd-at"><b>{a.name}</b><span>${a.symbol}</span></span>
        <span className="sd-bag">{SEND_COPY.bag(usd2(bagUsd))}</span>
      </div>
      <div>
        <label className="r2-lbl" htmlFor="sd-amt">{SEND_COPY.howMuch}</label>
        <div className="r2-field cx-big">
          <span className="r2-g cx-dollar">$</span>
          <input id="sd-amt" inputMode="decimal" placeholder="0.00" value={amt} autoComplete="off" data-testid="send-amount"
            onChange={(e) => { setErr(null); setAmt(e.target.value.replace(/[^0-9.]/g, "")); }} />
        </div>
        <div className="r2-chips">
          {PICKS.map(([l, f]) => (
            <button key={l} type="button" className={pickOn(f) ? "on" : ""} onClick={() => { setErr(null); setAmt((Math.floor(bagUsd * f * 100) / 100).toFixed(2)); }}>{l}</button>
          ))}
        </div>
      </div>
      <UserPicker id="sd-to" value={to} onChange={setTo} me={me} />
      <div className="r2-box">
        <div className="r2-r"><div className="t"><b>{SEND_COPY.theyGet}</b></div><span className="r2-g cx-recv">{fmtTokens(tokens)} <small className="sd-sym">${a.symbol}</small></span></div>
        <div className="r2-r"><div className="t"><span>{SEND_COPY.fee}</span></div><span className="cx-fee">{usd2(feeUsd)}</span></div>
      </div>
      {err && <div className="r2-note err" role="alert"><ErrIcon /><span>{err}</span></div>}
      <button type="button" className="r2-gold" disabled={busy || n <= 0 || !to} onClick={go} data-testid="send-btn">
        {busy ? SEND_COPY.sending : SEND_COPY.send(`$${a.symbol}`)}
      </button>
      <span className="cx-fine cx-final"><Warn />{SEND_COPY.fine}</span>
    </>
  );
}

export default function SendHost() {
  const [a, setA] = useState<SendAsset | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [sent, setSent] = useState<{ what: string; to: Recipient } | null>(null);
  const path = usePathname();
  useEffect(() => onWallet(setMe), []);
  useEffect(() => {
    const f = (e: Event) => { setSent(null); setA((e as CustomEvent<SendAsset>).detail); };
    window.addEventListener(OPEN_SEND_EVENT, f);
    return () => window.removeEventListener(OPEN_SEND_EVENT, f);
  }, []);
  useEffect(() => { setA(null); }, [path]);
  const close = () => { setA(null); setSent(null); };
  return (
    <Sheet open={a != null} onClose={close} label="Send" className="r2-modal cx-sheet" testId="send-popup">
      {a && (sent ? (
        <div className="r2-body cx-sent" data-testid="send-sent" role="status">
          <div className="r2-ok"><Check /></div>
          <div className="r2-g cx-senth sd-senth">{SEND_COPY.sent(sent.what)}</div>
          <div className="cx-sentto"><RecipientCard r={sent.to} /></div>
          <button type="button" className="r2-btn r2-white cx-wide" onClick={close} data-autofocus>{SEND_COPY.done}</button>
        </div>
      ) : (
        <>
          <CashHead title={SEND_COPY.title} onClose={close} />
          <div className="r2-body">
            <RocketSend key={a.coin} a={a} me={me} onSent={(what, to) => { rememberRecipient(to); setSent({ what, to }); }} />
          </div>
        </>
      ))}
    </Sheet>
  );
}
