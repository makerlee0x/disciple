"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { newStealthOwner } from "@/lib/privateLaunch";
import { CURVE, MODERATION, type ModerationVerdict } from "@/lib/config";
import { contrastWarning } from "@/lib/decal";
import { houseBadgeDataUri } from "@/lib/decalDefault";
import { precheckWithin, preloadModeration } from "@/lib/moderation-client";
import { cropSquare } from "@/components/create/SquareCrop";
import LaunchPad from "@/components/create/LaunchPad";
import { LaunchCountdown, LaunchLiveNow, type LaunchPhase } from "@/components/create/LaunchLive";
import FirstBoostField, { type FirstBoostState } from "@/components/create/FirstBoostField";
import { exceedsQuoteFirstBoostCap, exceedsUsdgFirstBoostCap } from "@/lib/firstBoost";
import { protocolStub, type Address } from "@/lib/protocol";
import { LAUNCH_ABI_SHAPE, LaunchMode } from "@/lib/launchAbi";
import { DEFAULT_MODE, MODE_LABEL, MODE_ORDER } from "@/lib/modeRules";
import { ACTIVE_CHAIN, deployment, isDeployed } from "@/lib/chains";
import { nextTicker, randomRocketName, tickerVariants } from "@/lib/rocketNames";
import { activeAddress, aaAvailable, canTransact, connectPrivy, connectWallet, execCalls, onWallet } from "@/lib/wallet";
import { clientGaslessMode } from "@/lib/aa/sponsorshipMode";
import { blockedActionMessage } from "@/lib/trade/gaslessAction";
import { launchpadAbi } from "@/lib/abi";
import { encodeFunctionData } from "viem";
import { useRouter } from "next/navigation";
import { createViemProtocol } from "@/lib/protocol-viem";
import { trackFunnel } from "@/lib/funnelClient";
import { IS_STATIC_PREVIEW, withBase } from "@/lib/base-path";
import Icon from "@/components/icons/Icon";
import { playerError } from "@/lib/playerError";
import { IMAGE_COPY, launchImageFrom, type ModerateResponse } from "@/lib/launchImage";
import { LAUNCHED_LABEL, LAUNCHING_LABEL, launchErrorMessage, launchStillConfirming } from "@/lib/launchError";
import { NAME_LOCK_TAKEN_MSG, fetchNameLock, nameLockEnforced } from "@/lib/nameLock";
import {
  addressOn, defaultLaunchPair, launchPairsForChain,
} from "@/lib/launchWhitelist";
import {
  QUICK_LAUNCH_COPY as C, QUICK_LAUNCH_MODE_CARD, seatLabel, CREATOR_FEE_COPY, CREATOR_FEE_DESTINATION,
  CREATOR_FEE_DESTINATIONS, CREATOR_TAX_HELP, DEFAULT_CREATOR_FEE_DESTINATION,
  buildLaunchSocials, launchNeedsSignIn, liveCreatorFeeDestination,
  normalizeTelegram, normalizeTwitter, normalizeWebsite, privateLaunchHelp,
  readStoredCreatorFeeDestination, readStoredCreatorTax, readStoredUpload, snapCreatorTax,
  storeCreatorFeeDestination, storeCreatorTax, storeUpload, type CreatorFeeDestination,
} from "@/lib/quickLaunch";
import CreatorFeeArt from "@/components/create/CreatorFeeArt";
import s from "@/components/create/quickLaunch.module.css";
import L from "@/components/create/launch.module.css";

const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const modeCard = (label: string) => (label === "Easy" ? QUICK_LAUNCH_MODE_CARD.Easy : label === "Hard" ? QUICK_LAUNCH_MODE_CARD.Hard : QUICK_LAUNCH_MODE_CARD.Trench);
const Shuffle = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></svg>
);
/** "You earn 33% of every trading fee, forever." with the cut picked out, as on the board. */
const FeeLine = ({ text }: { text: string }) => {
  const m = text.match(/^(.*?)(\d+(?:\.\d+)?%)(.*)$/);
  return m ? <span>{m[1]}<b>{m[2]}</b>{m[3]}</span> : <span>{text}</span>;
};

export default function LaunchRocketPage() {
  const router = useRouter();
  const [howOpen, setHowOpen] = useState(false);
  const [phase, setPhase] = useState<LaunchPhase | null>(null);
  const [live, setLive] = useState<{ token: string; dest: string; name: string; ticker: string; mode: number; seat: string; note: string | null } | null>(null);
  const [name, setName] = useState("");
  const [callSign, setCallSign] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [iconSrc, setIconSrc] = useState<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState({ x: 0.5, y: 0.5 });
  const [contrast, setContrast] = useState<string | null>(null);
  const [mod, setMod] = useState<{ state: "idle" | "checking" | ModerationVerdict; uri?: string; note?: string }>({ state: "idle" });
  const [advanced, setAdvanced] = useState(false);
  const [editingLink, setEditingLink] = useState<"twitter" | "website" | "telegram" | null>(null);
  const [gameMode, setGameMode] = useState<number>(DEFAULT_MODE);
  const defaultPair = defaultLaunchPair();
  const defaultPairAddr = addressOn(defaultPair, ACTIVE_CHAIN.id, deployment().defaultQuote);
  const [quote, setQuote] = useState<{ address: Address | null; label: string }>({ address: defaultPairAddr, label: defaultPair.symbol });
  const [twitter, setTwitter] = useState("");
  const [website, setWebsite] = useState("");
  const [telegram, setTelegram] = useState("");
  const [feeReceiver, setFeeReceiver] = useState("");
  const [feeDestination, setFeeDestination] = useState<CreatorFeeDestination>(DEFAULT_CREATOR_FEE_DESTINATION);
  const [croppedUri, setCroppedUri] = useState<string | null>(null);
  const [uploadedUri, setUploadedUri] = useState<string | null>(null);
  const [badgeUri, setBadgeUri] = useState<string | null>(null);
  const [tax, setTax] = useState(0);
  const [privateLaunch, setPrivateLaunch] = useState(false);
  const [boost, setBoost] = useState("");
  const [boostState, setBoostState] = useState<FirstBoostState>({ raw: BigInt(0), usdgIn: null, maxUsdg: null, maxQuoteIn: null, error: null, ready: true, overCap: false });
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);
  const setMsg = (text: string | null) => setStatus(text == null ? null : { text, ok: false });
  const setLaunched = (text: string) => setStatus({ text, ok: true });
  const [nameLockMsg, setNameLockMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // One click = one launch (#231, rebuilt on Quick Launch): the ref blocks re-entry synchronously (state alone lags a
  // render, so rapid clicks / Enter presses got through and one Easy launch fired 4 times). Held from the click until the
  // launch clearly fails. keepLockedRef: the launch went through (the page is leaving for the rocket) or is still
  // confirming (it may still land, so a re-click could launch twice), so the lock is never released.
  const launchingRef = useRef(false);
  const keepLockedRef = useRef(false);
  const [launching, setLaunching] = useState(false);
  const [launchDone, setLaunchDone] = useState(false);
  const howRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!howOpen) return;
    const onPtr = (e: PointerEvent) => { if (howRef.current && !howRef.current.contains(e.target as Node)) setHowOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setHowOpen(false); };
    document.addEventListener("pointerdown", onPtr);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPtr);
      document.removeEventListener("keydown", onKey);
    };
  }, [howOpen]);

  useEffect(() => {
    if (IS_STATIC_PREVIEW || !nameLockEnforced(ACTIVE_CHAIN.id) || !name.trim() || !callSign.trim()) {
      setNameLockMsg(null);
      return;
    }
    const t = setTimeout(() => {
      fetchNameLock(name, callSign).then((r) => {
        setNameLockMsg(r && r.enforced && r.available === false ? (r.reason || NAME_LOCK_TAKEN_MSG) : null);
      }).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [name, callSign]);

  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => onWallet(() => setSignedIn(canTransact())), []);
  const needsSignIn = launchNeedsSignIn({ deployed: isDeployed(), staticPreview: IS_STATIC_PREVIEW, signedIn });
  const signIn = () => {
    setMsg(null);
    if (aaAvailable()) connectPrivy();
    else connectWallet().catch((err) => setMsg(playerError(err)));
  };

  const blocked = mod.state === "block";
  const usingUpload = !!uploadedUri && !blocked;
  const previewIcon = usingUpload ? (croppedUri || uploadedUri) : badgeUri;

  useEffect(() => { preloadModeration(); }, []);
  useEffect(() => {
    shuffleName();
    setTax(readStoredCreatorTax(CURVE.creatorTaxMaxPct));
    setFeeDestination(readStoredCreatorFeeDestination());
    const saved = readStoredUpload();
    if (!saved) return;
    setUploadedUri(saved);
    setCroppedUri(saved);
    setMod({ state: "allow", uri: saved });
    const img = new Image();
    img.src = saved;
    img.decode().then(() => setIconSrc(img)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setBadgeUri(houseBadgeDataUri(callSign) ?? houseBadgeDataUri("ROCKET"));
  }, [callSign]);

  function shuffleName() {
    const n = randomRocketName();
    setName(n);
    setCallSign(tickerVariants(n)[0] ?? "");
  }

  useEffect(() => {
    if (!iconSrc) { setCroppedUri(null); return; }
    const t = setTimeout(() => setCroppedUri(cropSquare(iconSrc, crop)), 120);
    return () => clearTimeout(t);
  }, [iconSrc, crop]);

  function clearUpload() {
    setFile(null); setIconSrc(null); setContrast(null); setCroppedUri(null); setUploadedUri(null); setMod({ state: "idle" });
    storeUpload(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  function setTaxStepped(v: number) {
    const n = snapCreatorTax(v, CURVE.creatorTaxMaxPct);
    setTax(n);
    storeCreatorTax(n);
  }

  function setFeeDest(v: CreatorFeeDestination) {
    setFeeDestination(v);
    storeCreatorFeeDestination(v);
  }


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
    let pre: Awaited<ReturnType<typeof precheckWithin>> | null = null;
    try { pre = await precheckWithin(img, 3000); } catch { pre = null; }
    const ms = Math.round(performance.now() - t0);
    if (pre && pre !== "timeout" && pre.verdict === "block") {
      setIconSrc(null); setContrast(null); setFile(null); setCroppedUri(null); setUploadedUri(null); storeUpload(null);
      return setMod({ state: "block", note: C.imageReverted });
    }
    const uri = cropSquare(img, { x: 0.5, y: 0.5 });
    const pending = !pre || pre === "timeout" || pre.verdict === "review";
    setCroppedUri(uri);
    setUploadedUri(uri);
    storeUpload(uri);
    setMod({ state: "allow", uri, note: pending ? `pending server review (${ms} ms)` : `approved in ${ms} ms` });
    if (!IS_STATIC_PREVIEW) {
      const fd = new FormData(); fd.append("file", f);
      fetch("/api/moderate-image", { method: "POST", body: fd })
        .then((r) => r.json())
        .then((r) => {
          if (r?.verdict === "block") {
            setIconSrc(null); setContrast(null); setFile(null); setCroppedUri(null); setUploadedUri(null); storeUpload(null);
            setMod({ state: "block", note: C.imageReverted });
          }
        })
        .catch(() => { /* server unavailable: keep client verdict (testnet) */ });
    }
  }

  async function storeImage(dataUri: string): Promise<string | null> {
    if (IS_STATIC_PREVIEW) return dataUri;
    const fd = new FormData(); fd.append("uri", dataUri);
    const v = await fetch("/api/moderate-image", { method: "POST", body: fd })
      .then(async (r) => (await r.json().catch(() => null)) as ModerateResponse)
      .catch((err) => { console.warn("[disciple] launch image upload failed", { message: String((err as Error)?.message ?? err).slice(0, 300) }); return null; });
    const li = launchImageFrom(v);
    if (!li.ok) {
      console.warn("[disciple] launch image not usable", { reason: li.reason, detail: li.detail, verdict: v?.verdict });
      setMsg(IMAGE_COPY[li.reason]);
      return null;
    }
    return li.uri;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (launchingRef.current || keepLockedRef.current) return;
    launchingRef.current = true;
    setLaunching(true);
    try {
      await launch();
    } finally {
      if (!keepLockedRef.current) { launchingRef.current = false; setLaunching(false); }
    }
  }

  async function launch() {
    setMsg(null);
    if (needsSignIn) { signIn(); return; }
    if (!name.trim() || !callSign.trim()) {
      setMsg("Give your rocket a name and a ticker.");
      return;
    }
    if (!IS_STATIC_PREVIEW && nameLockEnforced(ACTIVE_CHAIN.id)) {
      const taken = await fetchNameLock(name, callSign);
      if (!taken) {
        setMsg("Couldn't check this name and call sign. Try again in a moment.");
        return;
      }
      if (taken.enforced && taken.available === false) {
        const why = taken.reason || NAME_LOCK_TAKEN_MSG;
        setNameLockMsg(why);
        setMsg(why);
        return;
      }
    }
    const usingBadge = !usingUpload;
    if (!usingBadge && (mod.state !== "allow" || !mod.uri)) {
      setMsg(mod.state === "block" ? C.imageReverted : "Your icon is still being checked (or held for review).");
      return;
    }
    const effTax = tax;
    if (effTax < 0 || effTax > CURVE.creatorTaxMaxPct) {
      setMsg(`Creator tax must be 0–${CURVE.creatorTaxMaxPct}%.`);
      return;
    }
    const quoteAddr = quote.address;
    if (!quoteAddr) {
      setMsg("Pick the coin your rocket is bought and sold in.");
      return;
    }
    // Payout only applies when the creator keeps the fees. The typed value stays in
    // state if they switch back to keep. Do not send a non-default destination to the
    // live Launchpad — liveCreatorFeeDestination() is undefined until contracts are live.
    const keepFees = feeDestination === CREATOR_FEE_DESTINATION.creator;
    const fr = keepFees ? feeReceiver.trim() : "";
    if (fr && !isAddr(fr)) {
      setMsg("Fee receiver must be a 0x wallet address (or leave it empty to use your own).");
      return;
    }
    void liveCreatorFeeDestination(feeDestination);
    const web = normalizeWebsite(website) ?? "";
    if (web !== website.trim()) setWebsite(web);
    if (web && !/^https?:\/\/\S+\.\S+/.test(web)) {
      setMsg("Enter a website like mysite.com");
      return;
    }
    let imageUri: string | null = null;
    if (usingBadge) {
      const badge = badgeUri ?? houseBadgeDataUri(callSign);
      if (!badge) { setMsg("Couldn't make your rocket's badge. Try again, or use your own image."); return; }
      imageUri = await storeImage(badge);
    } else {
      const crop256 = iconSrc ? cropSquare(iconSrc, crop) : mod.uri!;
      imageUri = await storeImage(crop256);
    }
    if (!imageUri) return;
    if (boostState.overCap || exceedsUsdgFirstBoostCap(boostState.usdgIn, boostState.maxUsdg) || exceedsQuoteFirstBoostCap(boostState.raw, boostState.maxQuoteIn)) {
      setMsg(boostState.error || "That's over the First BOOST cap. Lower the amount and try again.");
      return;
    }
    if (boostState.error) { setMsg(boostState.error); return; }
    if (!boostState.ready) { setMsg("Still reading the First BOOST cap. Try again in a moment."); return; }
    const seat = seatLabel(boost);
    const launchMode = privateLaunch ? LaunchMode.TRENCH_WARFARE : gameMode;
    try {
      setPhase("signing");
      const client = isDeployed() ? createViemProtocol() : protocolStub;
      const priv = privateLaunch && isDeployed() ? await newStealthOwner() : undefined;
      const res = await client.launchCoin({
        name: name.trim(),
        ticker: callSign.trim().toUpperCase(),
        imageUri,
        quoteToken: quoteAddr,
        creatorTaxPct: effTax,
        creatorBuyUsdgIn: boostState.usdgIn != null && boostState.usdgIn > BigInt(0) ? boostState.usdgIn : undefined,
        creatorBuyQuoteIn: boostState.usdgIn == null && boostState.raw > BigInt(0) ? boostState.raw : undefined,
        socials: buildLaunchSocials({ twitter, telegram, website: web }),
        mode: priv ? LaunchMode.TRENCH_WARFARE : LAUNCH_ABI_SHAPE === "modes" ? gameMode : undefined,
        private: priv,
      });
      keepLockedRef.current = true;   // the coin exists: never launch it again from this page
      setLaunchDone(true);
      trackFunnel("first_launch"); // funnel counter: once per browser, fails silently
      setPhase("fuelling");
      let note: string | null = null;
      if (fr && isDeployed() && !priv) {
        const me = await activeAddress();
        if (fr.toLowerCase() !== me.toLowerCase()) {
          setLaunched("Launched. Assigning the fee receiver (one more confirmation)…");
          try {
            if (clientGaslessMode()) throw new Error(blockedActionMessage("Launchpad.transferCreator(address,address)"));
            await execCalls([{ to: deployment().launchpad, data: encodeFunctionData({ abi: launchpadAbi, functionName: "transferCreator", args: [res.token, fr as Address] }) }]);
          } catch (err) {
            console.warn("[disciple] fee receiver assignment failed", { token: res.token, feeReceiver: fr, message: String((err as Error)?.message ?? err).slice(0, 300) });
            note = "Launched, but setting the fee receiver didn't go through. You can retry from the rocket page later.";
            setLaunched(note);
          }
        }
      } else {
        await new Promise((r) => window.setTimeout(r, 700));
      }
      const dest = `/coin/${res.token}?cs=${encodeURIComponent(callSign.trim().toUpperCase())}&liftoff=1`;
      setPhase("lifting");
      router.prefetch(dest);
      await new Promise((r) => window.setTimeout(r, 1400));
      setLive({ token: res.token, dest, name: name.trim(), ticker: callSign.trim().toUpperCase(), mode: launchMode, seat, note });
      setPhase(null);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setPhase(null);
      if (!isDeployed()) { setMsg("Launches aren't open on this network yet."); return; }
      console.warn("[disciple] launch failed", { private: privateLaunch, imageUri, message: String((err as Error)?.message ?? err).slice(0, 500), code: (err as { code?: unknown })?.code });
      if (launchStillConfirming(err)) keepLockedRef.current = true;   // unknown outcome: stay locked
      setMsg(launchErrorMessage(err));
    }
  }

  const defaultPairLabel = defaultPair.symbol;

  const modeLabel = MODE_LABEL[privateLaunch ? LaunchMode.TRENCH_WARFARE : gameMode] ?? "Easy";
  const card = modeCard(modeLabel);
  const liveCard = live ? modeCard(MODE_LABEL[live.mode] ?? "Easy") : card;
  const pairSet = quote.label !== defaultPairLabel;
  const linksSet = !!(twitter.trim() || website.trim() || telegram.trim());
  const feesSet = tax > 0 || feeDestination !== DEFAULT_CREATOR_FEE_DESTINATION || (!privateLaunch && !!feeReceiver.trim());

  return (
    <div className={`${L.page} launch-v3`}>
      {live ? (
        <LaunchLiveNow name={live.name} ticker={live.ticker} mode={liveCard.label} modeColor={liveCard.color} seat={live.seat}
          href={live.dest} token={live.token} note={live.note} onOpen={() => router.push(live.dest)} />
      ) : (
      <form className={L.grid} onSubmit={onSubmit}>
        <LaunchPad name={name} ticker={callSign} icon={previewIcon} mode={card.label} modeColor={card.color} seat={seatLabel(boost)} />

        <section className={L.panel} aria-labelledby="lc-title">
          <div className={L.panelHead}>
            <h2 id="lc-title">Launch control</h2>
            <span>4 steps · about a minute</span>
          </div>

          <div className={L.sec}>
            <div className={L.sh}><span className={L.num}>1</span><span className={L.st}>Name it</span><span className={L.sub}>Shuffle for ideas</span></div>
            <div className={L.field}>
              <label className={`${L.inp} ${L.inpBig}`}>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} aria-label={C.name} placeholder="Rocket name" />
              </label>
              <button type="button" className={L.dice} title="Shuffle name" aria-label="Shuffle name" onClick={shuffleName}><Shuffle /></button>
            </div>
            <div className={L.field}>
              <label className={L.inp}>
                <span className={L.pre}>$</span>
                <input value={callSign} onChange={(e) => setCallSign(e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase())} placeholder="TICKER" maxLength={10} aria-label={C.ticker} />
              </label>
              <button type="button" className={L.dice} disabled={!tickerVariants(name).length}
                title={`Shuffle a ticker from the name (${tickerVariants(name).map((t) => "$" + t).join(" · ") || "type a name first"})`}
                aria-label="Shuffle ticker" onClick={() => setCallSign(nextTicker(name, callSign))}><Shuffle /></button>
            </div>
            {nameLockMsg && <p role="status" data-testid="name-lock-taken" className={`${L.help} ${L.bad}`}>{nameLockMsg}</p>}
          </div>

          <div className={L.sec}>
            <div className={L.sh}><span className={L.num}>2</span><span className={L.st}>{C.icon}</span><span className={L.sub}>Goes on the hull</span></div>
            <div className={L.badgeRow}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <span className={L.badgeBig}>{previewIcon && <img src={previewIcon} alt="" width={64} height={64} />}</span>
              <div className={L.chips}>
                <button type="button" className={`${L.chip} ${L.chipTx}${usingUpload ? ` ${L.on}` : ""}`} onClick={() => fileRef.current?.click()}>{usingUpload ? C.changeImage : C.uploadImage}</button>
                <button type="button" className={`${L.chip} ${L.chipTx}${usingUpload ? "" : ` ${L.on}`}`} onClick={() => { if (usingUpload) clearUpload(); }} aria-pressed={!usingUpload}>{C.useGenerated}</button>
              </div>
              <input ref={fileRef} className={s.file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="upload rocket icon" onChange={(e) => onPickFile(e.target.files?.[0] || null)} />
            </div>
            <span className={L.note}>PNG, JPG, WEBP or GIF, up to 2 MB. Every image is checked before it flies.</span>
            {mod.state === "checking" && <span className={L.help}>Checking image…</span>}
            {mod.state === "allow" && usingUpload && <span className={`${L.help} ${L.ok}`}><Icon name="check" size={12} /> Image saved</span>}
            {blocked && <span role="alert" className={`${L.help} ${L.bad}`}>{mod.note || C.imageReverted}</span>}
            {contrast && <span className={`${L.help} ${L.bad}`}><Icon name="warning" size={12} /> {contrast}</span>}
          </div>

          <div className={L.sec} data-testid="mode-cards">
            <div className={L.sh}><span className={L.num}>3</span><span className={L.st}>Difficulty</span><span className={L.sub}>Locked at launch</span></div>
            <div className={L.diffs} role="radiogroup" aria-label="Difficulty">
              {MODE_ORDER.map((id) => {
                const label = MODE_LABEL[id];
                const c = modeCard(label);
                const on = privateLaunch ? id === LaunchMode.TRENCH_WARFARE : gameMode === id;
                return (
                  <button key={id} type="button" role="radio" aria-checked={on} aria-label={c.label} data-testid={`mode-card-${label.toLowerCase()}`}
                    className={`${L.diff}${on ? ` ${L.diffOn}` : ""}`} style={{ ["--mc" as string]: c.color }}
                    onClick={() => { setGameMode(id); if (privateLaunch && id !== MODE_ORDER[MODE_ORDER.length - 1]) setPrivateLaunch(false); }}>
                    <span className={L.band} />
                    {on && <span className={L.tick}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#121327" strokeWidth="3.5" aria-hidden><path d="M5 12l5 5 9-10" /></svg></span>}
                    <span className={L.lbl}>{c.label}</span>
                    {c.nick && <span className={L.nick}>{c.nick}</span>}
                    <p>{c.blurb}</p>
                    <span className={L.meter} aria-hidden>{[1, 2, 3].map((n) => <i key={n} className={n <= c.meter ? L.lit : ""} />)}</span>
                  </button>
                );
              })}
            </div>
            <span className={L.note}>{QUICK_LAUNCH_MODE_CARD.footer}</span>
          </div>

          <div className={L.sec}>
            <div className={L.sh}><span className={L.num}>4</span><span className={L.st}>Your seat</span><span className={L.sub}>First boost, at launch</span></div>
            <FirstBoostField
              variant="seat"
              pair={quote.address} pairLabel={quote.label} creatorTaxBps={Math.round(tax * 100)}
              ticker={callSign.trim().toUpperCase()} value={boost} onChange={setBoost} onState={setBoostState}
              mode={LAUNCH_ABI_SHAPE === "modes" && !privateLaunch ? gameMode : LaunchMode.TRENCH_WARFARE} privateLaunch={privateLaunch}
            />
            <button type="button" className={L.hide} role="switch" aria-checked={privateLaunch} data-testid="private-launch" onClick={() => setPrivateLaunch((v) => !v)}>
              <span className={L.tog} aria-hidden />
              <span className={L.hideTx}>
                <b>Hide my name</b>
                <span>{privateLaunch ? privateLaunchHelp(boost, gameMode) : "You won't show as the host."}</span>
              </span>
            </button>
            {privateLaunch && <span className={L.note} data-testid="private-launch-help">Hidden launches fly on Expert.</span>}
          </div>

          <button type="button" className={L.adv} data-testid="advanced-open" onClick={() => setAdvanced(true)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M4 6h16M4 12h10M4 18h6" /></svg>
            <b>{C.advanced}</b>
            <span className={`${L.pill}${pairSet ? ` ${L.pillOn}` : ""}`}>{pairSet ? `Pair: ${quote.label}` : C.pairCoin}</span>
            <span className={`${L.pill}${linksSet ? ` ${L.pillOn}` : ""}`}>{C.links}</span>
            <span className={`${L.pill}${feesSet ? ` ${L.pillOn}` : ""}`} data-testid="fee-destination-chip">{CREATOR_FEE_COPY[feeDestination].chip || "Host fees"}</span>
            <svg className={L.advGo} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M9 6l6 6-6 6" /></svg>
          </button>

          <button
            type="submit"
            disabled={launching}
            aria-busy={launching}
            data-testid={needsSignIn ? "create-sign-in" : "create-launch"}
            className={L.cta}
          >
            {launching ? (launchDone ? LAUNCHED_LABEL : LAUNCHING_LABEL) : "Light the engines"}
            {!launching && <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>}
          </button>
          <div className={L.ctaFoot} ref={howRef}>
            <span data-testid="creator-fee-split"><FeeLine text={C.creatorFeeSplit} /></span>
            <button type="button" className={L.linkBtn} data-testid="how-launching" aria-expanded={howOpen} onClick={() => setHowOpen((v) => !v)}>{C.howLaunching}</button>
            {howOpen && (
              <div className={L.how} data-testid="how-launching-steps">
                <ol>{C.howLaunchingSteps.map((line, i) => <li key={i}>{line}</li>)}</ol>
              </div>
            )}
          </div>
          {status && <p role="status" className={`${L.status} ${status.ok ? L.ok : L.bad}`}>{status.text}</p>}
        </section>
      </form>
      )}

      {advanced && (
        <>
          <div className={s.scrim} onClick={() => setAdvanced(false)} />
          <div className={s.modal} role="dialog" aria-label={C.advanced} data-testid="advanced-modal">
            <div className={`${s.modalPanel} ${s.wide}`}>
              <div className={s.drawerHd}>
                <h2>{C.advanced}</h2>
                <button type="button" className={s.iconBtn} aria-label="Close" onClick={() => setAdvanced(false)}><Icon name="close" size={16} /></button>
              </div>
              <div className={s.modalBody}>
              <div className={s.fl}>
                <div className={s.lab}>{C.pairCoin}</div>
                <div className={s.pchips} role="listbox" aria-label={C.pairCoin}>
                  {launchPairsForChain(ACTIVE_CHAIN.id).map((coin) => {
                    const addr = addressOn(coin, ACTIVE_CHAIN.id, deployment().defaultQuote);
                    const on = quote.address?.toLowerCase() === addr.toLowerCase();
                    return (
                      <button key={coin.symbol} type="button" role="option" aria-selected={on} className={`${s.pchip} ${on ? s.on : ""}`}
                        onClick={() => setQuote({ address: addr, label: coin.symbol })}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={withBase(coin.image)} alt="" width={20} height={20} />
                        {coin.symbol}
                      </button>
                    );
                  })}
                </div>
                <div className={s.help}>{C.pairHelp}</div>
              </div>
              <div className={s.fl}>
                <div className={s.lab}>{C.links}</div>
                <div className={s.lchips}>
                  <LinkChip kind="twitter" label={C.linkX} short={C.linkXShort} value={twitter} editing={editingLink} setEditing={setEditingLink} onChange={setTwitter}
                    onBlur={() => setTwitter((v) => normalizeTwitter(v) ?? "")}
                    glyph={<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden><path d="M13.8 11.2L21 3h-2.4l-5.5 6.3L8.4 3H3l7.5 10.1L3 21h2.4l6-6.8L15.6 21H21L13.8 11.2zM6 4.5h1.7L18 19.5h-1.7L6 4.5z"/></svg>} />
                  <LinkChip kind="website" label={C.linkWebsite} short={C.linkWebsite} value={website} editing={editingLink} setEditing={setEditingLink}
                    onChange={setWebsite} onBlur={() => setWebsite((w) => normalizeWebsite(w) ?? "")}
                    glyph={<Icon name="external-link" size={14} />} />
                  <LinkChip kind="telegram" label={C.linkTelegram} short={C.linkTelegram} value={telegram} editing={editingLink} setEditing={setEditingLink} onChange={setTelegram}
                    onBlur={() => setTelegram((v) => normalizeTelegram(v) ?? "")}
                    glyph={<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden><path d="M20.8 4.2L2.9 11.1c-1.2.5-1.2 1.1-.2 1.4l4.6 1.4 10.7-6.7c.5-.3.9 0 .6.3l-8.6 7.8-.3 4.7c.5 0 .7-.2 1-.5l2.3-2.2 4.7 3.5c.9.5 1.5.2 1.7-.8l3.1-14.6c.3-1.3-.5-1.9-1.4-1.5z"/></svg>} />
                </div>
              </div>
              <div className={s.fl} data-testid="creator-fee-destination">
                <div className={s.lab}>{C.creatorFees}</div>
                <div className={s.help} data-testid="creator-fee-split-advanced">{C.creatorFeeSplit}</div>
                <div className={s.feeCards} role="radiogroup" aria-label={C.creatorFees}>
                  {CREATOR_FEE_DESTINATIONS.map((id) => {
                    const on = feeDestination === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        data-testid={`fee-destination-${id}`}
                        className={`${s.feeCard} ${on ? s.on : ""}`}
                        onClick={() => setFeeDest(id)}
                      >
                        <span className={s.feeRadio}><i /></span>
                        <div className={s.feeArt}><CreatorFeeArt dest={id} /></div>
                        <div className={s.feeLab}>{CREATOR_FEE_COPY[id].sentence}</div>
                      </button>
                    );
                  })}
                </div>
                <div className={`${s.help} ${s.feePerm}`}>{C.creatorFeesPerm}</div>
              </div>
              {!privateLaunch && feeDestination === CREATOR_FEE_DESTINATION.creator && (
                <div className={s.fl} data-testid="fee-payout">
                  <div className={s.lab}>{C.rewards}</div>
                  <div className={s.row}>
                    <input className={s.inp} value={feeReceiver} onChange={(e) => setFeeReceiver(e.target.value.trim())} placeholder={C.rewardsPlaceholder} aria-label={C.rewards} />
                  </div>
                  <div className={s.help}>{C.rewardsHelp}</div>
                </div>
              )}
              <div className={s.fl}>
                <div className={s.lab}>{C.creatorTax}</div>
                <div className={s.tax}>
                  <button type="button" className={s.taxStep} aria-label="Lower creator tax" disabled={tax <= 0} onClick={() => setTaxStepped(tax - 0.5)}>−</button>
                  <span className={s.taxVal} data-testid="creator-tax-value">{tax}%</span>
                  <button type="button" className={s.taxStep} aria-label="Raise creator tax" disabled={tax >= CURVE.creatorTaxMaxPct} onClick={() => setTaxStepped(tax + 0.5)}>+</button>
                  <input className={s.track} type="range" min={0} max={CURVE.creatorTaxMaxPct} step={0.5} value={tax}
                    aria-label={C.creatorTax}
                    onChange={(e) => setTaxStepped(Number(e.target.value))} />
                </div>
                <div className={s.help} data-testid="creator-tax-help">{CREATOR_TAX_HELP[feeDestination]}</div>
              </div>
              </div>
            </div>
          </div>
        </>
      )}
      {phase && <LaunchCountdown name={name.trim() || "Your rocket"} mode={card.label} phase={phase} />}
    </div>
  );
}

function LinkChip({ kind, label, short, value, editing, setEditing, onChange, onBlur, glyph }: {
  kind: "twitter" | "website" | "telegram";
  label: string; short: string; value: string;
  editing: "twitter" | "website" | "telegram" | null;
  setEditing: (k: "twitter" | "website" | "telegram" | null) => void;
  onChange: (v: string) => void; onBlur?: () => void; glyph: ReactNode;
}) {
  const filled = !!value.trim();
  const open = editing === kind;
  return (
    <button type="button" className={`${s.lchip} ${filled || open ? s.filled : ""}`}
      onClick={() => setEditing(kind)} aria-label={label}>
      <span className={s.g}>{glyph}</span>
      {open ? (
        <input autoFocus value={value} placeholder={label} aria-label={label}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => { onBlur?.(); setEditing(null); }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />
      ) : filled ? (
        <span data-testid={`link-value-${kind}`}>{value}</span>
      ) : (
        <>
          <span className={s.full}>{label}</span>
          <span className={s.short}>{short}</span>
          <span className={s.plus}>+</span>
        </>
      )}
    </button>
  );
}

