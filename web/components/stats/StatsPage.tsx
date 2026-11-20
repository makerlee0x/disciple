"use client";
/**
 * The stats page with live numbers. Own (/achievements): the signed-in wallet, with Share, level rewards and orders.
 * Public (/u/<name>/stats): that pilot's wallet, read-only. Numbers: /api/profile/pilot-stats (ranks + career),
 * /api/xp (level, orders), /api/achievements (trophies), profile meta (picture, display name).
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { withBase } from "@/lib/base-path";
import { STARTER_SKIN, skinArt } from "@/lib/collection";
import { defaultUsername, isAddressLike } from "@/lib/defaultUsername";
import { fetchUsernameStatus } from "@/lib/profile";
import { pfpUrl } from "@/lib/profileMeta";
import { fetchProfileMeta } from "@/lib/profileMetaClient";
import { usePilotWallet, useXp } from "@/lib/xpClient";
import type { PilotStats } from "@/lib/server/pilotStats";
import { useHomeCoins, useTrophies } from "@/components/hangar/hangarData";
import PointsShare from "@/components/points/PointsShare";
import StatsView, { type StatsData } from "./StatsView";
import s from "./stats.module.css";

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

export default function StatsPage({ username }: { username?: string }) {
  const own = !username;
  const { wallet, done } = useWallet(username);
  const { xp } = useXp(wallet);
  const trophies = useTrophies(wallet);
  const home = useHomeCoins();
  const [st, setSt] = useState<PilotStats | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ name: string; pfp: string }>({ name: "", pfp: "" });
  const [share, setShare] = useState(false);

  useEffect(() => {
    setSt(null);
    if (!wallet) return;
    let alive = true;
    fetch(withBase(`/api/profile/pilot-stats?wallet=${wallet}`)).then((r) => (r.ok ? r.json() : null))
      .then((j: PilotStats | null) => { if (alive && j) setSt(j); }).catch(() => {});
    fetchUsernameStatus(wallet).then((r) => { if (alive) setHandle(r.username ? `@${r.username.replace(/^@/, "")}` : null); }).catch(() => {});
    fetchProfileMeta(wallet).then((m) => { if (alive) setMeta({ name: m.name?.trim() ?? "", pfp: pfpUrl(m.pfp) }); }).catch(() => {});
    return () => { alive = false; };
  }, [wallet]);

  const launched = useMemo(() => (home && wallet ? [...home.values()].filter((c) => c.creatorAddr === wallet).length : null), [home, wallet]);

  if (!wallet) {
    if (!done) return <div className={s.page} aria-busy="true" />;
    return (
      <div className={`${s.page} ${s.out}`} data-testid="stats-signedout">
        <h1 className={s.h2}>{own ? "Achievements" : "Pilot not found"}</h1>
        {own && <Link href="/play" prefetch={false} className="dsc3-btn dsc3-btn-primary">Play now</Link>}
      </div>
    );
  }

  const L = xp?.level;
  const d: StatsData = {
    own,
    name: meta.name || handle || defaultUsername(wallet),
    handle: meta.name ? handle : null,
    pfp: meta.pfp,
    rocketArt: skinArt(st?.skin || STARTER_SKIN),
    level: L ? { level: L.level, prestige: L.prestige, prestigeName: L.prestigeName, progress: L.progress } : null,
    season: st?.season ?? null,
    lifetime: st?.lifetime ?? null,
    pnlUsd: st?.pnlUsd ?? null,
    duel: st?.duel ?? null,
    climb: st?.climb ?? null,
    daily: st?.daily ?? null,
    rockets: st?.rockets ?? null,
    career: st ? {
      winRate: st.career?.winRate ?? null, trades: st.career?.trades ?? 0, bestRocket: st.career?.bestRocket ?? null, bestTrade: st.career?.bestTrade ?? null,
      bombs: st.career?.bombs ?? 0, launched: launched ?? 0, longestMs: st.rockets?.longestMs ?? 0, totalXp: xp?.totalXp ?? null,
    } : null,
    trophies,
    orders: own && xp ? { daily: xp.daily.missions, weekly: xp.weekly.missions } : null,
  };
  const at = handle?.replace(/^@/, "");
  return (
    <>
      <StatsView d={d} onShare={own && at && st?.lifetime ? () => setShare(true) : undefined} />
      {own && at && st?.lifetime && <PointsShare handle={at} pts={st.lifetime.pts} rank={st.lifetime.rank} open={share} onClose={() => setShare(false)} />}
    </>
  );
}
