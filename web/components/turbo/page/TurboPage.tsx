"use client";
/**
 * The Turbo page with live numbers. Own (/turbo): the signed-in wallet, with Turbo cash and Add / Withdraw (the Turbo popup).
 * Public (/u/<name>/turbo): that pilot's wallet, read-only, no balance. Numbers: /api/turbo/profile (lib/server/turboProfile),
 * Turbo cash (lib/turbo/turboCash), profile meta (picture, display name). Signed out: the play cards only.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { withBase } from "@/lib/base-path";
import { defaultUsername, isAddressLike } from "@/lib/defaultUsername";
import { fetchUsernameStatus } from "@/lib/profile";
import { pfpUrl } from "@/lib/profileMeta";
import { fetchProfileMeta } from "@/lib/profileMetaClient";
import { usePilotWallet } from "@/lib/xpClient";
import { onTurboCash, turboCash, wantTurboRead, type TurboCash } from "@/lib/turbo/turboCash";
import { openTurbo } from "@/lib/turbo/turboPill";
import { turboBlockedCached } from "@/lib/turbo/region";
import { isNativeApp } from "@/lib/native";
import type { TurboProfile } from "@/lib/turbo/profile";
import TurboView, { type TurboData } from "./TurboView";
import { TURBO_PAGE_MODES } from "./modes";
import s from "./turbo-page.module.css";

function useWallet(username?: string): { wallet: string | null; done: boolean } {
  const own = usePilotWallet();
  const [w, setW] = useState<{ wallet: string | null; done: boolean }>({ wallet: null, done: false });
  useEffect(() => {
    if (!username) return;
    if (isAddressLike(username)) { setW({ wallet: username.toLowerCase(), done: true }); return; }
    let alive = true;
    fetch(withBase(`/api/profile/username?resolve=${encodeURIComponent(username)}`)).then((r) => r.json())
      .then((j: { address?: string | null }) => { if (alive) setW({ wallet: j.address?.toLowerCase() ?? null, done: true }); })
      .catch(() => { if (alive) setW({ wallet: null, done: true }); });
    return () => { alive = false; };
  }, [username]);
  return username ? w : { wallet: own, done: true };
}

/** Turbo cash for the own page: the same read the Turbo pill makes */
function useTurboCash(wallet: string | null, on: boolean): TurboCash | null {
  const [t, setT] = useState<TurboCash | null>(null);
  useEffect(() => {
    if (!on || !wallet) return;
    const off = onTurboCash(setT), stop = wantTurboRead();
    setT(turboCash());
    return () => { off(); stop(); };
  }, [wallet, on]);
  return t;
}

export const pilotTurboHref = (name: string, wallet: string) => `/u/${encodeURIComponent(name.startsWith("@") ? name.slice(1) : wallet)}/turbo`;

export default function TurboPage({ username }: { username?: string }) {
  const own = !username;
  const { wallet, done } = useWallet(username);
  const cash = useTurboCash(wallet, own);
  const [p, setP] = useState<TurboProfile | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ name: string; pfp: string }>({ name: "", pfp: "" });
  const [blocked, setBlocked] = useState(false);
  useEffect(() => { setBlocked(turboBlockedCached()); }, []);

  useEffect(() => {
    setP(null);
    if (!wallet) return;
    let alive = true;
    fetch(withBase(`/api/turbo/profile?wallet=${wallet}`)).then((r) => (r.ok ? r.json() : null))
      .then((j: TurboProfile | null) => { if (alive && j) setP(j); }).catch(() => {});
    fetchUsernameStatus(wallet).then((r) => { if (alive) setHandle(r.username ? `@${r.username.replace(/^@/, "")}` : null); }).catch(() => {});
    fetchProfileMeta(wallet).then((m) => { if (alive) setMeta({ name: m.name?.trim() ?? "", pfp: pfpUrl(m.pfp) }); }).catch(() => {});
    return () => { alive = false; };
  }, [wallet]);

  if (!wallet) {
    if (!done) return <div className={s.page} aria-busy="true" />;
    if (!own) return <div className={s.page} data-testid="turbo-page"><div className={s.empty}>Pilot not found</div><p><Link href="/turbo" className={s.link}>Turbo</Link></p></div>;
    // signed out: just the games (the duel demo needs no sign-in)
    return <TurboView d={{ anon: true, own: false, name: "", handle: null, pfp: "", balance: null, p: null, modes: TURBO_PAGE_MODES, pilotHref: pilotTurboHref }} />;
  }
  const d: TurboData = {
    own,
    name: meta.name || handle || defaultUsername(wallet),
    handle: meta.name ? handle : null,
    pfp: meta.pfp,
    balance: cash ? cash.usd : null,
    p,
    modes: TURBO_PAGE_MODES,
    pilotHref: pilotTurboHref,
  };
  const money = own && !blocked && !isNativeApp();   // no Turbo cash moves in the iPhone app (App Review 3.1.5(iii))
  return <TurboView d={d} onAdd={money && cash?.canAdd ? () => openTurbo("add") : undefined} onWithdraw={money && cash?.canWithdraw ? () => openTurbo("out") : undefined} />;
}
