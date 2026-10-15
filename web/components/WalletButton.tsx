"use client";

import { useEffect, useState } from "react";
import { formatUnits, parseAbi, parseUnits } from "viem";
import { ACTIVE_CHAIN, GAS_FAUCET, MINTABLE_TEST_TOKENS, isDeployed } from "@/lib/chains";
import { decimalsOf, publicClient, tokenBalance } from "@/lib/protocol-viem";
import { connectWallet, getSigner, hasWallet, onWallet } from "@/lib/wallet";
import type { Address } from "@/lib/protocol";

const mintAbi = parseAbi(["function mint(address to, uint256 amount)"]);

/** Connect (adds/switches to the active chain) + testnet "Get test funds" (public mint on test quote tokens). */
export default function WalletButton() {
  const [addr, setAddr] = useState<Address | null>(null);
  const [busy, setBusy] = useState("");
  const [bal, setBal] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => onWallet(setAddr), []);

  async function refresh(a: Address) {
    try {
      const pc = publicClient();
      const eth = await pc.getBalance({ address: a });
      const parts = [`${Number(formatUnits(eth, 18)).toFixed(4)} ETH`];
      for (const t of MINTABLE_TEST_TOKENS) {
        const [b, d] = await Promise.all([tokenBalance(pc, t.address, a), decimalsOf(pc, t.address)]);
        parts.push(`${Number(formatUnits(b, d)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${t.symbol}`);
      }
      setBal(parts.join(" · "));
    } catch { /* ignore */ }
  }
  useEffect(() => { if (addr) refresh(addr); }, [addr]);

  async function connect() {
    setErr("");
    if (!hasWallet()) { setErr("No browser wallet found. Install MetaMask/Rabby."); return; }
    try { setBusy("connecting"); await connectWallet(); } catch (e) { setErr((e as Error).message.slice(0, 120)); } finally { setBusy(""); }
  }

  async function getFunds() {
    setErr("");
    try {
      const w = await getSigner();
      const pc = publicClient();
      for (const t of MINTABLE_TEST_TOKENS) {
        setBusy(`minting ${t.symbol}`);
        const d = await decimalsOf(pc, t.address);
        const h = await w.writeContract({ chain: ACTIVE_CHAIN, account: w.account.address, address: t.address, abi: mintAbi, functionName: "mint", args: [w.account.address, parseUnits(t.amount, d)] });
        await pc.waitForTransactionReceipt({ hash: h });
      }
      await refresh(w.account.address);
    } catch (e) { setErr((e as Error).message.split("\n")[0].slice(0, 140)); } finally { setBusy(""); }
  }

  if (!isDeployed()) return null;
  const pill = { all: "unset" as const, cursor: "pointer", padding: "5px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700, letterSpacing: ".04em" };
  return (
    <div aria-label="wallet" style={{ position: "fixed", top: 10, right: 12, zIndex: 60, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4,
      fontFamily: "ui-monospace,monospace", color: "#eef0ff" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ fontSize: 10, opacity: 0.7 }}>{ACTIVE_CHAIN.name}</span>
        {addr ? (
          <>
            {MINTABLE_TEST_TOKENS.length > 0 && (
              <button type="button" disabled={!!busy} onClick={getFunds} style={{ ...pill, background: "#2a3a7a", color: "#cfe0ff" }}>
                {busy || "Get test funds"}
              </button>
            )}
            <span style={{ ...pill, cursor: "default", background: "rgba(31,111,74,.9)", color: "#c8ffe4" }}>{addr.slice(0, 6)}…{addr.slice(-4)}</span>
          </>
        ) : (
          <button type="button" onClick={connect} disabled={!!busy} style={{ ...pill, background: "#ffe7a3", color: "#1a1630" }}>
            {busy || "Connect wallet"}
          </button>
        )}
      </div>
      {addr && bal && <span style={{ fontSize: 10, opacity: 0.8 }}>{bal} · <a href={GAS_FAUCET} target="_blank" rel="noreferrer" style={{ color: "#ffe7a3" }}>ETH faucet</a></span>}
      {err && <span role="alert" style={{ fontSize: 10, color: "#ffb0c0", maxWidth: 320, textAlign: "right" }}>{err}</span>}
    </div>
  );
}
