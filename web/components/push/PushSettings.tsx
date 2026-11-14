"use client";
/**
 * Settings · Alerts (main mode hook loop, maker 2026-11-13): turn push alerts on for this device, and one switch per kind
 * (lib/push PUSH_KINDS: only orbit is on by default). At most 3 a day. Hidden until the server has VAPID keys.
 */
import { useCallback, useEffect, useState } from "react";
import Icon, { type IconName } from "@/components/icons/Icon";
import { privyAccessToken } from "@/lib/aa/sessionState";
import { PUSH_KINDS, pushCopy, type PushKind, type PushPrefs } from "@/lib/push";

type State = { configured: boolean; publicKey: string | null; prefs: PushPrefs; devices: number };
const SW = "/push-sw.js", SCOPE = "/push-sw/";
/** row icons in the Settings v2 layout */
const KIND_ICON: Partial<Record<PushKind, IconName>> = { orbit: "altitude", host: "rocket", crew: "crew" };
const keyBytes = (b64u: string) => { const s = atob(b64u.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64u.length + 3) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };

export const PUSH_SETTINGS_COPY = {
  group: "Alerts",
  device: "Alerts on this device", deviceHelp: "Pushes for the switches below. You can turn them off here any time.",
  on: "Turn on", off: "Turn off", blocked: "Alerts are blocked for this site in your browser settings.", unsupported: "This browser can't show push alerts. On iPhone, add DISCIPLE to your Home Screen first.",
} as const;

export default function PushSettings({ wallet }: { wallet: string | null }) {
  const [st, setSt] = useState<State | null>(null);
  const [here, setHere] = useState<PushSubscription | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const supported = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const call = useCallback(async (method: string, b?: object) => {
    if (!wallet) return null;
    const token = await privyAccessToken().catch(() => null);
    const url = method === "GET" ? `/api/push?wallet=${wallet}` : "/api/push";
    const r = await fetch(url, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(b ? { "content-type": "application/json" } : {}) }, body: b ? JSON.stringify({ wallet, ...b }) : undefined, cache: "no-store" }).catch(() => null);
    return r;
  }, [wallet]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await call("GET");
      if (alive && r?.ok) setSt((await r.json()) as State);
      if (supported) { const reg = await navigator.serviceWorker.getRegistration(SCOPE).catch(() => undefined); const sub = await reg?.pushManager.getSubscription().catch(() => null); if (alive) setHere(sub ?? null); }
    })();
    return () => { alive = false; };
  }, [call, supported]);

  if (!wallet || !st?.configured) return null;

  const turnOn = async () => {
    setErr(""); setBusy(true);
    try {
      if ((await Notification.requestPermission()) !== "granted") { setErr(PUSH_SETTINGS_COPY.blocked); return; }
      const reg = await navigator.serviceWorker.register(SW, { scope: SCOPE });
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(st.publicKey!) }));
      const r = await call("POST", { endpoint: sub.endpoint });
      if (!r?.ok) { setErr(((await r?.json().catch(() => null)) as { error?: string } | null)?.error ?? "Couldn't turn alerts on."); return; }
      setHere(sub);
    } catch { setErr("Couldn't turn alerts on."); } finally { setBusy(false); }
  };
  const turnOff = async () => {
    if (!here) return;
    setBusy(true);
    await call("DELETE", { endpoint: here.endpoint });
    await here.unsubscribe().catch(() => false);
    setHere(null); setBusy(false);
  };
  const flip = async (k: PushKind) => {
    const prefs = { ...st.prefs, [k]: !st.prefs[k] };
    setSt({ ...st, prefs });
    const r = await call("PUT", { prefs });
    if (!r?.ok) setSt((v) => (v ? { ...v, prefs: st.prefs } : v));
  };

  return (
    <section className="p5-sgrp" aria-label={PUSH_SETTINGS_COPY.group} data-testid="settings-alerts">
      <span className="gh">{PUSH_SETTINGS_COPY.group}</span>
      <div className="p5-sbox">
        <div className="p5-srow">
          <span className="p5-sic"><Icon name="bell" size={18} /></span>
          <div className="tx"><b>{PUSH_SETTINGS_COPY.device}</b><span>{supported ? PUSH_SETTINGS_COPY.deviceHelp : PUSH_SETTINGS_COPY.unsupported}</span></div>
          {supported && <button type="button" className="p5-btn sm" disabled={busy} onClick={() => void (here ? turnOff() : turnOn())} data-testid="settings-alerts-device">{here ? PUSH_SETTINGS_COPY.off : PUSH_SETTINGS_COPY.on}</button>}
        </div>
        {err && <span className="p5-err" role="alert">{err}</span>}
        {PUSH_KINDS.map((x) => (
          <div className="p5-srow" key={x.k}>
            <span className="p5-sic"><Icon name={KIND_ICON[x.k] ?? "bell"} size={18} /></span>
            <div className="tx"><b>{x.label}</b><span>{x.help}</span></div>
            <button type="button" role="switch" aria-checked={st.prefs[x.k]} aria-label={x.label} className={`p5-switch${st.prefs[x.k] ? " on" : ""}`} data-testid={`settings-alert-${x.k}`} onClick={() => void flip(x.k)}><span /></button>
          </div>
        ))}
        <div className="p5-srow"><div className="tx"><span>{pushCopy.rule}</span></div></div>
      </div>
    </section>
  );
}
