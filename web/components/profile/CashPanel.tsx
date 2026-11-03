"use client";

import { useEffect, useState } from "react";
import { encodeFunctionData, formatUnits, isAddress, parseAbi, parseUnits } from "viem";
import { deployment, isDeployed } from "@/lib/chains";
import { decimalsOf, publicClient, tokenBalance } from "@/lib/protocol-viem";
import { execCalls, onWallet } from "@/lib/wallet";
import { playerError } from "@/lib/playerError";
import type { Address } from "@/lib/protocol";
import TestCashButton from "@/components/TestCashButton";
import { CASH_ARRIVED_EVENT } from "@/lib/testCash";
import { OPEN_CASH_EVENT } from "@/lib/cashLink";

const erc20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
type Row = { symbol: string; address: Address; bal: bigint; dec: number };

/** COPY PENDING LEE APPROVAL (new / changed strings, Oct 30). */
export const CASH_COPY = {
  sub: "Only visible to you",
  depositHow: "Send USDG to your account address:",
  confirm: (amt: string, to: string) => `Send $${amt} to ${to}? This can't be undone.`,
  sent: (amt: string) => `Sent $${amt}.`,
};

/**
 * Cash on /wallet (moved out of the profile's Settings popup, lee Oct 30): the dollar balance (USDG) + Deposit (your
 * address) + Withdraw (USDG transfer out). Dollars only: players never see the pair token's balance or the network name.
 */
export default function CashPanel() {
  const [addr, setAddr] = useState<Address | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [sym, setSym] = useState("");
  const [to, setTo] = useState("");
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => onWallet(setAddr), []);

  async function refresh(a: Address) {
    if (!isDeployed()) return;
    try {
      const pc = publicClient();
      const usdg = deployment().usdg as Address;
      const [b, d] = await Promise.all([tokenBalance(pc, usdg, a), decimalsOf(pc, usdg)]);
      setRows([{ symbol: "USDG", address: usdg, bal: b, dec: d }]);
      setSym("USDG");
    } catch { /* rpc hiccup */ }
  }
  useEffect(() => {
    if (!addr) return;
    void refresh(addr);
    const i = setInterval(() => refresh(addr), 20000);
    const cash = () => { void refresh(addr); };   // "Get test cash" landed
    window.addEventListener(CASH_ARRIVED_EVENT, cash);
    return () => { clearInterval(i); window.removeEventListener(CASH_ARRIVED_EVENT, cash); };
  }, [addr]);
  // a Deposit link clicked while already on /wallet (lib/cashLink onDepositClick): show the Deposit tab
  useEffect(() => {
    const dep = () => setTab("deposit");
    window.addEventListener(OPEN_CASH_EVENT, dep);
    return () => window.removeEventListener(OPEN_CASH_EVENT, dep);
  }, []);

  const sel = rows.find((r) => r.symbol === sym);
  async function withdraw() {
    setMsg(null);
    if (!sel || !addr) return;
    if (!isAddress(to)) return setMsg({ ok: false, text: "Enter a valid 0x destination address." });
    let amount: bigint;
    try { amount = parseUnits(amt || "0", sel.dec); } catch { return setMsg({ ok: false, text: "Invalid amount." }); }
    if (amount <= BigInt(0) || amount > sel.bal) return setMsg({ ok: false, text: "Amount must be > 0 and ≤ your balance." });
    if (!confirm(CASH_COPY.confirm(amt, to))) return;
    setBusy(true);
    try {
      await execCalls([{ to: sel.address, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [to as Address, amount] }) }]);
      setMsg({ ok: true, text: CASH_COPY.sent(amt) }); setAmt("");
      await refresh(addr);
    } catch (e) { setMsg({ ok: false, text: playerError(e) }); }
    finally { setBusy(false); }
  }

  const usd = (b: bigint, d: number) => Number(formatUnits(b, d)).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <section id="cash" className="chart-card cash-panel" aria-label="Cash">
      <div className="table-head"><h3>Cash</h3><span className="muted tiny">{CASH_COPY.sub}</span></div>
      {!addr ? <p className="muted">Sign in to see this.</p> : <>
        <div className="cash-balances">
          {/* dollars only: "Cash $0.00" (no pair-token balance) */}
          {rows.map((r) => <div key={r.symbol} className="cash-tile" data-testid="cash-balance"><span>Cash</span><strong>{usd(r.bal, r.dec)}</strong></div>)}
        </div>
        <div className="ds-seg" role="tablist">
          {(["deposit", "withdraw"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t === "deposit" ? "Deposit" : "Withdraw"}</button>
          ))}
        </div>
        {tab === "deposit" ? (
          <div className="cash-body">
            <p className="muted tiny">{CASH_COPY.depositHow}</p>
            <div className="cash-addr mono">{addr}<button type="button" className="ds-btn gold" onClick={() => { navigator.clipboard?.writeText(addr); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? "Copied" : "Copy"}</button></div>
            <TestCashButton account={addr} className="ds-btn gold" />
          </div>
        ) : (
          <div className="cash-body cash-form">
            <input className="ds-input" placeholder="Amount" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} />
            {sel && <button type="button" className="ds-btn" onClick={() => setAmt(formatUnits(sel.bal, sel.dec))}>Max</button>}
            <input className="ds-input wide" placeholder="Destination 0x…" value={to} onChange={(e) => setTo(e.target.value.trim())} />
            <button type="button" className="ds-btn gold" disabled={busy} onClick={withdraw}>{busy ? "Sending…" : "Withdraw"}</button>
          </div>
        )}
        {msg && <p role={msg.ok ? "status" : "alert"} className={`ds-msg ${msg.ok ? "ok" : "bad"}`}>{msg.text}</p>}
      </>}
    </section>
  );
}
