"use client";

import { useState } from "react";
import { CURVE } from "@/lib/config";
import { protocolStub } from "@/lib/protocol";

export default function CreatePage() {
  const [name, setName] = useState("");
  const [ticker, setTicker] = useState("");
  const [image, setImage] = useState("");
  const [quote, setQuote] = useState("WETH");
  const [tax, setTax] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!name.trim() || !ticker.trim() || !image.trim()) {
      setMsg("Name, ticker, and image are required.");
      return;
    }
    if (tax < 0 || tax > CURVE.creatorTaxMaxPct) {
      setMsg(`Creator tax must be 0–${CURVE.creatorTaxMaxPct}%.`);
      return;
    }
    try {
      // UI-only: stub throws until contracts are wired
      await protocolStub.launchCoin({
        name: name.trim(),
        ticker: ticker.trim().toUpperCase(),
        imageUri: image.trim(),
        quoteToken: "0x0000000000000000000000000000000000000000",
        creatorTaxPct: tax,
      });
    } catch (err) {
      setMsg(
        "TODO: wire to contracts (DISCIPLE FLOW). Form validated locally — " +
          String((err as Error).message),
      );
    }
  }

  return (
    <div className="page-shell">
      <h1>Launch a coin</h1>
      <div className="sub">PERMISSIONLESS · IMMUTABLE CREATOR TAX · UI ONLY</div>
      <span className="tag mock">MOCK FORM · NOT ON-CHAIN YET</span>
      <form className="card space-y-4" onSubmit={onSubmit}>
        <label className="block">
          <span className="mb-1 block text-xs tracking-wider text-[#ffe7a3]">
            NAME *
          </span>
          <input
            className="w-full rounded-xl border border-[rgba(255,231,163,.35)] bg-[rgba(8,10,28,.8)] px-3 py-2 text-[#eef0ff] outline-none focus:border-[rgba(255,231,163,.7)]"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Artificial Inu"
            maxLength={32}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs tracking-wider text-[#ffe7a3]">
            TICKER *
          </span>
          <input
            className="w-full rounded-xl border border-[rgba(255,231,163,.35)] bg-[rgba(8,10,28,.8)] px-3 py-2 text-[#eef0ff] outline-none focus:border-[rgba(255,231,163,.7)]"
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            placeholder="AI"
            maxLength={10}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs tracking-wider text-[#ffe7a3]">
            IMAGE URL *
          </span>
          <input
            className="w-full rounded-xl border border-[rgba(255,231,163,.35)] bg-[rgba(8,10,28,.8)] px-3 py-2 text-[#eef0ff] outline-none focus:border-[rgba(255,231,163,.7)]"
            value={image}
            onChange={(e) => setImage(e.target.value)}
            placeholder="ipfs://… or https://…"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs tracking-wider text-[#ffe7a3]">
            PAIRED QUOTE TOKEN
          </span>
          <select
            className="w-full rounded-xl border border-[rgba(255,231,163,.35)] bg-[rgba(8,10,28,.8)] px-3 py-2 text-[#eef0ff]"
            value={quote}
            onChange={(e) => setQuote(e.target.value)}
          >
            <option value="WETH">WETH (always passes probe)</option>
            <option value="USDG">USDG (always passes probe)</option>
            <option value="CUSTOM">Any ERC-20 (probe TBD)</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs tracking-wider text-[#ffe7a3]">
            CREATOR TAX (0–{CURVE.creatorTaxMaxPct}%, immutable)
          </span>
          <input
            type="number"
            min={0}
            max={CURVE.creatorTaxMaxPct}
            step={0.1}
            className="w-full rounded-xl border border-[rgba(255,231,163,.35)] bg-[rgba(8,10,28,.8)] px-3 py-2 text-[#eef0ff]"
            value={tax}
            onChange={(e) => setTax(+e.target.value)}
          />
        </label>
        <p className="note">
          Curve: CPAMM ${CURVE.startMcap.toLocaleString()} → $
          {CURVE.graduationMcap.toLocaleString()} · {CURVE.soldPctAtGrad}% sold
          at graduation into locked Uniswap v4. Creator tax is set once at
          launch and cannot change. Name and ticker are immutable after launch.
        </p>
        <button
          type="submit"
          className="w-full rounded-xl border border-[rgba(255,231,163,.5)] bg-gradient-to-b from-[#2a2440] to-[#16122a] py-3 font-bold text-[#fff7df] shadow-[0_0_20px_rgba(255,220,150,.15)] hover:from-[#3a3258]"
        >
          Launch (UI only)
        </button>
        {msg && (
          <p className="rounded-lg border border-[rgba(255,180,100,.4)] bg-[rgba(40,20,10,.5)] p-3 text-sm text-[#ffd0a0]">
            {msg}
          </p>
        )}
      </form>
    </div>
  );
}
