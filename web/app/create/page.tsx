"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { newStealthOwner } from "@/lib/privateLaunch";
import { CURVE, MODERATION, type ModerationVerdict } from "@/lib/config";
import { contrastWarning } from "@/lib/decal";
import { houseBadgeDataUri } from "@/lib/decalDefault";
import { precheckWithin, preloadModeration } from "@/lib/moderation-client";
import BrandedRocket from "@/components/BrandedRocket";
import SquareCrop, { cropSquare } from "@/components/create/SquareCrop";
import FirstBoostField, { type FirstBoostState } from "@/components/create/FirstBoostField";
import LiftoffOverlay, { LIFTOFF_MS } from "@/components/create/LiftoffOverlay";
import { protocolStub, type Address } from "@/lib/protocol";
import { LAUNCH_ABI_SHAPE, LaunchMode } from "@/lib/launchAbi";
import { DEFAULT_MODE, MODE, MODE_LABEL, MODE_ORDER } from "@/lib/modeRules";
import { ACTIVE_CHAIN, deployment, isDeployed } from "@/lib/chains";
import { nextTicker, randomRocketName, tickerVariants } from "@/lib/rocketNames";
import { activeAddress, aaAvailable, canTransact, connectPrivy, connectWallet, execCalls, onWallet } from "@/lib/wallet";
import { clientGaslessMode } from "@/lib/aa/sponsorshipMode";
import { blockedActionMessage } from "@/lib/trade/gaslessAction";
import { launchpadAbi } from "@/lib/abi";
import { encodeFunctionData } from "viem";
import { useRouter } from "next/navigation";
import { createViemProtocol } from "@/lib/protocol-viem";
import { IS_STATIC_PREVIEW, withBase } from "@/lib/base-path";
import Icon from "@/components/icons/Icon";
import { CANCELLED_MSG, playerError } from "@/lib/playerError";
import { IMAGE_COPY, LAUNCH_FAILED_MSG, launchImageFrom, type ModerateResponse } from "@/lib/launchImage";
import { NAME_LOCK_TAKEN_MSG, fetchNameLock, nameLockEnforced } from "@/lib/nameLock";
import {
  addressOn, defaultLaunchPair, LAUNCH_WHITELIST,
} from "@/lib/launchWhitelist";
import {
  QUICK_LAUNCH_COPY as C, QUICK_LAUNCH_MODE_COPY, buildLaunchSocials, launchButtonLabel,
  launchNeedsSignIn, privateLaunchHelp, privateLaunchTitle, readStoredCreatorTax, storeCreatorTax, withHttps,
} from "@/lib/quickLaunch";
import s from "@/components/create/quickLaunch.module.css";

const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

const DIFF_BARS: Record<number, number> = { [MODE.EASY]: 1, [MODE.HARD]: 2, [MODE.TRENCH]: 3 };

export default function LaunchRocketPage() {
  const router = useRouter();
  const [screen, setScreen] = useState<"form" | "mode">("form");
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
  const [croppedUri, setCroppedUri] = useState<string | null>(null);
  const [badgeUri, setBadgeUri] = useState<string | null>(null);
  const [tax, setTax] = useState(0);
  const [privateLaunch, setPrivateLaunch] = useState(false);
  const [boost, setBoost] = useState("");
  const [boostState, setBoostState] = useState<FirstBoostState>({ raw: BigInt(0), usdgIn: null, error: null, ready: true });
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);
  const [liftoff, setLiftoff] = useState<string | null>(null);
  const setMsg = (text: string | null) => setStatus(text == null ? null : { text, ok: false });
  const setLaunched = (text: string) => setStatus({ text, ok: true });
  const [nameLockMsg, setNameLockMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
  const usingUpload = !!file && !!iconSrc && !blocked;
  const previewIcon = usingUpload ? croppedUri : badgeUri;

  useEffect(() => { preloadModeration(); }, []);
  useEffect(() => { shuffleName(); setTax(readStoredCreatorTax(CURVE.creatorTaxMaxPct)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    setFile(null); setIconSrc(null); setContrast(null); setCroppedUri(null); setMod({ state: "idle" });
    if (fileRef.current) fileRef.current.value = "";
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
      setIconSrc(null); setContrast(null); setFile(null);
      return setMod({ state: "block", note: C.imageReverted });
    }
    const uri = cropSquare(img, { x: 0.5, y: 0.5 });
    const pending = !pre || pre === "timeout" || pre.verdict === "review";
    setMod({ state: "allow", uri, note: pending ? `pending server review (${ms} ms)` : `approved in ${ms} ms` });
    if (!IS_STATIC_PREVIEW) {
      const fd = new FormData(); fd.append("file", f);
      fetch("/api/moderate-image", { method: "POST", body: fd })
        .then((r) => r.json())
        .then((r) => {
          if (r?.verdict === "block") {
            setIconSrc(null); setContrast(null); setFile(null);
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
      setMsg("Pick a pair coin.");
      return;
    }
    const fr = feeReceiver.trim();
    if (fr && !isAddr(fr)) {
      setMsg("Fee receiver must be a 0x wallet address (or leave it empty to use your own).");
      return;
    }
    const web = withHttps(website);
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
    if (boostState.error) { setMsg(boostState.error); return; }
    if (!boostState.ready) { setMsg("Still reading the First BOOST cap. Try again in a moment."); return; }
    try {
      const client = isDeployed() ? createViemProtocol() : protocolStub;
      const priv = privateLaunch && isDeployed() ? await newStealthOwner() : undefined;
      const res = await client.launchCoin({
        name: name.trim(),
        ticker: callSign.trim().toUpperCase(),
        imageUri,
        quoteToken: quoteAddr,
        creatorTaxPct: effTax,
        creatorBuyUsdgIn: !priv && boostState.usdgIn != null && boostState.usdgIn > BigInt(0) ? boostState.usdgIn : undefined,
        creatorBuyQuoteIn: !priv && boostState.usdgIn == null && boostState.raw > BigInt(0) ? boostState.raw : undefined,
        socials: buildLaunchSocials({ twitter, telegram, website: web }),
        mode: priv ? LaunchMode.TRENCH_WARFARE : LAUNCH_ABI_SHAPE === "modes" ? gameMode : undefined,
        private: priv,
      });
      if (fr && isDeployed() && !priv) {
        const me = await activeAddress();
        if (fr.toLowerCase() !== me.toLowerCase()) {
          setLaunched("Launched. Assigning the fee receiver (one more confirmation)…");
          try {
            if (clientGaslessMode()) throw new Error(blockedActionMessage("Launchpad.transferCreator(address,address)"));
            await execCalls([{ to: deployment().launchpad, data: encodeFunctionData({ abi: launchpadAbi, functionName: "transferCreator", args: [res.token, fr as Address] }) }]);
          } catch (err) {
            console.warn("[disciple] fee receiver assignment failed", { token: res.token, feeReceiver: fr, message: String((err as Error)?.message ?? err).slice(0, 300) });
            setLaunched(`Launched, but setting the fee receiver didn't go through. You can retry from the rocket page later.`);
            return;
          }
        }
      }
      const dest = `/coin/${res.token}?cs=${encodeURIComponent(callSign.trim().toUpperCase())}&liftoff=1`;
      setLiftoff(dest);
      window.setTimeout(() => router.push(dest), LIFTOFF_MS + 200);
    } catch (err) {
      if (!isDeployed()) { setMsg("Launches aren't open on this network yet."); return; }
      const shown = playerError(err);
      console.warn("[disciple] launch failed", { private: privateLaunch, imageUri, message: String((err as Error)?.message ?? err).slice(0, 500), code: (err as { code?: unknown })?.code });
      setMsg(shown === CANCELLED_MSG ? shown : LAUNCH_FAILED_MSG);
    }
  }

  const modeLabel = MODE_LABEL[gameMode] ?? "Easy";

  return (
    <div className={`page-shell ${s.ql}`}>
      <form className={s.wrap} onSubmit={onSubmit}>
        {screen === "mode" ? (
          <>
            <div className={s.title}>
              <button type="button" className={s.back} aria-label="Back" onClick={() => setScreen("form")}>
                <Icon name="chevron-left" size={20} />
              </button>
              <h1>{C.pickMode}</h1>
            </div>
            <div className={s.modes}>
              {MODE_ORDER.map((id) => {
                const label = MODE_LABEL[id];
                const on = gameMode === id;
                const filled = DIFF_BARS[id] ?? 1;
                const copy = label === "Easy" ? QUICK_LAUNCH_MODE_COPY.Easy : label === "Hard" ? QUICK_LAUNCH_MODE_COPY.Hard : QUICK_LAUNCH_MODE_COPY.Trench;
                return (
                  <button type="button" key={id} className={`${s.mcard} ${on ? s.on : ""}`} onClick={() => { setGameMode(id); setScreen("form"); }}>
                    <div className={s.hd}>
                      <span className={s.check}>{on && <Icon name="check" size={12} />}</span>
                      <h2>{label}</h2>
                    </div>
                    <div className={s.diff}>
                      <span className={s.bars} aria-hidden>{[1, 2, 3].map((n) => <i key={n} className={n <= filled ? s.on : ""} />)}</span>
                      <span className={s.diffLbl}>Difficulty: {label}</span>
                    </div>
                    <p>{copy}</p>
                  </button>
                );
              })}
            </div>
            <div className={s.modesFoot}><div className={s.perm}>{QUICK_LAUNCH_MODE_COPY.footer}</div></div>
          </>
        ) : (
          <>
            <div className={s.title}><h1>{C.title}</h1></div>
            <div className={s.grid}>
              <div className={s.form}>
                <div className={s.fl}>
                  <div className={s.lab}>{C.name}</div>
                  <div className={s.row}>
                    <input className={s.inp} value={name} onChange={(e) => setName(e.target.value)} maxLength={32} aria-label="Name" />
                    <button type="button" className={s.dice} title="Shuffle name" aria-label="Shuffle name" onClick={shuffleName}><Icon name="shuffle" size={16} /></button>
                  </div>
                </div>
                <div className={s.fl}>
                  <div className={s.lab}>{C.ticker}</div>
                  <div className={s.row}>
                    <div className={s.inp} style={{ paddingRight: 8 }}>
                      <span className={s.pre}>$</span>
                      <input style={{ flex: 1, minWidth: 0, border: 0, background: "transparent", color: "inherit", font: "inherit", outline: "none", height: "100%" }}
                        value={callSign} onChange={(e) => setCallSign(e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase())} placeholder="TICKER" maxLength={10} aria-label="Ticker" />
                    </div>
                    <button type="button" className={s.dice} disabled={!tickerVariants(name).length}
                      title={`Shuffle a call sign from the name (${tickerVariants(name).map((t) => "$" + t).join(" · ") || "type a name first"})`}
                      aria-label="Shuffle ticker" onClick={() => setCallSign(nextTicker(name, callSign))}><Icon name="shuffle" size={16} /></button>
                  </div>
                </div>
                {nameLockMsg && <p role="status" data-testid="name-lock-taken" className={`${s.msg} ${s.msgBad}`}>{nameLockMsg}</p>}
                <div className={s.fl}>
                  <div className={s.lab}>{C.icon}</div>
                  <div className={s.iconRow}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {previewIcon && <img src={previewIcon} alt="" width={64} height={64} />}
                    <button type="button" className={s.link} onClick={() => fileRef.current?.click()}>{C.useOwnImage}</button>
                    <input ref={fileRef} className={s.file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="upload rocket icon" onChange={(e) => onPickFile(e.target.files?.[0] || null)} />
                  </div>
                  {usingUpload && !blocked && (
                    <div className="crop-row">
                      <SquareCrop img={iconSrc!} pos={crop} onChange={setCrop} />
                      <span className="muted tiny">Images are always cropped square. Drag to choose what shows on your hull.</span>
                    </div>
                  )}
                  {usingUpload && (
                    <button type="button" className={s.link} onClick={clearUpload}>Use the generated badge</button>
                  )}
                  {mod.state === "checking" && <p className={s.msg}>Checking image…</p>}
                  {mod.state === "allow" && file && <p className={`${s.msg} ${s.msgOk}`}><Icon name="check" size={12} /> Icon approved{mod.note ? ` · ${mod.note}` : ""}</p>}
                  {blocked && <p role="alert" className={`${s.msg} ${s.msgBad}`}>{mod.note || C.imageReverted}</p>}
                  {contrast && <p className={`${s.msg} ${s.msgBad}`}><Icon name="warning" size={12} /> {contrast}</p>}
                </div>

                <FirstBoostField
                  variant="chips"
                  pair={quote.address} pairLabel={quote.label} creatorTaxBps={Math.round(tax * 100)}
                  ticker={callSign.trim().toUpperCase()} value={boost} onChange={setBoost} onState={setBoostState}
                  mode={LAUNCH_ABI_SHAPE === "modes" && !privateLaunch ? gameMode : LaunchMode.TRENCH_WARFARE} privateLaunch={privateLaunch}
                />

                <div className={s.foot}>
                  <button
                    type="submit"
                    data-testid={needsSignIn ? "create-sign-in" : "create-launch"}
                    className={s.launch}
                  >
                    {launchButtonLabel(boost)}
                  </button>
                  <button type="button" className={s.modeLink} onClick={() => setScreen("mode")}>
                    Mode: <b>{modeLabel}</b> · change
                  </button>
                  <div className={s.anon}>
                    <button type="button" className={`${s.sw} ${privateLaunch ? s.on : ""}`} role="switch" aria-checked={privateLaunch}
                      data-testid="private-launch" onClick={() => setPrivateLaunch((v) => !v)}>
                      <i />
                    </button>
                    <div className={s.copy}>
                      <div className={s.name}>{privateLaunchTitle(boost)} <span className={s.beta}>{C.beta}</span></div>
                      <div className={s.help}>{privateLaunchHelp(boost)}</div>
                    </div>
                  </div>
                  <button type="button" className={s.advLink} onClick={() => setAdvanced(true)}>{C.advanced}</button>
                </div>
                {status && <p role="status" className={`${s.msg} ${status.ok ? s.msgOk : s.msgBad}`}>{status.text}</p>}
              </div>

              <div className={s.stage}>
                <div className="staging" aria-label="Rocket on the staging block">
                  <div className="staging-sky" />
                  <div className="staging-tower"><span /><span /><span /><span /></div>
                  <div className="staging-rocket"><BrandedRocket height={240} icon={previewIcon} /></div>
                  <div className="staging-block"><span>{callSign ? `$${callSign}` : "$TICKER"}</span></div>
                  <div className="staging-label">{C.ready(name)}</div>
                </div>
              </div>
            </div>
          </>
        )}
      </form>

      {advanced && (
        <>
          <div className={s.scrim} onClick={() => setAdvanced(false)} />
          <div className={s.drawer} role="dialog" aria-label={C.advanced}>
            <div className={s.drawerPanel}>
              <div className={s.grab} />
              <div className={s.drawerHd}>
                <h2>{C.advanced}</h2>
                <button type="button" className={s.iconBtn} aria-label="Close" onClick={() => setAdvanced(false)}><Icon name="close" size={16} /></button>
              </div>
              <div className={s.fl}>
                <div className={s.lab}>{C.pairCoin}</div>
                <div className={s.pchips} role="listbox" aria-label={C.pairCoin}>
                  {LAUNCH_WHITELIST.map((coin) => {
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
                    glyph={<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden><path d="M13.8 11.2L21 3h-2.4l-5.5 6.3L8.4 3H3l7.5 10.1L3 21h2.4l6-6.8L15.6 21H21L13.8 11.2zM6 4.5h1.7L18 19.5h-1.7L6 4.5z"/></svg>} />
                  <LinkChip kind="website" label={C.linkWebsite} short={C.linkWebsite} value={website} editing={editingLink} setEditing={setEditingLink}
                    onChange={setWebsite} onBlur={() => setWebsite((w) => withHttps(w))}
                    glyph={<Icon name="external-link" size={14} />} />
                  <LinkChip kind="telegram" label={C.linkTelegram} short={C.linkTelegram} value={telegram} editing={editingLink} setEditing={setEditingLink} onChange={setTelegram}
                    glyph={<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden><path d="M20.8 4.2L2.9 11.1c-1.2.5-1.2 1.1-.2 1.4l4.6 1.4 10.7-6.7c.5-.3.9 0 .6.3l-8.6 7.8-.3 4.7c.5 0 .7-.2 1-.5l2.3-2.2 4.7 3.5c.9.5 1.5.2 1.7-.8l3.1-14.6c.3-1.3-.5-1.9-1.4-1.5z"/></svg>} />
                </div>
              </div>
              {!privateLaunch && (
                <div className={s.fl}>
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
                  <span className={s.taxVal}>{tax}%</span>
                  <input className={s.track} type="range" min={0} max={CURVE.creatorTaxMaxPct} step={0.1} value={tax}
                    aria-label={C.creatorTax}
                    onChange={(e) => { const v = Number(e.target.value); setTax(v); storeCreatorTax(v); }} />
                </div>
                <div className={s.help}>{C.creatorTaxHelp}</div>
              </div>
              <a className={s.docLink} href="/how-it-works">{C.howLaunching} <Icon name="chevron-right" size={14} /></a>
            </div>
          </div>
        </>
      )}
      {liftoff && <LiftoffOverlay />}
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
        <span>{value.replace(/^https?:\/\//, "").replace(/^@/, "@")}</span>
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

