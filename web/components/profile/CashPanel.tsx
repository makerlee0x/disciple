"use client";

import { useEffect, useState } from "react";
import { encodeFunctionData, formatUnits, isAddress, parseAbi, parseUnits } from "viem";
import { ACTIVE_CHAIN, MINTABLE_TEST_TOKENS, deployment, isDeployed } from "@/lib/chains";
import { decimalsOf, publicClient, tokenBalance } from "@/lib/protocol-viem";
import { execCalls, onWallet } from "@/lib/wallet";
import type { Address } from "@/lib/protocol";
import DsSelect from "@/components/ui/DsSelect";

const erc20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
type Row = { symbol: string; address: Address; bal: bigint; dec: number };

/** Private-profile cash: balances + deposit (your address) + withdraw (ERC-20 transfer out). */
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
      const toks = MINTABLE_TEST_TOKENS.length ? MINTABLE_TEST_TOKENS : [{ symbol: "STRATEGY", address: deployment().defaultQuote }];
      const out: Row[] = [];
      for (const t of toks) {
        const [b, d] = await Promise.all([tokenBalance(pc, t.address, a), decimalsOf(pc, t.address)]);
        out.push({ symbol: t.symbol, address: t.address, bal: b, dec: d });
      }
      setRows(out);
      setSym((s) => s || out[0]?.symbol || "");
    } catch { /* rpc hiccup */ }
  }
  useEffect(() => { if (!addr) return; void refresh(addr); const i = setInterval(() => refresh(addr), 20000); return () => clearInterval(i); }, [addr]);

  const sel = rows.find((r) => r.symbol === sym);
  async function withdraw() {
    setMsg(null);
    if (!sel || !addr) return;
    if (!isAddress(to)) return setMsg({ ok: false, text: "Enter a valid 0x destination address." });
    let amount: bigint;
    try { amount = parseUnits(amt || "0", sel.dec); } catch { return setMsg({ ok: false, text: "Invalid amount." }); }
    if (amount <= BigInt(0) || amount > sel.bal) return setMsg({ ok: false, text: "Amount must be > 0 and ≤ your balance." });
    if (!confirm(`Send ${amt} ${sel.symbol} to ${to}? This can't be undone.`)) return;
    setBusy(true);
    try {
      await execCalls([{ to: sel.address, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [to as Address, amount] }) }]);
      setMsg({ ok: true, text: `Sent ${amt} ${sel.symbol}.` }); setAmt("");
      await refresh(addr);
    } catch (e) { setMsg({ ok: false, text: (e as Error).message.split("\n")[0].slice(0, 160) }); }
    finally { setBusy(false); }
  }

  const fmt = (b: bigint, d: number) => Number(formatUnits(b, d)).toLocaleString(undefined, { maximumFractionDigits: 4 });
  return (
    <section id="cash" className="chart-card cash-panel" aria-label="Cash">
      <div className="table-head"><h3>Cash</h3><span className="muted tiny">{ACTIVE_CHAIN.name} · only visible to you</span></div>
      {!addr ? <p className="muted">Sign in (top right) to see balances and deposit.</p> : <>
        <div className="cash-balances">
          {rows.map((r) => <div key={r.symbol} className="cash-tile"><span>{r.symbol}</span><strong>{fmt(r.bal, r.dec)}</strong></div>)}
        </div>
        <div className="ds-seg" role="tablist">
          {(["deposit", "withdraw"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t === "deposit" ? "Deposit" : "Withdraw"}</button>
          ))}
        </div>
        {tab === "deposit" ? (
          <div className="cash-body">
            <p className="muted tiny">Send USDG (or any ERC-20) on {ACTIVE_CHAIN.name} to your account address:</p>
            <div className="cash-addr mono">{addr}<button type="button" className="ds-btn gold" onClick={() => { navigator.clipboard?.writeText(addr); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? "Copied" : "Copy"}</button></div>
          </div>
        ) : (
          <div className="cash-body cash-form">
            <DsSelect ariaLabel="Token" value={sym} onChange={setSym}
              options={rows.map((r) => ({ value: r.symbol, label: r.symbol, hint: fmt(r.bal, r.dec) }))} />
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
