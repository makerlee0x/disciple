"use client";

import { useEffect, useMemo, useState } from "react";
import { erc20Abi } from "viem";
import { recommendedPairs, type PairOption } from "@/lib/pairs";
import { publicClient } from "@/lib/protocol-viem";
import { isDeployed } from "@/lib/chains";
import type { Address } from "@/lib/protocol";

const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** FOMO-style pair picker: searchable curated cards + "Paste ERC-20 address" (validated on-chain). */
export default function PairPicker({ value, onChange }: { value: Address | null; onChange: (a: Address | null, label: string) => void }) {
  const pairs = useMemo(() => recommendedPairs(), []);
  const [q, setQ] = useState("");
  const [custom, setCustom] = useState("");
  const [customInfo, setCustomInfo] = useState<{ state: "idle" | "checking" | "ok" | "bad"; symbol?: string; name?: string }>({ state: "idle" });

  const filtered = pairs.filter((p) => !q || `${p.symbol} ${p.name} ${p.address}`.toLowerCase().includes(q.toLowerCase()));
  const selectedPreset = pairs.find((p) => value && p.address.toLowerCase() === value.toLowerCase());

  useEffect(() => {
    if (!isAddr(custom)) { setCustomInfo({ state: custom ? "bad" : "idle" }); return; }
    if (!isDeployed()) { setCustomInfo({ state: "ok", symbol: "ERC-20" }); return; }
    let alive = true;
    setCustomInfo({ state: "checking" });
    (async () => {
      try {
        const pc = publicClient();
        const [symbol, name] = await Promise.all([
          pc.readContract({ address: custom as Address, abi: erc20Abi, functionName: "symbol" }),
          pc.readContract({ address: custom as Address, abi: erc20Abi, functionName: "name" }),
          pc.readContract({ address: custom as Address, abi: erc20Abi, functionName: "decimals" }),
        ]);
        if (alive) setCustomInfo({ state: "ok", symbol: String(symbol), name: String(name) });
      } catch { if (alive) setCustomInfo({ state: "bad" }); }
    })();
    return () => { alive = false; };
  }, [custom]);

  const pick = (p: PairOption) => { setCustom(""); onChange(p.address, p.symbol); };

  return (
    <div className="pair-picker">
      <input className="ds-input pp-search" placeholder="Search pairs…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search pairs" />
      <div className="pp-list" role="listbox" aria-label="Recommended pairs">
        {filtered.map((p) => {
          const on = selectedPreset?.address === p.address;
          return (
            <button key={p.address} type="button" role="option" aria-selected={on} className={`pp-card ${on ? "on" : ""}`} onClick={() => pick(p)}>
              <span className="pp-logo" style={{ background: `radial-gradient(circle at 35% 30%, #fff, ${p.tint} 55%, #121634)` }}>{p.symbol[0]}</span>
              <span className="pp-meta">
                <span className="pp-sym">{p.symbol}{p.recommended && <span className="pp-rec">RECOMMENDED</span>}</span>
                <span className="pp-name">{p.name}</span>
                <span className="pp-note">{p.note}</span>
              </span>
              <span className="pp-addr mono">{short(p.address)}</span>
            </button>
          );
        })}
        {filtered.length === 0 && <p className="muted tiny">No curated pair matches — paste an address below.</p>}
      </div>
      <div className={`pp-custom ${value && !selectedPreset ? "on" : ""}`}>
        <span className="pid-label">PASTE ERC-20 ADDRESS</span>
        <div className="pid-edit">
          <input className="ds-input mono" placeholder="0x…" value={custom} onChange={(e) => setCustom(e.target.value.trim())} aria-label="Custom ERC-20 address" />
          <button type="button" className="ds-btn gold" disabled={customInfo.state !== "ok"} onClick={() => onChange(custom as Address, customInfo.symbol || "ERC-20")}>Use</button>
        </div>
        {customInfo.state === "checking" && <span className="muted tiny">Reading token…</span>}
        {customInfo.state === "ok" && customInfo.name && <span className="pid-status ok">{customInfo.symbol} · {customInfo.name}</span>}
        {customInfo.state === "bad" && <span className="pid-status bad">Not a readable ERC-20 on this chain.</span>}
      </div>
    </div>
  );
}
