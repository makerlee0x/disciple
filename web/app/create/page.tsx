"use client";

import { useEffect, useMemo, useState } from "react";
import { PSEUDONYMOUS_COPY } from "@/lib/anon";
import { CURVE, MODERATION, type ModerationVerdict } from "@/lib/config";
import { contrastWarning } from "@/lib/decal";
import { precheckWithin, preloadModeration } from "@/lib/moderation-client";
import BrandedRocket from "@/components/BrandedRocket";
import SquareCrop, { cropSquare } from "@/components/create/SquareCrop";
import PairPicker from "@/components/create/PairPicker";
import { protocolStub, type Address } from "@/lib/protocol";
import { deployment, isDeployed } from "@/lib/chains";
import { recommendedPairs } from "@/lib/pairs";
import { nextTicker, randomRocketName, tickerVariants } from "@/lib/rocketNames";
import { activeAddress, execCalls } from "@/lib/wallet";
import { launchpadAbi } from "@/lib/abi";
import { encodeFunctionData } from "viem";
import { useRouter } from "next/navigation";
import { createViemProtocol } from "@/lib/protocol-viem";
import { IS_STATIC_PREVIEW } from "@/lib/base-path";
import Icon from "@/components/icons/Icon";

const inputCls =
  "w-full rounded-xl border border-[rgba(201,206,214,.35)] bg-[rgba(22,24,28,.8)] px-3 py-2 text-[#E8EAEE] outline-none focus:border-[rgba(201,206,214,.7)]";
const labelCls = "mb-1 block text-xs tracking-wider text-[#C9CED6]";
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

export default function LaunchRocketPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [callSign, setCallSign] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [iconSrc, setIconSrc] = useState<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState({ x: 0.5, y: 0.5 });
  const [contrast, setContrast] = useState<string | null>(null);
  const [mod, setMod] = useState<{ state: "idle" | "checking" | ModerationVerdict; uri?: string; note?: string }>({ state: "idle" });
  const [advanced, setAdvanced] = useState(false);
  const defaultPair = useMemo(() => recommendedPairs()[0], []);
  const [quote, setQuote] = useState<{ address: Address | null; label: string }>({ address: defaultPair?.address ?? null, label: defaultPair?.symbol ?? "" });
  const [twitter, setTwitter] = useState("");
  const [website, setWebsite] = useState("");
  const [feeReceiver, setFeeReceiver] = useState("");
  const [croppedUri, setCroppedUri] = useState<string | null>(null);
  const [tax, setTax] = useState(0);
  const [pseudonymous, setPseudonymous] = useState(false);
  // Status line: `ok` = a launch went through (rocket icon + "ok" style); otherwise a validation/launch error.
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);
  const setMsg = (text: string | null) => setStatus(text == null ? null : { text, ok: false });
  const setLaunched = (text: string) => setStatus({ text, ok: true });

  const blocked = mod.state === "block";
  useEffect(() => { preloadModeration(); }, []);
  // Fresh random name every page open.
  useEffect(() => { shuffleName(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Name shuffle re-rolls a matching call sign (first word, e.g. "Blessed Falcon" → BLESSED).
  function shuffleName() {
    const n = randomRocketName();
    setName(n);
    setCallSign(tickerVariants(n)[0] ?? "");
  }
  // Square crop → decal preview (debounced while dragging).
  useEffect(() => {
    if (!iconSrc) { setCroppedUri(null); return; }
    const t = setTimeout(() => setCroppedUri(cropSquare(iconSrc, crop)), 120);
    return () => clearTimeout(t);
  }, [iconSrc, crop]);

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
    setCrop({ x: 0.5, y: 0.5 });
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
    const uri = cropSquare(img, { x: 0.5, y: 0.5 });
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
    const quoteAddr = quote.address;
    if (!quoteAddr) {
      setMsg("Pick a pair or paste a valid ERC-20 address.");
      return;
    }
    const fr = feeReceiver.trim();
    if (fr && !isAddr(fr)) {
      setMsg("Fee receiver must be a 0x wallet address (or leave it empty to use your own).");
      return;
    }
    const web = website.trim();
    if (web && !/^https?:\/\/\S+\.\S+/.test(web)) {
      setMsg("Website must start with https://");
      return;
    }
    // Moderated at center; launch with the user's chosen square crop of the same approved image.
    const imageUri = iconSrc ? cropSquare(iconSrc, crop) : mod.uri;
    // Moderate the EXACT imageURI that goes on-chain: on allow the server stores it and adds it to the render
    // allowlist (coin images only render from the moderated store). Explicit block stops the launch; an outage
    // (review/network) keeps the testnet fail-open launch, the image just shows the placeholder until re-checked.
    let imageNote = "";
    if (!IS_STATIC_PREVIEW && imageUri.startsWith("data:")) {
      const fd = new FormData(); fd.append("uri", imageUri);
      const v = await fetch("/api/moderate-image", { method: "POST", body: fd }).then((r) => r.json()).catch(() => null) as { verdict?: string } | null;
      if (v?.verdict === "block") { setMsg("This image can't be used. Please pick a different one."); return; }
      if (v?.verdict !== "allow") imageNote = " (icon pending review; it shows once approved)";
    }
    try {
      const client = isDeployed() ? createViemProtocol() : protocolStub;
      const res = await client.launchCoin({
        name: name.trim(),
        ticker: callSign.trim().toUpperCase(),
        imageUri, // square crop of the moderated upload
        quoteToken: quoteAddr,
        creatorTaxPct: effTax,
        socials: twitter.trim() || web ? { twitter: twitter.trim().replace(/^@/, "") || undefined, website: web || undefined } : undefined,
      });
      if (fr && isDeployed()) {
        const me = await activeAddress();
        if (fr.toLowerCase() !== me.toLowerCase()) {
          setLaunched(`Launched ${res.token}. Assigning fee receiver ${fr.slice(0, 8)}… (one more confirmation)`);
          try {
            await execCalls([{ to: deployment().launchpad, data: encodeFunctionData({ abi: launchpadAbi, functionName: "transferCreator", args: [res.token, fr as Address] }) }]);
          } catch (err) {
            setLaunched(`Launched ${res.token}, but setting the fee receiver failed: ${String((err as Error).message).split("\n")[0]}. You can retry from the rocket page later.`);
            return;
          }
        }
      }
      setLaunched(`Launched! Rocket ${res.token}${imageNote} — taking you to it…`);
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
      <form className="card create-form" onSubmit={onSubmit}>
        <div className="create-grid">
          <div className="space-y-4">
            <label className="block">
              <span className={labelCls}>ROCKET NAME *</span>
              <div className="pid-edit" style={{ flexWrap: "nowrap" }}>
                <input className={inputCls} style={{ flex: 1, minWidth: 0 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Artificial Inu" maxLength={32} />
                <button type="button" className="ds-btn" title="Shuffle a random name" aria-label="Shuffle name" onClick={shuffleName}><Icon name="shuffle" size={16} /> Shuffle</button>
              </div>
            </label>
            <label className="block">
              <span className={labelCls}>CALL SIGN * <span className="normal-case opacity-70">— your $TICKER, e.g. $AI for Artificial Inu</span></span>
              <div className="ticker-input">
                <span>$</span>
                <input className={inputCls} style={{ flex: 1, minWidth: 0 }} value={callSign} onChange={(e) => setCallSign(e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase())} placeholder="AI" maxLength={10} />
                <button type="button" className="ds-btn" disabled={!tickerVariants(name).length}
                  title={`Shuffle a call sign from the name (${tickerVariants(name).map((t) => "$" + t).join(" · ") || "type a name first"})`}
                  aria-label="Shuffle call sign" onClick={() => setCallSign(nextTicker(name, callSign))}><Icon name="shuffle" size={16} /> Shuffle</button>
              </div>
            </label>
            <div className="block">
              <span className={labelCls}>ROCKET ICON * <span className="normal-case opacity-70">square · PNG/JPG/WEBP/GIF · ≤2 MB</span></span>
              <label className="upload-drop">
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="upload rocket icon" className="sr-only" onChange={(e) => onPickFile(e.target.files?.[0] || null)} />
                <span>{file ? `${file.name} · click to replace` : "Click to upload an image"}</span>
              </label>
              {iconSrc && !blocked && (
                <div className="crop-row">
                  <SquareCrop img={iconSrc} pos={crop} onChange={setCrop} />
                  <span className="muted tiny">Images are always cropped square. Drag to choose what shows on your hull.</span>
                </div>
              )}
              {mod.state === "checking" && <p className="text-xs text-[#C9CED6]">Checking image…</p>}
              {mod.state === "allow" && file && <p className="text-xs text-[#9ff3c8]"><Icon name="check" size={12} /> Icon approved{mod.note ? ` · ${mod.note}` : ""}</p>}
              {blocked && (
                <p role="alert" className="ds-msg bad">
                  This image can&apos;t be used. Please pick a different one.{mod.note ? ` (${mod.note})` : ""}
                </p>
              )}
              {mod.state === "review" && <p className="text-xs text-[#FF7A3D]">Held for review — you can launch once it&apos;s cleared.{mod.note ? ` ${mod.note}` : ""}</p>}
              {contrast && <p className="text-xs text-[#FF7A3D]"><Icon name="warning" size={12} /> {contrast}</p>}
            </div>
          </div>

          <div className="staging" aria-label="Rocket on the staging block">
            <div className="staging-sky" />
            <div className="staging-tower"><span /><span /><span /><span /></div>
            <div className="staging-rocket"><BrandedRocket height={240} icon={croppedUri} /></div>
            <div className="staging-block"><span>{callSign ? `$${callSign}` : "$TICKER"}</span></div>
            <div className="staging-label">{name || "Your rocket"} · READY FOR LAUNCH</div>
          </div>
        </div>

        <div className="block">
          <span className={labelCls}>PAIR WITH *</span>
          <PairPicker value={quote.address} onChange={(address, label) => setQuote({ address, label })} />
          {quote.address && <p className="muted tiny">Paired with <strong className="text-[#E8EAEE]">{quote.label}</strong> · {quote.address}</p>}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className={labelCls}>X / SOCIAL LINK <span className="normal-case opacity-70">(optional)</span></span>
            <input className={inputCls} value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="@handle or https://x.com/…" maxLength={80} />
          </label>
          <label className="block">
            <span className={labelCls}>WEBSITE <span className="normal-case opacity-70">(optional)</span></span>
            <input className={inputCls} value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://…" maxLength={120} />
          </label>
        </div>

        <label className="block">
          <span className={labelCls}>FEE RECEIVER WALLET <span className="normal-case opacity-70">(optional — defaults to the deployer)</span></span>
          <input className={`${inputCls} font-mono`} value={feeReceiver} onChange={(e) => setFeeReceiver(e.target.value.trim())} placeholder="0x… (leave empty to receive fees yourself)" />
          <span className="muted tiny block mt-1">Set via Launchpad.transferCreator right after launch (one extra confirmation). That wallet becomes the rocket&apos;s creator and receives creator fees.</span>
        </label>

        <button
          type="button"
          aria-expanded={advanced}
          onClick={() => setAdvanced((a) => !a)}
          className="flex w-full items-center justify-between rounded-xl border border-[rgba(201,206,214,.25)] px-3 py-2 text-xs tracking-wider text-[#C9CED6]"
        >
          <span>ADVANCED · creator tax &amp; pseudonymous</span>
          <span><Icon name={advanced ? "chevron-up" : "chevron-down"} size={16} /> {advanced ? "ON" : "OFF"}</span>
        </button>

        {advanced && (
          <div className="space-y-4 rounded-xl border border-[rgba(201,206,214,.2)] p-3">
            <label className="block">
              <span className={labelCls}>CREATOR TAX (0–{CURVE.creatorTaxMaxPct}%, immutable)</span>
              <input type="number" min={0} max={CURVE.creatorTaxMaxPct} step={0.1} className={inputCls} value={tax} onChange={(e) => setTax(+e.target.value)} />
            </label>
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" checked={pseudonymous} onChange={(e) => setPseudonymous(e.target.checked)} />
              <span>
                <span className={labelCls}>PSEUDONYMOUS CREATOR (beta)</span>
                <span className="block text-[rgba(232,234,238,.7)]">{PSEUDONYMOUS_COPY}</span>
              </span>
            </label>
          </div>
        )}

        <p className="note">
          Rockets lift off at ${CURVE.startMcap.toLocaleString()} and reach orbit at $
          {CURVE.graduationMcap.toLocaleString()}. Name and call sign are permanent after launch.
        </p>
        <details className="text-xs text-[rgba(232,234,238,.7)]">
          <summary className="cursor-pointer">What am I launching?</summary>
          Your rocket is an ERC-20 token on Robinhood Chain, traded on a bonding curve
          {quote.address ? ` paired with ${quote.label} (${quote.address})` : ""}. BOOST to buy. DUMP to sell, and drop a bomb.
        </details>
        <button
          type="submit"
          className="w-full rounded-xl border border-[rgba(201,206,214,.5)] bg-gradient-to-b from-[#1F2228] to-[#16181C] py-3 font-bold text-[#E8EAEE] shadow-[0_0_20px_rgba(201,206,214,.15)] hover:from-[#2E323A]"
        >
          <Icon name="rocket" size={16} style={{ verticalAlign: -3 }} /> {isDeployed() ? "Launch Rocket on-chain (testnet)" : "Launch Rocket (UI only)"}
        </button>
        {status && (
          <p role="status" className={`ds-msg ${status.ok ? "ok" : "bad"}`}>{status.ok && <><Icon name="rocket" size={16} style={{ verticalAlign: -3 }} /> </>}{status.text}</p>
        )}
      </form>
    </div>
  );
}
