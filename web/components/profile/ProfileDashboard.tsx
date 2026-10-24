"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PROFILE_CHANGED_EVENT, localUsername, profileUrl } from "@/lib/profile";
import { defaultUsername, isAddressLike } from "@/lib/defaultUsername";
import { EMPTY_META, pfpUrl, type ProfileMeta } from "@/lib/profileMeta";
import { fetchProfileMeta } from "@/lib/profileMetaClient";
import { evaluateAchievements } from "@/lib/achievements";
import { lootFromAchievements, LOOT_SLOTS, type LootSlot } from "@/lib/profileLoot";
import { useProfileUrlState } from "@/lib/profileUrlState";
import { LOOT_ENABLED } from "@/lib/features";
import { PROFILE_COPY as C } from "@/lib/copy/profile";
import { SAMPLE_DATA_LABEL } from "@/lib/mock/sample-trades";
import { earnedTitleIds, profileStatsFor, profileStatsSeed, shownTitle, titleDef, titleTooltip } from "@/lib/titles";
import { fmtUsd } from "@/lib/config";
import { PERSONA_BADGES, personaBadge } from "@/lib/identity";
import { prestigeFromPoints } from "@/lib/prestige";
import { withBase } from "@/lib/base-path";
import { onWallet } from "@/lib/wallet";
import SettingsModal from "./SettingsModal";
import EditProfileSheet from "./EditProfileSheet";
import LootPopup, { lootItemId, type LootItem } from "./LootPopup";
import IdentitySigil from "./IdentitySigil";
import Flag from "./Flag";
import BioText from "./BioText";
import { pageCount, pageSlice } from "./Pager";
import { useLiveHoldings } from "./LiveHoldings";
import type { RocketCardRow } from "./tabs/RocketsTab";
import ProfileClaims from "@/components/claims/ProfileClaims";
import ShareModal, { type ShareTarget } from "@/components/share/ShareModal";
import Icon from "@/components/icons/Icon";
import Tooltip from "@/components/ui/Tooltip";
import AchievementsCard from "./AchievementsCard";

// One page (lee 2026-10-24: no tabs). Sections are their own chunks; Loot only behind LOOT_ENABLED.
const Skeleton = () => <div className="pf-skeleton" aria-hidden />;
const RocketsTab = dynamic(() => import("./tabs/RocketsTab"), { loading: Skeleton });
const LootTab = dynamic(() => import("./tabs/LootTab"), { loading: Skeleton });
const ActivityTab = dynamic(() => import("./tabs/ActivityTab"), { loading: Skeleton });

const PAGE = { rockets: 8, loot: 12, activity: 20 } as const;

function fmtHours(v: number) {
  if (v < 1) return `${Math.round(v * 60)}m`;
  if (v < 48) return `${v.toFixed(1)}h`;
  return `${(v / 24).toFixed(1)}d`;
}
const signedUsd = (v: number) => `${v >= 0 ? "+" : "-"}${fmtUsd(Math.abs(v))}`;

/**
 * /profile (private) and /u/[username] (public), one page (lee 2026-10-24):
 *   header (picture, name, flag, rank + level, the ONE chosen title, bio, headline stats, actions) → claims →
 *   main column: achievements progress card (links to /achievements) then Activity (record, PnL chart, feed), always open;
 *   side column: rocket holdings. Mobile stacks header → achievements card → holdings → activity.
 * Stats are SAMPLE until the indexer is live (lib/titles profileStatsFor); live on-chain holdings replace the sample rockets
 * when the wallet has any.
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
  // Private: the signed-in wallet. Public: reverse lookup username → wallet (or the address slug itself).
  useEffect(() => {
    if (isPrivate) return onWallet((a) => setWallet(a ? a.toLowerCase() : null));
    if (!username) return;
    let alive = true;
    if (slugAddr) {
      setWallet(slugAddr); setSlugName(null);
      fetch(`/api/profile/username?address=${slugAddr}`).then((r) => r.json())
        .then((j: { username?: string | null }) => { if (alive) setSlugName(j.username ?? null); }).catch(() => {});
      return () => { alive = false; };
    }
    fetch(`/api/profile/username?resolve=${encodeURIComponent(username)}`).then((r) => r.json())
      .then((j: { address?: string | null }) => { if (alive) setWallet(j.address ?? null); }).catch(() => {});
    return () => { alive = false; };
  }, [isPrivate, username, slugAddr]);
  // Private, no username saved in this browser: use the wallet's claimed username from the registry (claimed on
  // another device), so the default call sign below only shows when there really is no username.
  useEffect(() => {
    if (!isPrivate || !wallet || localUsername()) return;
    let alive = true;
    fetch(`/api/profile/username?address=${wallet}`).then((r) => r.json())
      .then((j: { username?: string | null }) => { if (alive && j.username) setMe(j.username); }).catch(() => {});
    return () => { alive = false; };
  }, [isPrivate, wallet]);
  // Public name: claimed @username, else (address slug without one) the default call sign. Defaults never get an "@".
  const publicName = slugAddr ? (slugName ? `@${slugName}` : defaultUsername(slugAddr)) : `@${username}`;
  const publicUsername = slugAddr ? slugName : username;

  // Picture / bio / flag for the profile's wallet (/api/profile/meta); re-read after a save.
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
  const [edit, setEdit] = useState<{ focus: "bio" | null } | null>(null);
  const [share, setShare] = useState<ShareTarget | null>(null);
  const [toast, setToast] = useState("");
  const flash = (t: string) => { setToast(t); window.setTimeout(() => setToast(""), 1800); };
  useEffect(() => { if (isPrivate && window.location.hash === "#settings") setSettingsOpen(true); }, [isPrivate]);

  const owner = (isPrivate ? me : publicUsername) || "";
  // Same seed as the server's title check (/api/profile/meta): claimed username, else the wallet.
  const seed = profileStatsSeed(owner, isPrivate ? wallet : slugAddr ?? wallet);
  const data = useMemo(() => profileStatsFor(seed), [seed]);
  const { identity } = data;
  const earned = useMemo(() => earnedTitleIds(identity.matched), [identity]);
  const title = shownTitle(meta.title, earned);
  const prestige = prestigeFromPoints(data.points);
  const kpi = (k: string) => data.kpis.find((x) => x.key === k)?.total ?? 0;

  // Loot keeps its ?loot= / ?slot= deep links (only when LOOT_ENABLED); section pages are local.
  const [url, setUrl] = useProfileUrlState();
  const [pg, setPg] = useState({ rockets: 1, loot: 1, activity: 1 });
  const refs = { rockets: useRef<HTMLElement>(null), loot: useRef<HTMLElement>(null), activity: useRef<HTMLElement>(null) };
  const goPage = (k: keyof typeof pg) => (p: number) => {
    setPg((x) => ({ ...x, [k]: p }));
    const el = refs[k].current;
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: "start" });
  };

  // Rockets: live holdings when the wallet has any, otherwise the sample rows. Both capped at a page of 12.
  const live = useLiveHoldings(wallet);
  // Display name for the tabs' empty-state copy: the username, else the default call sign (address slug / no username yet).
  const ownerName = owner || defaultUsername(isPrivate ? wallet : slugAddr);
  const rocketRows: RocketCardRow[] = useMemo(() => {
    if (live && live.length) {
      return live.map((h) => {
        const ch = h.tokens * (h.priceNow - h.price24h);
        const tk = h.symbol || h.coin.slice(2, 6).toUpperCase();
        return { key: h.coin, href: `/coin/${h.coin}`, ticker: tk, name: h.coin.slice(0, 6) + "…" + h.coin.slice(-4), amount: h.usd, signed: false, sub: C["rockets.live.change"](signedUsd(ch)),
          share: () => setShare({ coin: h.coin, ticker: tk, wallet, username: owner || null }) };
      });
    }
    return [...data.rockets].sort((a, b) => b.pnl - a.pnl).map((r) => ({
      key: r.token, href: `/coin/${r.token}`, ticker: r.ticker, name: r.name, tier: r.tierName, amount: r.pnl, signed: true,
      share: () => setShare({ coin: r.token, ticker: r.ticker, wallet, username: owner || null }),
    }));
  }, [live, data.rockets, wallet, owner]);
  const rocketsSample = !(live && live.length);

  // Achievements (unlocked → in progress → locked) and the loot they grant.
  const achievements = useMemo(() => {
    const order = { unlocked: 0, in_progress: 1, locked: 2 } as const;
    return evaluateAchievements(data).sort((x, y) => order[x.state] - order[y.state]);
  }, [data]);
  const loot = useMemo(() => lootFromAchievements(achievements), [achievements]);
  const lootFilter = (LOOT_SLOTS as readonly string[]).includes(url.filter ?? "") ? (url.filter as LootSlot) : null;
  const lootShown = useMemo(() => (lootFilter ? loot.filter((p) => p.slot === lootFilter) : loot), [loot, lootFilter]);
  const lootCounts = useMemo(() => {
    const c = { all: loot.length, skin: 0, trail: 0, frame: 0 };
    for (const p of loot) c[p.slot]++;
    return c;
  }, [loot]);

  const pages = {
    rockets: pageCount(rocketRows.length, PAGE.rockets), loot: pageCount(lootShown.length, PAGE.loot), activity: pageCount(data.activity.length, PAGE.activity),
  };
  const page = { rockets: Math.min(pg.rockets, pages.rockets), loot: Math.min(pg.loot, pages.loot), activity: Math.min(pg.activity, pages.activity) };

  // Loot popup = the open page of Loot; ?loot=<id> deep-links one (and jumps to its page).
  const popupItems: LootItem[] = useMemo(
    () => (LOOT_ENABLED ? pageSlice(lootShown, page.loot, PAGE.loot).map((part) => ({ kind: "part", part }) as LootItem) : []),
    [lootShown, page.loot]);
  useEffect(() => {
    if (!url.loot || !LOOT_ENABLED) return;
    const i = lootShown.map((p) => p.id).indexOf(url.loot);
    if (i < 0) return;
    const want = Math.floor(i / PAGE.loot) + 1;
    setPg((x) => (x.loot === want ? x : { ...x, loot: want }));
  }, [url.loot, lootShown]);
  const popupIndex = url.loot ? popupItems.findIndex((it) => lootItemId(it) === url.loot) : -1;
  const openPopup = (i: number) => setUrl({ loot: lootItemId(popupItems[i]) });
  const stepPopup = useCallback((i: number) => setUrl({ loot: lootItemId(popupItems[i]) }, "replace"), [popupItems, setUrl]);
  const closePopup = useCallback(() => setUrl({ loot: null }), [setUrl]);

  const shareProfile = () => {
    const path = owner ? profileUrl(owner) : window.location.pathname;
    try { navigator.clipboard?.writeText(`${window.location.origin}${withBase(path)}`); flash(C["profile.share.copied"]); } catch { /* no clipboard */ }
  };

  // /profile signed out: no sample pilot pretending to be you (existing copy only).
  if (isPrivate && !wallet) {
    return (
      <div className="profile-page pf-v3">
        <header className="pf-head pf-signedout" data-testid="profile-identity">
          <h1 className="pf-name">Your Profile</h1>
          <p className="muted">Sign in (top right)</p>
        </header>
      </div>
    );
  }

  // No username: the wallet's space-themed default call sign (never with an "@"); public /u/<0x…> slugs likewise.
  const handle = isPrivate ? (me ? `@${me}` : defaultUsername(wallet)) : publicName;
  const img = pfpUrl(meta.pfp);
  const ring = data.rank.border;
  const badge = PERSONA_BADGES[personaBadge(identity)];
  // Nothing earned: the old "Pilgrim" placeholder (not a title, not pickable).
  const titleD = title ? titleDef(title) : identity.primary;
  const titleTip = title ? titleTooltip(title) : identity.primary.blurb;
  const rpnl = kpi("rpnl");

  return (
    <div className="profile-page pf-v3">
      {share && <ShareModal target={share} onClose={() => setShare(null)} />}
      {isPrivate && <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />}
      {isPrivate && <EditProfileSheet open={!!edit} focus={edit?.focus} wallet={wallet} meta={meta}
        onClose={(saved) => { setEdit(null); if (saved) flash(C["edit.saved"]); }} />}
      <LootPopup items={popupItems} index={popupIndex >= 0 ? popupIndex : null} onIndex={stepPopup} onClose={closePopup} />
      {toast && <div className="pf-toast" role="status">{toast}</div>}

      <header className="pf-head" data-testid="profile-identity">
        <button type="button" className="pf-avatar" style={{ ["--pf-ring" as string]: ring }} disabled={!isPrivate}
          onClick={isPrivate ? () => setEdit({ focus: null }) : undefined} aria-label={isPrivate ? C["profile.action.edit"] : undefined} tabIndex={isPrivate ? 0 : -1}>
          {img
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={withBase(img)} alt="" width={112} height={112} fetchPriority="high" />
            : <IdentitySigil id={title ?? identity.primary.id} size={64} tip={false} />}
        </button>

        <div className="pf-id">
          <h1 className="pf-name"><span>{handle}</span>{meta.flag && <Flag cc={meta.flag} size={20} />}</h1>
          <div className="pf-rankrow">
            <span className="pf-rank" style={{ color: ring, borderColor: ring }} aria-label={C["profile.rank.aria"](data.rank.label)}>{data.rank.label}</span>
            <span className="pf-lvl" aria-label={C["profile.level.aria"](prestige.level)}>{C["profile.level"](prestige.level)}</span>
          </div>
          {titleD && (
            <div className="pf-tags">
              <Tooltip content={<><strong>{titleD.label}</strong>{titleTip}</>}>
                <span className="pf-tag primary" data-testid="profile-title">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {titleD === identity.primary && <img src={withBase(badge.icon)} alt="" width={14} height={14} />}
                  {titleD.label}
                </span>
              </Tooltip>
            </div>
          )}
          {meta.bio ? <p className="pf-bio" data-testid="profile-bio"><BioText text={meta.bio} /></p>
            : isPrivate ? <button type="button" className="pf-btn-text pf-addbio" onClick={() => setEdit({ focus: "bio" })}>{C["profile.bio.empty.own"]}</button> : null}
        </div>

        <div className="pf-side">
          <div className="pf-actions">
            {isPrivate ? <>
              <button type="button" className="ds-btn pf-btn-secondary" onClick={() => setEdit({ focus: null })} data-testid="edit-profile-btn">{C["profile.action.edit"]}</button>
              <button type="button" className="ds-btn pf-icon-btn" aria-label={C["profile.action.share"]} onClick={shareProfile}><Icon name="share" size={16} /></button>
              <button type="button" className="ds-btn pf-icon-btn" aria-label="Settings" onClick={() => setSettingsOpen(true)}><Icon name="gear" size={16} /></button>
            </> : (
              <button type="button" className="ds-btn pf-btn-secondary pf-share-wide" onClick={shareProfile}><Icon name="share" size={16} /> {C["profile.action.share"]}</button>
            )}
          </div>
          <div className="pf-stats" title={SAMPLE_DATA_LABEL}>
            <div className={`pf-stat ${rpnl >= 0 ? "pos" : "neg"}`}><span>Realized PnL</span><strong>{signedUsd(rpnl)}</strong></div>
            <div className="pf-stat"><span>{C["profile.stat.winrate"]}</span><strong>{Math.round(kpi("wr"))}%</strong></div>
            <div className="pf-stat"><span>{C["profile.stat.bombs"]}</span><strong>{data.metrics.bombCount}</strong></div>
          </div>
        </div>
      </header>

      {isPrivate && <ProfileClaims />}

      <div className="pf-body">
        <div className="pf-main">
          <AchievementsCard total={achievements.length} />
          <section className="pf-section pf-activity" ref={refs.activity} aria-labelledby="pf-h-activity">
            <h2 id="pf-h-activity" className="pf-section-h">{C["profile.tab.activity"]}</h2>
            <ActivityTab record={[
              { label: "Volume", value: fmtUsd(kpi("vol")) },
              { label: "Avg hold", value: fmtHours(kpi("hold")) },
              { label: "Biggest W", value: fmtUsd(data.ct.biggestW), tone: "pos" },
              { label: "Biggest L", value: fmtUsd(data.ct.biggestL), tone: "neg" },
              { label: C["activity.record.grads"], value: String(data.ct.graduationsWitnessed) },
              { label: "Rugged count", value: String(data.ct.ruggedCount) },
            ]} pnl={data.cumulativePnl} rows={pageSlice(data.activity, page.activity, PAGE.activity)} total={data.activity.length} page={page.activity} pages={pages.activity}
              onPage={goPage("activity")} isPrivate={isPrivate} owner={ownerName} />
          </section>
          {LOOT_ENABLED && (
            <section className="pf-section" ref={refs.loot} aria-labelledby="pf-h-loot">
              <h2 id="pf-h-loot" className="pf-section-h">{C["profile.tab.loot"]}</h2>
              <LootTab rows={pageSlice(lootShown, page.loot, PAGE.loot)} total={lootShown.length} counts={lootCounts} filter={lootFilter}
                onFilter={(f) => { setUrl({ filter: f, loot: null }); setPg((x) => ({ ...x, loot: 1 })); }} page={page.loot} pages={pages.loot} onPage={goPage("loot")} onOpen={openPopup}
                isPrivate={isPrivate} owner={ownerName} onSeeAchievements={() => { window.location.href = withBase("/achievements"); }} />
            </section>
          )}
        </div>
        <aside className="pf-aside" aria-labelledby="pf-h-rockets">
          <section className="pf-section pf-holdings" ref={refs.rockets}>
            <h2 id="pf-h-rockets" className="pf-section-h">{C["profile.tab.rockets"]}</h2>
            <RocketsTab rows={pageSlice(rocketRows, page.rockets, PAGE.rockets)} total={rocketRows.length} page={page.rockets} pages={pages.rockets} onPage={goPage("rockets")}
              isPrivate={isPrivate} owner={ownerName} sample={rocketsSample} />
          </section>
        </aside>
      </div>
    </div>
  );
}
