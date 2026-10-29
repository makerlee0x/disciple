"use client";

import { useMemo, useState } from "react";
import { recommendedPairs, type PairOption } from "@/lib/pairs";
import { pairLogo } from "@/lib/pairArt";
import type { Address } from "@/lib/protocol";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** FOMO-style pair picker: searchable cards over the launch pair whitelist only (lib/pairWhitelist; no pasted ERC-20). */
export default function PairPicker({ value, onChange }: { value: Address | null; onChange: (a: Address | null, label: string) => void }) {
  const pairs = useMemo(() => recommendedPairs(), []);
  const [q, setQ] = useState("");

  const filtered = pairs.filter((p) => !q || `${p.symbol} ${p.name} ${p.address}`.toLowerCase().includes(q.toLowerCase()));
  const selectedPreset = pairs.find((p) => value && p.address.toLowerCase() === value.toLowerCase());

  const pick = (p: PairOption) => onChange(p.address, p.symbol);

  return (
    <div className="pair-picker">
      <input className="ds-input pp-search" placeholder="Search pairs…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search pairs" />
      <div className="pp-list" role="listbox" aria-label="Pairs">
        {filtered.map((p) => {
          const on = selectedPreset?.address === p.address;
          return (
            <button key={p.address} type="button" role="option" aria-selected={on} className={`pp-card ${on ? "on" : ""}`} onClick={() => pick(p)}>
              <span className="pp-logo" style={{ background: `radial-gradient(circle at 35% 30%, #fff, ${p.tint} 55%, #121634)`, overflow: "hidden" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={pairLogo(p.tk)} alt="" width="100%" height="100%" style={{ objectFit: "cover", width: "100%", height: "100%" }} onError={(e) => { e.currentTarget.style.display = "none"; }} />
              </span>
              <span className="pp-meta">
                <span className="pp-sym">{p.symbol}{p.recommended && <span className="pp-rec">DEFAULT</span>}</span>
                <span className="pp-name">{p.name}</span>
                <span className="pp-note">{p.note}</span>
              </span>
              <span className="pp-addr mono">{short(p.address)}</span>
            </button>
          );
        })}
        {filtered.length === 0 && <p className="muted tiny">No pair matches.</p>}
      </div>
    </div>
  );
}
