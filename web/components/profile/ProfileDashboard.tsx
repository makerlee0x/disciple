"use client";

import { useXp } from "@/lib/xpClient";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PROFILE_CHANGED_EVENT, localUsername } from "@/lib/profile";
import { defaultUsername, isAddressLike } from "@/lib/defaultUsername";
import { EMPTY_META, pfpUrl, type ProfileMeta } from "@/lib/profileMeta";
import { fetchProfileMeta } from "@/lib/profileMetaClient";
import { PROFILE_COPY as C } from "@/lib/copy/profile";
import { NO_IDENTITY } from "@/lib/identity";
import { withBase } from "@/lib/base-path";
import { onWallet } from "@/lib/walletState";
import { DEPOSIT_HREF, LEGACY_CASH_HASH, OPEN_SETTINGS_EVENT, SETTINGS_HASHES } from "@/lib/cashLink";
import SettingsModal from "./SettingsModal";
import EditProfileSheet from "./EditProfileSheet";
import IdentitySigil from "./IdentitySigil";
import BioText from "./BioText";
import Pager, { pageCount, pageSlice } from "./Pager";
import { useLivePortfolio } from "./LiveHoldings";
import { useRealActivity } from "./RealActivity";
import PortfolioBlock from "./PortfolioBlock";
import { ChestGlyph } from "./Glyphs";
import { agoLabel, usd2 } from "./money";
import RewardsPopup from "@/components/claims/RewardsPopup";
import { useRewards } from "@/components/claims/useRewards";
import InvitesCard from "@/components/invites/InvitesCard";
import Icon from "@/components/icons/Icon";
import type { ActivityItem } from "@/lib/stats";
import HangarBay from "@/components/hangar/HangarBay";
import HangarSignedOut from "@/components/hangar/HangarSignedOut";
import RocketLooks from "@/components/hangar/RocketLooks";
import type { Progress } from "@/lib/unlocks";
import { Fleet, ServiceRecord, TrophyCase } from "@/components/hangar/HangarSections";
import { useHomeCoins, useLoadout, useTrophies } from "@/components/hangar/hangarData";

const PAGE = { activity: 12 } as const;

/** Activity (real trades only): ↑ BOOST / ↓ DUMP · rocket · dollars · when. */
function Activity({ rows, isPrivate, owner }: { rows: ActivityItem[] | null; isPrivate: boolean; owner: string }) {
  const [page, setPage] = useState(1);
  if (rows == null) return <div className="p5-list" aria-busy="true" data-testid="tab-activity" />;
  if (!rows.length) {
    return isPrivate ? (
      <div className="p5-empty" data-testid="tab-activity">
        <strong>{C["activity.empty.own.title"]}</strong>
        <p>{C["activity.empty.own.body"]}</p>
      </div>
    ) : <div className="p5-empty" data-testid="tab-activity"><p>{C["activity.empty.other"](owner)}</p></div>;
  }
  const pages = pageCount(rows.length, PAGE.activity), p = Math.min(page, pages);
  return (
    <div className="p5-list" data-testid="tab-activity">
      <ul>
        {pageSlice(rows, p, PAGE.activity).map((a) => {
          const boost = a.kind === "buy";
          return (
            <li key={a.id} className="p5-arow">
              <span className={`k ${boost ? "up" : "down"}`}><Icon name={boost ? "arrow-up" : "arrow-down"} size={12} />{boost ? "BOOST" : "DUMP"}</span>
              <span className="r">{a.coin ? <Link href={`/coin/${a.coin}`}>{a.text}</Link> : a.text}</span>
              <span className="u">{a.usd != null ? usd2(a.usd) : ""}</span>
              <span className="t">{agoLabel(a.ts)}</span>
            </li>
          );
        })}
      </ul>
      <Pager page={p} pages={pages} onPage={setPage} />
    </div>
  );
}

/**
 * /profile (own) and /u/[username] (public): the Hangar (canvas boards "Hangar (pilot profile)" and "The bay", take A).
 *   bay: call sign as a title card, bio, level bar, Rewards / Edit profile (own), the pilot's rocket on its pad; under it, Your rocket (earned hulls and flares, own only)
 *   service record: hangar value + today, cash (+ Add cash), flights aboard, rockets launched
 *   Your fleet: rockets aboard (or launched) as the lobby's Live window cards, each with its seat's worth
 *   Your altitude (the portfolio chart) + Flight log | Trophy case + invites (own)
 * Settings opens from the pilot chip (/profile#settings). Everything shown is live; nothing is sample data.
 */
export default function ProfileDashboard({ mode = "private", username }: { mode?: "private" | "public"; username?: string }) {
  const isPrivate = mode === "private";
  const [me, setMe] = useState("");
  useEffect(() => {
    if (!isPrivate) return;
    const read = () => setMe(localUsername());
    read();
    window.addEventListener(PROFILE_CHANGED_EVENT, read);
    return () => window.removeEventListener(PROFILE_CHANGED_EVENT, read);
  }, [isPrivate]);

  const [wallet, setWallet] = useState<string | null>(null);
  // Public /u/<0x…> (leaderboard rows without a username link here): the slug IS the wallet; its claimed username,
  // if any, is looked up below, else the page shows the wallet's space-themed default call sign.
  const slugAddr = !isPrivate && isAddressLike(username) ? username!.toLowerCase() : null;
  const [slugName, setSlugName] = useState<string | null>(null);
  // public: the username lookup finished (a name with no wallet then shows empty, not loading)
  const [resolved, setResolved] = useState(false);
  useEffect(() => {
    if (isPrivate) return onWallet((a) => setWallet(a ? a.toLowerCase() : null));
    if (!username) return;
    let alive = true;
    setResolved(false);
    if (slugAddr) {
      setWallet(slugAddr); setSlugName(null); setResolved(true);
      fetch(`/api/profile/username?address=${slugAddr}`).then((r) => r.json())
        .then((j: { username?: string | null }) => { if (alive) setSlugName(j.username ?? null); }).catch(() => {});
      return () => { alive = false; };
    }
    fetch(`/api/profile/username?resolve=${encodeURIComponent(username)}`).then((r) => r.json())
      .then((j: { address?: string | null }) => { if (alive) setWallet(j.address ?? null); }).catch(() => {})
      .finally(() => { if (alive) setResolved(true); });
    return () => { alive = false; };
  }, [isPrivate, username, slugAddr]);
  // Private, no username saved in this browser: use the wallet's claimed username from the registry.
  useEffect(() => {
    if (!isPrivate || !wallet || localUsername()) return;
    let alive = true;
    fetch(`/api/profile/username?address=${wallet}`).then((r) => r.json())
      .then((j: { username?: string | null }) => { if (alive && j.username) setMe(j.username); }).catch(() => {});
    return () => { alive = false; };
  }, [isPrivate, wallet]);
  const publicName = slugAddr ? (slugName ? `@${slugName}` : defaultUsername(slugAddr)) : `@${username}`;
  const publicUsername = slugAddr ? slugName : username;

  // Picture / banner / bio for the profile's wallet (/api/profile/meta); re-read after a save.
  const [meta, setMeta] = useState<ProfileMeta>(EMPTY_META);
  useEffect(() => {
    let alive = true;
    const read = () => { fetchProfileMeta(wallet).then((m) => { if (alive) setMeta(m); }); };
    if (!wallet) { setMeta(EMPTY_META); return; }
    read();
    window.addEventListener(PROFILE_CHANGED_EVENT, read);
    return () => { alive = false; window.removeEventListener(PROFILE_CHANGED_EVENT, read); };
  }, [wallet]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  // closing clears #settings in place (no navigation or scroll), so the next gear click opens it again
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    if ((SETTINGS_HASHES as readonly string[]).includes(window.location.hash))
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  }, []);
  const [edit, setEdit] = useState<{ focus: "bio" | null } | null>(null);
  const [rewardsOpen, setRewardsOpen] = useState(false);
  // the account menu's Rewards row links to /profile#rewards: open the popup on load and on hashchange
  useEffect(() => {
    if (!isPrivate) return;
    const open = () => { if (window.location.hash === "#rewards") setRewardsOpen(true); };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, [isPrivate]);
  const closeRewards = useCallback(() => {
    setRewardsOpen(false);
    if (window.location.hash === "#rewards") window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  }, []);
  const [toast, setToast] = useState("");
  const toastT = useRef<number | undefined>(undefined);
  const flash = (t: string) => { setToast(t); window.clearTimeout(toastT.current); toastT.current = window.setTimeout(() => setToast(""), 1800); };
  // Settings opens on #settings (lib/cashLink): on load, on hashchange, and on the in-place link event. Old Deposit links
  // (/profile#cash) go to Cash on /wallet, where it lives now.
  useEffect(() => {
    if (!isPrivate) return;
    const open = () => {
      if (window.location.hash === LEGACY_CASH_HASH) { window.location.replace(withBase(DEPOSIT_HREF)); return; }
      if (!(SETTINGS_HASHES as readonly string[]).includes(window.location.hash)) return;
      setSettingsOpen(true);
    };
    open();
    window.addEventListener("hashchange", open);
    window.addEventListener(OPEN_SETTINGS_EVENT, open);
    return () => { window.removeEventListener("hashchange", open); window.removeEventListener(OPEN_SETTINGS_EVENT, open); };
  }, [isPrivate]);

  const owner = (isPrivate ? me : publicUsername) || "";
  const ownerName = owner || defaultUsername(isPrivate ? wallet : slugAddr);
  const pf = useLivePortfolio(wallet);
  const { xp } = useXp(wallet);
  const home = useHomeCoins();
  const trophies = useTrophies(wallet);
  const progress = useMemo<Progress | null>(() => (xp && trophies ? { level: xp.level.level, prestige: xp.level.prestige, trophies: new Set(trophies.keys()) } : null), [xp, trophies]);
  const looks = useLoadout(isPrivate, progress, wallet || null);
  const loadout = looks.loadout;
  const activity = useRealActivity(wallet);
  const rewards = useRewards(isPrivate && !!wallet);

  // /profile signed out: no sample pilot pretending to be you (existing copy only).
  if (isPrivate && !wallet) {
    return (
      <div className="profile-page hg hgo" data-testid="hangar-signedout">
        {/* Settings opens right away, before the wallet resolves; its sections show their own loading / signed-out state */}
        <SettingsModal open={settingsOpen} onClose={closeSettings} />
        <HangarSignedOut loadout={loadout} />
      </div>
    );
  }

  // No username: the wallet's space-themed default call sign (never with an "@"); public /u/<0x…> slugs likewise.
  const handle = isPrivate ? (me ? `@${me}` : defaultUsername(wallet)) : publicName;
  const img = pfpUrl(meta.pfp);
  const noWallet = !isPrivate && resolved && !wallet;
  const holdings = pf ? (pf.ok ? pf.rows : []) : noWallet ? [] : null;

  const launched = home && (wallet || slugAddr) ? [...home.values()].filter((c) => c.creatorAddr === (wallet || slugAddr)).sort((x, y) => y.block - x.block) : null;
  const avatar = img
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={withBase(img)} alt="" width={36} height={36} fetchPriority="high" />
    : <IdentitySigil id={NO_IDENTITY.primary.id} size={22} tip={false} />;
  const bio = meta.bio ? <p className="hg-bio" data-testid="profile-bio"><BioText text={meta.bio} /></p>
    : isPrivate ? <button type="button" className="hg-addbio" onClick={() => setEdit({ focus: "bio" })}><Icon name="plus" size={14} /> {C["profile.bio.empty.own"]}</button> : null;
  const actions = isPrivate ? <>
    {rewards.canClaim
      ? <button type="button" className="dsc3-btn dsc3-btn-primary hg-claim" onClick={() => setRewardsOpen(true)} data-testid="claim-now"><ChestGlyph size={18} /> Claim rewards</button>
      : <button type="button" className="hg-ghost" onClick={() => setRewardsOpen(true)} data-testid="rewards-chest"><ChestGlyph size={18} /> Rewards</button>}
    <button type="button" className="hg-ghost" onClick={() => setEdit({ focus: null })} data-testid="edit-profile-btn">{C["profile.action.edit"]}</button>
    <button type="button" className="hg-ghost" onClick={() => setSettingsOpen(true)} data-testid="hangar-settings-btn">Settings</button>
  </> : null;
  // the cockpit dash (Hangar banner take A): only numbers we really have
  const dash = [
    xp ? { k: "Total XP", v: xp.totalXp.toLocaleString("en-US") } : null,
    trophies ? { k: trophies.size === 1 ? "Trophy" : "Trophies", v: String(trophies.size) } : null,
    launched && launched.length ? { k: launched.length === 1 ? "Rocket launched" : "Rockets launched", v: String(launched.length) } : null,
  ].filter((x): x is { k: string; v: string } => !!x);

  return (
    <div className="profile-page hg">
      {isPrivate && <SettingsModal open={settingsOpen} onClose={closeSettings} />}
      {isPrivate && <EditProfileSheet open={!!edit} focus={edit?.focus} wallet={wallet} meta={meta}
        handle={handle} level={xp?.level ? `Level ${xp.level.level} · ${xp.level.prestigeName}` : undefined}
        onClose={(saved) => { setEdit(null); if (saved) flash(C["edit.saved"]); }} />}
      {isPrivate && <RewardsPopup open={rewardsOpen} onClose={closeRewards} r={rewards} />}
      {toast && <div className="pf-toast" role="status">{toast}</div>}

      <HangarBay handle={handle} bio={bio} avatar={avatar} xp={xp} actions={actions} spend={false} stats={dash} />

      <ServiceRecord pf={noWallet ? { ok: true, cashUsd: 0, rows: [] } : pf} aboard={holdings ? holdings.length : null} launched={launched} isPrivate={isPrivate} />

      {isPrivate && <RocketLooks progress={progress} hull={looks.hull} flare={looks.flare} coin={loadout.coin} setHull={looks.setHull} setFlare={looks.setFlare} note={looks.note} />}

      <Fleet rows={holdings} home={home} launched={launched} isPrivate={isPrivate} owner={ownerName} />

      <div className="hg-cols">
        <div className="hg-colm">
          <PortfolioBlock pf={noWallet ? { ok: true, cashUsd: 0, rows: [] } : pf} isPrivate={isPrivate} title={isPrivate ? "Your altitude" : "Altitude"} />
          <section className="dsc3-panel hg-panel" aria-labelledby="hg-log">
            <header className="hg-panelh"><h2 id="hg-log">Flight log</h2><span>{isPrivate ? "Your boosts and dumps" : "Boosts and dumps"}</span></header>
            <Activity rows={noWallet ? [] : activity} isPrivate={isPrivate} owner={ownerName} />
          </section>
        </div>
        <aside className="hg-cola">
          <TrophyCase got={trophies} />
          {isPrivate && <InvitesCard />}
        </aside>
      </div>
    </div>
  );
}
