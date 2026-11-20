"use client";
/**
 * The Turbo popup (maker 2026-11-20), opened by the Turbo pill in the Duel / Climb lobby (lib/turbo/turboPill):
 *  - Turbo cash and Cash side by side (the Cash popup's tiles, Turbo first here)
 *  - Add: Cash → Turbo, the Cash popup's To Turbo flow (lighterAddCash)
 *  - Withdraw: Turbo → Cash, the Cash popup's To Cash flow (Lighter fast withdrawal), where the venue pays out to Cash
 *  - Advanced: the player's Lighter record, newest first: fills (side, size, price, fee, realized PnL) and cash moves,
 *    each with its tx hash, read straight from Lighter (lib/server/lighter/history)
 * Never opens in a blocked country (the pill is locked there).
 */
import { useCallback, useEffect, useState } from "react";
import { formatUnits } from "viem";
import { deployment, isDeployed } from "@/lib/chains";
import { decimalsOf, publicClient, tokenBalance } from "@/lib/protocol-viem";
import { clientGaslessMode } from "@/lib/aa/sponsorshipMode";
import { gaslessSigner, onWallet } from "@/lib/wallet";
import { CASH_ARRIVED_EVENT } from "@/lib/testCash";
import type { Address } from "@/lib/protocol";
import { onTurboCash, refreshTurboCash, setTurboWallet, turboCashDev, type TurboCash } from "@/lib/turbo/turboCash";
import type { TurboTab } from "@/lib/turbo/turboPill";
import type { History, HistoryItem } from "@/lib/lighter/history";
import { CashHead, ErrIcon, usd2 } from "@/components/cash/bits";
import { Amount, FromTurbo, ToTurbo } from "@/components/cash/CashBody";
import { TURBO_MIN_IN } from "@/lib/lighter/mins";

export const TURBO_POP_COPY = {
  title: "Turbo",
  turbo: "Turbo cash",
  cash: "Cash",
  tabs: { add: "Add", out: "Withdraw", history: "Advanced" },
  filters: { all: "All", fill: "Fills", cash: "Cash" },
  empty: "Nothing yet",
  failed: (what: string) => `Couldn't load ${what}.`,
  retry: "Retry",
  account: (n: number) => `Lighter #${n}`,
  copied: "Copied",
  kinds: { deposit: "Deposit", withdraw: "Withdraw", in: "Transfer in", out: "To Cash" },
  liq: "Liquidated",
  fee: "Fee", pnl: "PnL",
} as const;
const C = TURBO_POP_COPY;

type Filter = keyof typeof C.filters;
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${usd2(Math.abs(n))}`;
const when = (ms: number) => (ms > 0 ? new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const short = (h: string) => (h.length > 14 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h);
const qty = (n: number) => (n >= 100 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n.toLocaleString("en-US", { maximumSignificantDigits: 6 }));
const px = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 1 : n >= 1 ? 3 : 6 })}`;

function Tx({ hash }: { hash: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button type="button" className="tc-tx" aria-label={`Copy tx ${hash}`} title={hash}
      onClick={() => { void navigator.clipboard?.writeText(hash).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); }).catch(() => {}); }}>
      {ok ? C.copied : short(hash)}
    </button>
  );
}

function Row({ it }: { it: HistoryItem }) {
  if (it.kind === "fill") {
    const buy = it.side === "buy";
    return (
      <li className="tc-row" data-testid="turbo-fill">
        <div className="tc-l">
          <b className={buy ? "tc-buy" : "tc-sell"}>{buy ? "Buy" : "Sell"} {it.market}{it.liq && <em className="tc-liq">{C.liq}</em>}</b>
          <span>{qty(it.size)} @ {px(it.price)}</span>
          <span className="tc-meta">{when(it.at)}{it.tx && <Tx hash={it.tx} />}</span>
        </div>
        <div className="tc-r">
          <b>{usd2(it.usd)}</b>
          {it.fee != null && <span>{C.fee} {it.fee < 0.01 && it.fee > 0 ? `<$0.01` : usd2(it.fee)}</span>}
          {it.pnl != null && it.pnl !== 0 && <span className={it.pnl > 0 ? "tc-up" : "tc-dn"}>{C.pnl} {signed(it.pnl)}</span>}
        </div>
      </li>
    );
  }
  const plus = it.kind === "deposit" || it.kind === "in";
  const pending = it.status && !/complet|success|done|claimable/i.test(it.status);
  return (
    <li className="tc-row" data-testid="turbo-move">
      <div className="tc-l">
        <b>{C.kinds[it.kind]}{pending && <em className="tc-st">{it.status!.toLowerCase()}</em>}</b>
        <span className="tc-meta">{when(it.at)}{it.tx && <Tx hash={it.tx} />}</span>
      </div>
      <div className="tc-r">
        <b className={plus ? "tc-up" : ""}>{plus ? "+" : "−"}{usd2(it.usd)}</b>
        {it.fee != null && it.fee > 0 && <span>{C.fee} {usd2(it.fee)}</span>}
      </div>
    </li>
  );
}

const SAMPLE: History = {
  account: 55687, missing: [],
  items: [
    { kind: "fill", at: Date.now() - 4 * 60_000, market: "BTC", side: "sell", size: 0.00412, price: 97184.2, usd: 400.4, fee: 0.022, pnl: 3.84, liq: false, tx: "0x8f3ac1d2e4b5a6978877665544332211aabbccddeeff00112233445566778899" },
    { kind: "fill", at: Date.now() - 5 * 60_000, market: "BTC", side: "buy", size: 0.00412, price: 96252.9, usd: 396.56, fee: 0.022, pnl: null, liq: false, tx: "0x1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d" },
    { kind: "fill", at: Date.now() - 52 * 60_000, market: "ETH", side: "buy", size: 0.121, price: 3302.15, usd: 399.56, fee: 0.022, pnl: -8.12, liq: true, tx: "0x77aa88bb99cc00dd11ee22ff33aa44bb55cc66dd77ee88ff99aa00bb11cc22dd" },
    { kind: "out", at: Date.now() - 3 * 3600_000, usd: 40, fee: 0.02, status: null, tx: "0xa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2" },
    { kind: "deposit", at: Date.now() - 26 * 3600_000, usd: 250, fee: null, status: "completed", tx: "0xdeadbeefcafebabe0011223344556677889900aabbccddeeff00112233445566" },
  ],
};

function Advanced({ wallet }: { wallet: string }) {
  const [h, setH] = useState<History | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState<Filter>("all");
  const load = useCallback(async () => {
    setErr(null);
    if (turboCashDev()) { setH(SAMPLE); return; }
    try {
      const [{ lighterFetcher }, { lighterHistory }] = await Promise.all([import("@/lib/lighter/duel"), import("@/lib/lighter/history")]);
      setH(await lighterHistory(lighterFetcher(wallet)));
    } catch (e) { setErr(((e as Error).message || "").replace(/Lighter/g, "Turbo") || C.failed("history")); }
  }, [wallet]);
  useEffect(() => { void load(); }, [load]);
  const rows = (h?.items ?? []).filter((it) => f === "all" || (f === "fill" ? it.kind === "fill" : it.kind !== "fill"));
  return (
    <div className="tc-adv" data-testid="turbo-history">
      <div className="tc-advtop">
        <div className="r2-chips tc-filters" role="group" aria-label="Show">
          {(Object.keys(C.filters) as Filter[]).map((k) => (
            <button key={k} type="button" className={f === k ? "on" : ""} aria-pressed={f === k} onClick={() => setF(k)}>{C.filters[k]}</button>
          ))}
        </div>
        {h?.account != null && <span className="tc-acct">{C.account(h.account)}</span>}
      </div>
      {err && <div className="r2-note err" role="alert"><ErrIcon /><span>{err}</span><button type="button" className="tc-retry" onClick={() => { setH(null); void load(); }}>{C.retry}</button></div>}
      {!!h?.missing.length && <div className="r2-note warn" role="status"><span>{C.failed(h.missing.join(", "))}</span><button type="button" className="tc-retry" onClick={() => { void load(); }}>{C.retry}</button></div>}
      {!h && !err ? <div className="tc-wait"><span className="r2-spin tc-spin" aria-label="Loading" /></div>
        : h && !rows.length ? <div className="tc-empty">{C.empty}</div>
        : <ul className="tc-list">{rows.map((it, i) => <Row key={`${it.kind}-${it.at}-${i}`} it={it} />)}</ul>}
    </div>
  );
}

export default function TurboCashBody({ onClose, initialTab = "add" }: { onClose: () => void; initialTab?: TurboTab }) {
  const [addr, setAddr] = useState<Address | null>(null);
  const [cash, setCash] = useState(0);
  const [turbo, setTurbo] = useState<TurboCash | null>(null);
  const [tab, setTab] = useState<TurboTab>(initialTab);
  const [feeUsd, setFeeUsd] = useState(0);
  useEffect(() => onWallet(setAddr), []);
  useEffect(() => onTurboCash(setTurbo), []);
  useEffect(() => { setTurboWallet(addr); }, [addr]);

  // Cash (USDG) and the gasless cash-out fee, as the Cash popup reads them
  const readCash = useCallback(async (a: Address) => {
    const dev = process.env.NODE_ENV !== "production" ? (window as unknown as { __portfolioDev?: { cashUsd: number } }).__portfolioDev : undefined;
    if (dev) { setCash(dev.cashUsd); return; }
    if (!isDeployed()) return;
    try {
      const pc = publicClient(); const usdg = deployment().usdg as Address;
      const [b, d] = await Promise.all([tokenBalance(pc, usdg, a), decimalsOf(pc, usdg)]);
      setCash(Number(formatUnits(b, d)));
    } catch { /* keep the last read */ }
  }, []);
  useEffect(() => {
    if (!addr) return;
    void readCash(addr);
    const i = setInterval(() => readCash(addr), 20000);
    const f = () => { void readCash(addr); };
    window.addEventListener(CASH_ARRIVED_EVENT, f);
    return () => { clearInterval(i); window.removeEventListener(CASH_ARRIVED_EVENT, f); };
  }, [addr, readCash]);
  useEffect(() => {
    if (!addr || !clientGaslessMode()) return;
    let alive = true;
    import("@/lib/trade/gaslessWithdrawClient").then(({ quoteGaslessWithdraw }) => quoteGaslessWithdraw({ signer: addr }))
      .then((q) => { if (alive) setFeeUsd(Number(formatUnits(q.fee, q.usdgDecimals))); })
      .catch(() => { if (alive) setFeeUsd(0); });
    return () => { alive = false; };
  }, [addr]);

  const canOut = !!turbo?.canWithdraw;
  useEffect(() => { if (tab === "out" && turbo && !canOut) setTab("add"); }, [tab, turbo, canOut]);
  const moved = () => { if (addr) void readCash(addr); void refreshTurboCash(); };
  const owner = addr ? (gaslessSigner()?.address ?? addr).toLowerCase() : null;
  const tabs = (canOut ? ["add", "out", "history"] : ["add", "history"]) as TurboTab[];

  return (
    <>
      <CashHead title={C.title} onClose={onClose} />
      <div className="r2-body tc-body">
        <div className="cx-bals">
          <div className="cx-bal cx-turbo" data-testid="turbo-pop-balance">
            <span className="r2-lbl cx-tlbl">{C.turbo}</span>
            <Amount v={turbo?.usd ?? 0} big />
          </div>
          <div className="cx-bal" data-testid="turbo-pop-cash">
            <span className="r2-lbl up">{C.cash}</span>
            <Amount v={cash} big />
          </div>
        </div>
        <div className="r2-tabs" role="tablist" aria-label="Turbo">
          {tabs.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)} data-testid={`turbo-tab-${t}`}>{C.tabs[t]}</button>
          ))}
        </div>
        {!addr || !owner ? null
          : tab === "history" ? <Advanced wallet={owner} />
          : tab === "out" && canOut ? <FromTurbo cashAddr={addr} onMoved={moved} />
          : <ToTurbo balUsd={cash} feeUsd={feeUsd} min={turbo?.minIn ?? TURBO_MIN_IN} onMoved={moved} />}
      </div>
    </>
  );
}
