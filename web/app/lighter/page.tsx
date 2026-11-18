"use client";
/**
 * Hidden Lighter test page (not linked anywhere). Runs set-up for the signed-in player's wallet, then a small market
 * open / close, through /api/lighter. Only works when LIGHTER_ENABLED=1; otherwise the API answers "Lighter isn't on."
 */
import { useCallback, useEffect, useState } from "react";
import { withBase } from "@/lib/base-path";
import { aaSession, onPrivy, onSessionChange, privyAccessToken, privyLogin } from "@/lib/aa/sessionState";
import { onWallet } from "@/lib/walletState";
import { aaSignMessage } from "@/lib/aa/session";
import { lighterClose, lighterOpen, lighterSetUp, lighterStatus, type LighterStep } from "@/lib/lighter/client";

type Status = Awaited<ReturnType<typeof lighterStatus>> & { collateral?: string; positions?: { symbol?: string; position?: string; sign?: number }[]; lookup?: string[] };
const MARKETS = ["BTC", "ETH", "SOL", "HYPE"] as const;

export default function LighterTest() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [st, setSt] = useState<Status | null>(null);
  const [market, setMarket] = useState<(typeof MARKETS)[number]>("BTC");
  const [usd, setUsd] = useState(5);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const say = (s: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${s}`, ...l].slice(0, 40));

  useEffect(() => {
    let w: string | null = null;
    const u = () => setWallet((aaSession()?.owner ?? w)?.toLowerCase() ?? null);
    const offs = [onSessionChange(u), onPrivy(u), onWallet((a) => { w = a; u(); })];
    u();
    return () => offs.forEach((o) => o());
  }, []);

  const f = useCallback(async (input: string, init?: RequestInit) => {
    const t = await privyAccessToken();
    if (!t || !wallet) throw new Error("Sign in first.");
    return fetch(withBase(input), { ...init, cache: "no-store", headers: { ...((init?.headers as Record<string, string>) ?? {}), authorization: `Bearer ${t}`, "x-wallet": wallet } });
  }, [wallet]);

  const refresh = useCallback(async () => {
    try { setSt((await lighterStatus(f)) as Status); } catch (e) { say(`status: ${(e as Error).message}`); }
  }, [f]);
  useEffect(() => { if (wallet) void refresh(); }, [wallet, refresh]);
  // load the player's key, signer and market into the server before the first tap (a duel does this in its lobby)
  useEffect(() => { if (st?.step === "ready") void f("/api/lighter", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "warm" }) }).catch(() => {}); }, [st?.step, f]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    const t0 = performance.now();
    try {
      const r = (await fn()) as { hash?: string; ms?: Record<string, number>; fill?: number; price?: number } | undefined;
      const tap = Math.round(performance.now() - t0);
      const ms = r?.ms ? Object.entries(r.ms).map(([k, v]) => `${k} ${v}`).join(" · ") : "";
      say(r?.ms ? `${label} ✓ tap ${tap} ms  [server: ${ms}]  fill ${r.fill ?? r.price ?? ""}  ${r.hash?.slice(0, 10) ?? ""}…` : `${label} ✓ ${tap} ms ${r ? JSON.stringify(r) : ""}`);
    }
    catch (e) { say(`${label} ✗ ${(e as Error).message}`); }
    finally { setBusy(false); void refresh(); }
  };
  const sign = async (msg: string) => { const s = await aaSignMessage(msg); if (!s) throw new Error("Wallet didn't sign."); return s.sig; };

  const step: LighterStep | undefined = st?.step;
  const btn = "rounded-lg border border-white/25 px-4 py-2 disabled:opacity-40";
  return (
    <main className="mx-auto max-w-xl p-6 font-mono text-sm text-white">
      <h1 className="mb-4 text-lg font-bold">Lighter test</h1>
      <div className="mb-4 space-y-1 rounded-lg border border-white/15 p-3">
        <div className="break-all">wallet: {wallet ?? "not signed in"}</div>
        <div>network: {st?.network ?? "…"} · step: <b>{step ?? "…"}</b> · account: {st?.account ?? "none"}</div>
        <div>cash: {st?.collateral ?? "…"} · Disciple fee: {st ? `${st.feeBp} bp a side` : "…"}</div>
        {st?.positions?.map((p, i) => <div key={i}>position: {p.symbol} {p.sign === -1 ? "-" : ""}{p.position}</div>)}
      </div>
      {step === "deposit" && <p className="mb-4 text-amber-300">No Lighter {st?.network} account for this wallet yet. Deposit to Lighter from it first.</p>}
      {!!st?.lookup?.length && <pre className="mb-4 whitespace-pre-wrap text-xs opacity-70">{st.lookup.join("\n")}</pre>}
      <div className="mb-4 flex flex-wrap gap-2">
        {!wallet && <button className={btn} onClick={() => privyLogin()}>Sign in</button>}
        <button className={btn} disabled={busy || !wallet} onClick={() => void refresh()}>Refresh</button>
        <button className={btn} disabled={busy || !step || step === "deposit" || step === "ready"} onClick={() => void run("set-up", async () => ({ step: await lighterSetUp(f, sign) }))}>Set up</button>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select className="rounded-lg border border-white/25 bg-black px-2 py-2" value={market} onChange={(e) => setMarket(e.target.value as typeof market)}>
          {MARKETS.map((m) => <option key={m}>{m}</option>)}
        </select>
        <input className="w-20 rounded-lg border border-white/25 bg-black px-2 py-2" type="number" min={1} value={usd} onChange={(e) => setUsd(Number(e.target.value))} />
        <button className={btn} disabled={busy || step !== "ready"} onClick={() => void run(`long ${market} $${usd}`, () => lighterOpen(f, market, "long", usd))}>Long</button>
        <button className={btn} disabled={busy || step !== "ready"} onClick={() => void run(`short ${market} $${usd}`, () => lighterOpen(f, market, "short", usd))}>Short</button>
        <button className={btn} disabled={busy || step !== "ready"} onClick={() => void run(`close ${market}`, () => lighterClose(f, market))}>Close</button>
      </div>
      <pre className="whitespace-pre-wrap break-all rounded-lg border border-white/15 p-3 text-xs">{log.join("\n") || "—"}</pre>
    </main>
  );
}
