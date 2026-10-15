"use client";

import { useEffect, useMemo, useState } from "react";
import { CURVE, MODERATION, QUOTE_PRESETS, STRATEGY_TOKEN, type ModerationVerdict } from "@/lib/config";
import { contrastWarning, loadIcon } from "@/lib/decal";
import { iconDataUri, precheckWithin, preloadModeration } from "@/lib/moderation-client";
import RocketStudio from "@/components/RocketStudio";
import { DEFAULT_QUOTE, protocolStub, type Address } from "@/lib/protocol";
import { ZERO, deployment, isDeployed } from "@/lib/chains";
import { useRouter } from "next/navigation";
import { createViemProtocol } from "@/lib/protocol-viem";
import { IS_STATIC_PREVIEW } from "@/lib/base-path";

const inputCls =
  "w-full rounded-xl border border-[rgba(255,231,163,.35)] bg-[rgba(8,10,28,.8)] px-3 py-2 text-[#eef0ff] outline-none focus:border-[rgba(255,231,163,.7)]";
const labelCls = "mb-1 block text-xs tracking-wider text-[#ffe7a3]";
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

export default function LaunchRocketPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [callSign, setCallSign] = useState("");
  const [image, setImage] = useState(""); // URL input (optional if a file is uploaded)
  const [file, setFile] = useState<File | null>(null);
  const [iconSrc, setIconSrc] = useState<CanvasImageSource | null>(null);
  const [zoom, setZoom] = useState(1);
  const [ox, setOx] = useState(0);
  const [oy, setOy] = useState(0);
  const [contrast, setContrast] = useState<string | null>(null);
  const [mod, setMod] = useState<{ state: "idle" | "checking" | ModerationVerdict; uri?: string; note?: string }>({ state: "idle" });
  const opts = useMemo(() => ({ zoom, ox, oy }), [zoom, ox, oy]);
  const [advanced, setAdvanced] = useState(false);
  const [quoteSym, setQuoteSym] = useState<string>(STRATEGY_TOKEN.symbol);
  const [customQuote, setCustomQuote] = useState("");
  const [tax, setTax] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);

  const blocked = mod.state === "block";
  useEffect(() => { preloadModeration(); }, []);

  async function onPickFile(f: File | null) {
    setFile(f); setIconSrc(null); setContrast(null); setMod({ state: "idle" });
    if (!f) return;
    if (!(MODERATION.mimeTypes as readonly string[]).includes(f.type)) return setMod({ state: "block", note: "Only PNG, JPG, WEBP or GIF." });
    if (f.size > MODERATION.maxBytes) return setMod({ state: "block", note: "Max 2 MB." });
    setMod({ state: "checking" });
    const t0 = performance.now();
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch { return setMod({ state: "block", note: "Not a readable image." }); }
    setIconSrc(img);
    setContrast(contrastWarning(img));
    // Fast client check (model preloaded on mount, hard 3s timeout). Explicit → block.
    // Timeout/error → fail OPEN on testnet with "pending server review" (never hang the form).
    let pre: Awaited<ReturnType<typeof precheckWithin>> | null = null;
    try { pre = await precheckWithin(img, 3000); } catch { pre = null; }
    const ms = Math.round(performance.now() - t0);
    if (pre && pre !== "timeout" && pre.verdict === "block") {
      setIconSrc(null); setContrast(null);
      return setMod({ state: "block", note: `Rejected by image check (${ms} ms).` });
    }
    const uri = iconDataUri(img);
    const pending = !pre || pre === "timeout" || pre.verdict === "review";
    setMod({ state: "allow", uri, note: pending ? `pending server review (${ms} ms)` : `approved in ${ms} ms` });
    // Async authoritative server check; only an explicit server block revokes approval.
    if (!IS_STATIC_PREVIEW) {
      const fd = new FormData(); fd.append("file", f);
      fetch("/api/moderate-image", { method: "POST", body: fd })
        .then((r) => r.json())
        .then((r) => { if (r?.verdict === "block") { setIconSrc(null); setContrast(null); setMod({ state: "block", note: "Rejected by server review." }); } })
        .catch(() => { /* server unavailable: keep client verdict (testnet) */ });
    }
  }

  // URL icons (no upload): preview only; launching still requires an uploaded, moderated file.
  useEffect(() => {
    if (file || !image.trim()) return;
    let alive = true;
    const t = setTimeout(() => loadIcon(image.trim()).then((ic) => { if (alive) { setIconSrc(ic); setContrast(ic ? contrastWarning(ic) : null); } }), 400);
    return () => { alive = false; clearTimeout(t); };
  }, [image, file]);

  function resolveQuote(): Address | null {
    if (!advanced) return DEFAULT_QUOTE;
    if (quoteSym === "CUSTOM") return isAddr(customQuote) ? (customQuote as Address) : null;
    // Active-chain addresses win (testnet: test STRATEGY / mUSDG).
    if (quoteSym === "STRATEGY") return deployment().defaultQuote;
    if (quoteSym === "USDG" && deployment().usdg !== ZERO) return deployment().usdg;
    const p = QUOTE_PRESETS.find((q) => q.symbol === quoteSym);
    return p && isAddr(p.address) ? (p.address as Address) : null;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!name.trim() || !callSign.trim() || !file) {
      setMsg("Rocket name, call sign, and an uploaded rocket icon are required.");
      return;
    }
    if (mod.state !== "allow" || !mod.uri) {
      setMsg(mod.state === "block" ? "This image can't be used. Please pick a different one." : "Your icon is still being checked (or held for review).");
      return;
    }
    const effTax = advanced ? tax : 0;
    if (effTax < 0 || effTax > CURVE.creatorTaxMaxPct) {
      setMsg(`Creator tax must be 0–${CURVE.creatorTaxMaxPct}%.`);
      return;
    }
    const quote = resolveQuote();
    if (!quote) {
      setMsg("Pick a pair with a valid ERC-20 address (TODO: preset addresses pending).");
      return;
    }
    try {
      const client = isDeployed() ? createViemProtocol() : protocolStub;
      const res = await client.launchCoin({
        name: name.trim(),
        ticker: callSign.trim().toUpperCase(),
        imageUri: mod.uri, // moderated URI only — contracts store this metadata URI
        quoteToken: quote,
        creatorTaxPct: effTax,
      });
      setMsg(`🚀 Launched! Rocket ${res.token} — taking you to it…`);
      setTimeout(() => router.push(`/coin/${res.token}?cs=${encodeURIComponent(callSign.trim().toUpperCase())}`), 1200);
    } catch (err) {
      setMsg(isDeployed() ? String((err as Error).message) : "Contracts not deployed yet (DISCIPLE FLOW). Form validated locally — " + String((err as Error).message));
    }
  }

  return (
    <div className="page-shell">
      <h1>Launch a Rocket</h1>
      <div className="sub">EVERYONE ABOARD FLIES TOGETHER · PRICES IN $</div>
      <span className="tag mock">{isDeployed() ? `ON-CHAIN · ${deployment() && "Robinhood Chain testnet"} · connect wallet (top right)` : "MOCK FORM · NOT ON-CHAIN YET"}</span>
      <form className="card space-y-4" onSubmit={onSubmit}>
        <label className="block">
          <span className={labelCls}>ROCKET NAME *</span>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Artificial Inu" maxLength={32} />
        </label>
        <label className="block">
          <span className={labelCls}>CALL SIGN *</span>
          <input className={inputCls} value={callSign} onChange={(e) => setCallSign(e.target.value)} placeholder="AI" maxLength={10} />
        </label>
        <label className="block">
          <span className={labelCls}>ROCKET ICON * (PNG/JPG/WEBP/GIF · ≤2 MB)</span>
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="upload rocket icon" className={inputCls} onChange={(e) => onPickFile(e.target.files?.[0] || null)} />
        </label>
        <label className="block">
          <span className={labelCls}>…or preview an icon URL</span>
          <input className={inputCls} value={image} onChange={(e) => setImage(e.target.value)} placeholder="https://…" disabled={!!file} />
        </label>
        {mod.state === "checking" && <p className="text-xs text-[#ffe7a3]">Checking image…</p>}
        {mod.state === "allow" && file && <p className="text-xs text-[#9ff3c8]">✓ Icon approved{mod.note ? ` · ${mod.note}` : ""}</p>}
        {blocked && (
          <p role="alert" className="rounded-lg border border-[rgba(255,120,140,.5)] bg-[rgba(50,10,20,.6)] p-3 text-sm text-[#ffb0c0]">
            This image can&apos;t be used. Please pick a different one.{mod.note ? ` (${mod.note})` : ""}
          </p>
        )}
        {mod.state === "review" && <p className="text-xs text-[#ffd98a]">Held for review — you can launch once it&apos;s cleared.{mod.note ? ` ${mod.note}` : ""}</p>}
        {mod.state === "allow" && <p className="text-xs text-[#9ff3c8]">✓ Icon approved</p>}

        {!blocked && (
          <div className="space-y-2">
            <RocketStudio icon={iconSrc} opts={opts} />
            <div className="grid grid-cols-3 gap-2 text-[11px] text-[#ffe7a3]">
              <label>ZOOM {zoom.toFixed(2)}×<input type="range" min={1} max={3} step={0.05} value={zoom} onChange={(e) => setZoom(+e.target.value)} className="w-full" /></label>
              <label>OFFSET X<input type="range" min={-1} max={1} step={0.05} value={ox} onChange={(e) => setOx(+e.target.value)} className="w-full" /></label>
              <label>OFFSET Y<input type="range" min={-1} max={1} step={0.05} value={oy} onChange={(e) => setOy(+e.target.value)} className="w-full" /></label>
            </div>
            {contrast && <p className="text-xs text-[#ffd98a]">⚠ {contrast}</p>}
          </div>
        )}

        <button
          type="button"
          aria-expanded={advanced}
          onClick={() => setAdvanced((a) => !a)}
          className="flex w-full items-center justify-between rounded-xl border border-[rgba(255,231,163,.25)] px-3 py-2 text-xs tracking-wider text-[#ffe7a3]"
        >
          <span>ADVANCED · pair &amp; creator tax</span>
          <span>{advanced ? "▲ ON" : "▼ OFF"}</span>
        </button>

        {advanced && (
          <div className="space-y-4 rounded-xl border border-[rgba(255,231,163,.2)] p-3">
            <label className="block">
              <span className={labelCls}>PAIRED QUOTE TOKEN (any ERC-20)</span>
              <select className={inputCls} value={quoteSym} onChange={(e) => setQuoteSym(e.target.value)}>
                {QUOTE_PRESETS.map((q) => (
                  <option key={q.symbol} value={q.symbol}>
                    {q.symbol} {(() => { const a = q.symbol === "STRATEGY" ? deployment().defaultQuote : q.symbol === "USDG" && deployment().usdg !== ZERO ? deployment().usdg : q.address; return a ? `· ${a.slice(0, 6)}…${a.slice(-4)}` : ""; })()} ({q.note})
                  </option>
                ))}
                <option value="CUSTOM">Custom ERC-20 address…</option>
              </select>
            </label>
            {quoteSym === "CUSTOM" && (
              <input className={inputCls} value={customQuote} onChange={(e) => setCustomQuote(e.target.value)} placeholder="0x…" />
            )}
            <label className="block">
              <span className={labelCls}>CREATOR TAX (0–{CURVE.creatorTaxMaxPct}%, immutable)</span>
              <input type="number" min={0} max={CURVE.creatorTaxMaxPct} step={0.1} className={inputCls} value={tax} onChange={(e) => setTax(+e.target.value)} />
            </label>
          </div>
        )}

        <p className="note">
          Rockets lift off at ${CURVE.startMcap.toLocaleString()} and reach orbit at $
          {CURVE.graduationMcap.toLocaleString()}. Name and call sign are permanent after launch.
        </p>
        <details className="text-xs text-[rgba(220,228,255,.7)]">
          <summary className="cursor-pointer">What am I launching?</summary>
          Your rocket is an ERC-20 token on Robinhood Chain, traded on a bonding curve
          {advanced ? "" : ` paired with ${STRATEGY_TOKEN.symbol} (${deployment().defaultQuote})`}. Fuel/ammo buys it; brake/bomb sells it.
        </details>
        <button
          type="submit"
          className="w-full rounded-xl border border-[rgba(255,231,163,.5)] bg-gradient-to-b from-[#2a2440] to-[#16122a] py-3 font-bold text-[#fff7df] shadow-[0_0_20px_rgba(255,220,150,.15)] hover:from-[#3a3258]"
        >
          {isDeployed() ? "🚀 Launch Rocket on-chain (testnet)" : "🚀 Launch Rocket (UI only)"}
        </button>
        {msg && (
          <p className="rounded-lg border border-[rgba(255,180,100,.4)] bg-[rgba(40,20,10,.5)] p-3 text-sm text-[#ffd0a0]">{msg}</p>
        )}
      </form>
    </div>
  );
}
