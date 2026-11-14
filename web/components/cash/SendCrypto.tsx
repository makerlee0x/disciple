"use client";
/**
 * Send crypto instead (Add cash board 3, maker signed off 2026-11-14): What are you sending? → From which network? →
 * QR + address + Copy → "I sent it". Any coin Privy's deposit config supports turns into USDG in the player's cash
 * (lib/deposit). USDG on our own chain is the plain cash address, no swap. The only place in Cash that names a coin or
 * a network, and only because the player has to pick what they hold.
 */
import { useEffect, useMemo, useState } from "react";
import { ACTIVE_CHAIN, deployment, isDeployed } from "@/lib/chains";
import { qrMatrix, qrPath } from "@/lib/qr";
import { CASH_ARRIVED_EVENT } from "@/lib/testCash";
import {
  DEPOSIT_COPY as D, coinsFor, depositAddress, depositConfig, netsFor, routeFor, waitForDeposit,
  type CoinId, type DepositAddress, type DepositConfigLike,
} from "@/lib/deposit";
import { Check, ErrIcon, Warn } from "./bits";

const RH = `eip155:${ACTIVE_CHAIN.id}`;

export function Qr({ text }: { text: string }) {
  const p = useMemo(() => { try { return qrPath(qrMatrix(text)); } catch { return null; } }, [text]);
  return (
    <div className="cx-qr" role="img" aria-label="QR code of your deposit address">
      {p && <svg viewBox={`0 0 ${p.size} ${p.size}`} shapeRendering="crispEdges" aria-hidden><path d={p.d} fill="#121327" /></svg>}
    </div>
  );
}

const short = (a: string) => (a.length > 16 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export default function SendCrypto({ cashAddr }: { cashAddr: string }) {
  const [cfg, setCfg] = useState<DepositConfigLike | null | undefined>(undefined);   // undefined = loading
  const [coin, setCoin] = useState<CoinId>("USDC");
  const [netId, setNetId] = useState<string>("base");
  const [dep, setDep] = useState<{ key: string; a: DepositAddress } | null>(null);
  const [making, setMaking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [watch, setWatch] = useState<null | "watching" | "done" | "refunded" | "slow">(null);

  useEffect(() => { let a = true; depositConfig().then((c) => { if (a) setCfg(c); }); return () => { a = false; }; }, []);
  // no config (deposits off / Privy not loaded): only USDG on our chain works
  const off = cfg === null;
  const coins = off ? (["USDG"] as CoinId[]) : coinsFor(cfg ?? null, RH);
  const curCoin = coins.includes(coin) ? coin : coins[0];
  const nets = useMemo(() => netsFor(curCoin, off ? { currencies: [] } : cfg ?? null, RH), [curCoin, cfg, off]);
  const net = nets.find((n) => n.id === netId) ?? nets[0];
  const route = net ? routeFor(curCoin, net, cfg ?? null, RH) : null;
  const key = route ? `${route.coin}|${route.net.caip2}` : "";

  // a fresh deposit address for a swap route (one per pick)
  useEffect(() => {
    if (!route || route.direct || !route.sourceCurrency || !isDeployed()) return;
    if (dep?.key === key) return;
    let a = true;
    setMaking(true); setErr(null); setWatch(null);
    depositAddress({ sourceChain: route.net.caip2, sourceCurrency: route.sourceCurrency, destinationChain: RH,
      destinationCurrency: deployment().usdg as string, destinationAddress: cashAddr })
      .then((d) => { if (a) setDep({ key, a: d }); })
      .catch(() => { if (a) setErr(D.unavailable); })
      .finally(() => { if (a) setMaking(false); });
    return () => { a = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = route?.direct ? cashAddr : dep?.key === key ? dep.a.address : null;
  const etaMin = !route?.direct && dep?.key === key && dep.a.etaSec > 0 ? Math.max(1, Math.round(dep.a.etaSec / 60)) : null;

  const sent = () => {
    if (!route || route.direct || !dep || dep.key !== key) { setWatch("watching"); return; }
    setWatch("watching");
    waitForDeposit(dep.a).then((o) => {
      if (o.status === "completed") {
        setWatch("done");
        dispatchEvent(new Event(CASH_ARRIVED_EVENT));
      } else setWatch(o.status === "refunded" || o.status === "failed" ? "refunded" : "slow");
    }).catch(() => setWatch("slow"));
  };

  return (
    <div className="cx-send" data-testid="cash-send-crypto">
      <div>
        <span className="r2-lbl">{D.coinQ}</span>
        <div className="r2-chips cx-coins" role="group" aria-label="Coin">
          {coins.map((c) => <button key={c} type="button" className={c === curCoin ? "on" : ""} aria-pressed={c === curCoin} onClick={() => { setCoin(c); setWatch(null); }} data-testid={`send-coin-${c}`}>{c}</button>)}
        </div>
      </div>
      <div>
        <span className="r2-lbl">{D.netQ}</span>
        <div className="r2-chips cx-nets" role="group" aria-label="Network">
          {nets.map((n) => <button key={n.id} type="button" className={n.id === net?.id ? "on" : ""} aria-pressed={n.id === net?.id} onClick={() => { setNetId(n.id); setWatch(null); }} data-testid={`send-net-${n.id}`}>{n.name}</button>)}
        </div>
      </div>

      <div className="r2-box cx-depbox">
        {shown ? <Qr text={shown} /> : <div className="cx-qr cx-qrwait" aria-hidden />}
        <div className="cx-addtxt">
          <span>{net ? D.addrLabel(curCoin, net.name) : ""}</span>
          <span className="r2-mono cx-depaddr" data-testid="send-address" title={shown ?? undefined}>{shown ? short(shown) : making ? D.making : cfg === undefined ? D.making : "—"}</span>
          <button type="button" className="r2-btn r2-white cx-depcopy" disabled={!shown}
            onClick={() => { if (!shown) return; navigator.clipboard?.writeText(shown); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? D.copied : D.copy}</button>
        </div>
      </div>

      {err ? <div className="r2-note err" role="alert"><ErrIcon /><span>{err}</span></div> : off && <div className="r2-note warn"><Warn /><span>{D.unavailable}</span></div>}
      {net && <div className="cx-depnote">
        <span>{route?.direct ? D.direct : etaMin ? D.turnsEta(etaMin) : D.turns}</span>
        <span className="cx-help">{route?.direct ? D.directWarn(net.name) : D.fee(curCoin, net.name)}</span>
      </div>}

      {watch == null ? <button type="button" className="r2-btn cx-wide" disabled={!shown} onClick={sent} data-testid="send-sent">{D.sent}</button>
        : <div className={`r2-note ${watch === "done" ? "ok" : watch === "refunded" ? "err" : "warn"}`} role="status" data-testid="send-status">
          {watch === "done" ? <Check size={16} /> : null}
          <span>{watch === "done" ? D.done : watch === "watching" ? D.watching : watch === "refunded" ? D.refunded : D.slow}</span>
        </div>}
    </div>
  );
}
