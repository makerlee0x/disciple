"use client";

import { useEffect, useState } from "react";
import { encodeFunctionData, formatUnits, parseAbi, parseUnits } from "viem";
import { ACTIVE_CHAIN, GAS_FAUCET, MINTABLE_TEST_TOKENS, deployment, isDeployed } from "@/lib/chains";
import { decimalsOf, publicClient, tokenBalance } from "@/lib/protocol-viem";
import {
  aaAvailable, activeAddress, connectSmartEmail, connectSmartGoogle, connectSmartWithWallet, connectWallet, disconnect,
  execCalls, hasWallet, isSmartMode, onWallet, restoreSmart,
} from "@/lib/wallet";
import { DEV_WALLETS, SPONSOR, aaSession, emailStart, onGasMode } from "@/lib/aa/session";
import type { Address } from "@/lib/protocol";

const mintAbi = parseAbi(["function mint(address to, uint256 amount)"]);

/**
 * Sign in once → embedded smart account (LightAccount v2) → one-tap gasless trades.
 * Options: email (OTP) / Google via Account Kit signer, or an existing wallet as owner (one signature).
 * Legacy "plain wallet" path kept as fallback (one tx per action).
 */
export default function WalletButton() {
  const [addr, setAddr] = useState<Address | null>(null);
  const [busy, setBusy] = useState("");
  const [eth, setEth] = useState<bigint | null>(null);
  const [bal, setBal] = useState("");
  const [err, setErr] = useState("");
  const [menu, setMenu] = useState(false);
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState<null | string>(null);
  const [selfPay, setSelfPay] = useState(!SPONSOR);
  const [copied, setCopied] = useState(false);
  useEffect(() => onWallet(setAddr), []);
  useEffect(() => { restoreSmart().catch(() => {}); }, []);
  useEffect(() => onGasMode((m) => setSelfPay(m === "self-pay")), []);

  async function refresh(a: Address) {
    try {
      const pc = publicClient();
      const e = await pc.getBalance({ address: a });
      setEth(e);
      const parts = [`${Number(formatUnits(e, 18)).toFixed(4)} ETH`];
      const syms = MINTABLE_TEST_TOKENS.length ? MINTABLE_TEST_TOKENS : [{ symbol: "STRATEGY", address: deployment().defaultQuote }];
      for (const t of syms) {
        const [b, d] = await Promise.all([tokenBalance(pc, t.address, a), decimalsOf(pc, t.address)]);
        parts.push(`${Number(formatUnits(b, d)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${t.symbol}`);
      }
      setBal(parts.join(" · "));
    } catch { /* ignore */ }
  }
  useEffect(() => { if (!addr) return; refresh(addr); const i = setInterval(() => refresh(addr), 15000); return () => clearInterval(i); }, [addr]);

  const fail = (e: unknown) => {
    const m = (e as Error).message.split("\n")[0];
    if ((e as { code?: string }).code === "FundAccount") setSelfPay(true);
    setErr(m.slice(0, 160));
  };
  async function run(label: string, f: () => Promise<unknown>) {
    setErr(""); setBusy(label);
    try { await f(); setMenu(false); setOtp(null); } catch (e) { fail(e); } finally { setBusy(""); }
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

  if (!isDeployed()) return null;
  const smart = isSmartMode();
  const sess = aaSession();
  const needFund = smart && selfPay && eth !== null && eth < BigInt(3e12);
  const pill = { all: "unset" as const, cursor: "pointer", padding: "5px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700, letterSpacing: ".04em" };
  const input = { all: "unset" as const, padding: "5px 8px", borderRadius: 8, fontSize: 11, background: "rgba(255,255,255,.1)", minWidth: 180 };
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
            <button type="button" title={smart ? `Smart account (owner ${sess?.owner}) — click to copy` : "Wallet"} onClick={() => { navigator.clipboard?.writeText(addr); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
              style={{ ...pill, background: "rgba(31,111,74,.9)", color: "#c8ffe4" }}>
              {smart ? "⚡ " : ""}{copied ? "copied" : `${addr.slice(0, 6)}…${addr.slice(-4)}`}
            </button>
            {smart && <button type="button" onClick={() => run("", disconnect)} style={{ ...pill, background: "rgba(255,255,255,.08)" }}>×</button>}
          </>
        ) : (
          <button type="button" onClick={() => setMenu((m) => !m)} disabled={!!busy} style={{ ...pill, background: "#ffe7a3", color: "#1a1630" }}>
            {busy || (aaAvailable() ? "Sign in" : "Connect wallet")}
          </button>
        )}
      </div>
      {!addr && menu && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 10, borderRadius: 12, background: "rgba(20,18,40,.96)", alignItems: "stretch", minWidth: 240 }}>
          {aaAvailable() ? (
            <>
              <span style={{ fontSize: 10, opacity: 0.8 }}>Sign in once — then every trade is one tap, no popups.</span>
              {otp === null ? (
                <div style={{ display: "flex", gap: 4 }}>
                  <input aria-label="email" placeholder="you@email.com" value={email} onChange={(e) => setEmail(e.target.value)} style={input} />
                  <button type="button" disabled={!!busy || !email} onClick={() => run("sending code", async () => { await emailStart(email); setOtp(""); })} style={{ ...pill, background: "#ffe7a3", color: "#1a1630" }}>Email</button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 4 }}>
                  <input aria-label="code" placeholder="6-digit code" value={otp} onChange={(e) => setOtp(e.target.value)} style={input} />
                  <button type="button" disabled={!!busy || !otp} onClick={() => run("verifying", () => connectSmartEmail(otp))} style={{ ...pill, background: "#ffe7a3", color: "#1a1630" }}>Verify</button>
                </div>
              )}
              <button type="button" disabled={!!busy} onClick={() => run("google", connectSmartGoogle)} style={{ ...pill, background: "#fff", color: "#1a1630", textAlign: "center" }}>Continue with Google</button>
              {DEV_WALLETS && <>
              <button type="button" disabled={!!busy || !hasWallet()} onClick={() => run("sign once in wallet", connectSmartWithWallet)} style={{ ...pill, background: "#2a3a7a", color: "#cfe0ff", textAlign: "center" }}>Use my wallet as owner</button>
              <button type="button" disabled={!!busy || !hasWallet()} onClick={() => run("connecting", connectWallet)} style={{ ...pill, fontSize: 10, opacity: 0.7, textAlign: "center" }}>Plain wallet (sign every tx)</button>
              </>}
            </>
          ) : (
            <button type="button" disabled={!!busy} onClick={() => hasWallet() ? run("connecting", connectWallet) : setErr("No browser wallet found. Install MetaMask/Rabby.")} style={{ ...pill, background: "#ffe7a3", color: "#1a1630", textAlign: "center" }}>Connect wallet</button>
          )}
        </div>
      )}
      {addr && bal && <span style={{ fontSize: 10, opacity: 0.8 }}>{bal}{smart ? ` · ${selfPay ? "self-pay gas" : "gasless"}` : ""} · <a href={GAS_FAUCET} target="_blank" rel="noreferrer" style={{ color: "#ffe7a3" }}>ETH faucet</a></span>}
      {needFund && <span role="status" style={{ fontSize: 10, color: "#ffe7a3", maxWidth: 320, textAlign: "right" }}>Low on gas — fund your account ({addr?.slice(0, 8)}…) with test ETH from the <a href={GAS_FAUCET} target="_blank" rel="noreferrer" style={{ color: "#fff" }}>faucet</a>.</span>}
      {err && <span role="alert" style={{ fontSize: 10, color: "#ffb0c0", maxWidth: 320, textAlign: "right" }}>{err}</span>}
    </div>
  );
}
