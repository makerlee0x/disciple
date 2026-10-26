"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PROFILE_CHANGED_EVENT, localUsername, profileUrl } from "@/lib/profile";
import { defaultUsername, isAddressLike } from "@/lib/defaultUsername";
import { EMPTY_META, pfpUrl, type ProfileMeta } from "@/lib/profileMeta";
import { fetchProfileMeta } from "@/lib/profileMetaClient";
import { lootFromAchievements, LOOT_SLOTS, type LootSlot } from "@/lib/profileLoot";
import { PROFILE_TABS, useProfileUrlState, type ProfileTab } from "@/lib/profileUrlState";
import { LOOT_ENABLED } from "@/lib/features";
import { PROFILE_COPY as C } from "@/lib/copy/profile";
import { useProfileStats } from "@/lib/profileStats";
import { fmtUsd } from "@/lib/config";
import { PERSONA_BADGES, identityRuleText, personaBadge } from "@/lib/identity";
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
import { useCoinIcons } from "@/lib/useCoinIcons";
import type { RocketCardRow } from "./tabs/RocketsTab";
import ProfileClaims from "@/components/claims/ProfileClaims";
import ShareModal, { type ShareTarget } from "@/components/share/ShareModal";
import Icon from "@/components/icons/Icon";

// Only the open tab mounts; each tab is its own chunk, prefetched on hover / touchstart of its tab button.
const TAB_LOADERS = {
  rockets: () => import("./tabs/RocketsTab"),
  loot: () => import("./tabs/LootTab"),
  achievements: () => import("./tabs/AchievementsTab"),
  activity: () => import("./tabs/ActivityTab"),
} as const;
const Skeleton = () => <div className="pf-skeleton" aria-hidden />;
const RocketsTab = dynamic(TAB_LOADERS.rockets, { loading: Skeleton });
const LootTab = dynamic(TAB_LOADERS.loot, { loading: Skeleton });
const AchievementsTab = dynamic(TAB_LOADERS.achievements, { loading: Skeleton });
const ActivityTab = dynamic(TAB_LOADERS.activity, { loading: Skeleton });

const PAGE = { rockets: 12, loot: 12, achievements: 12, activity: 20 } as const;
const MAX_TAGS = 4;

function fmtHours(v: number) {
  if (v < 1) return `${Math.round(v * 60)}m`;
  if (v < 48) return `${v.toFixed(1)}h`;
  return `${(v / 24).toFixed(1)}d`;
}
const signedUsd = (v: number) => `${v >= 0 ? "+" : "-"}${fmtUsd(Math.abs(v))}`;
const DASH = "—";

/**
 * /profile (private) and /u/[username] (public). Header (picture, @username, flag, rank + level, identity tags, bio,
 * 3 headline stats, actions) then four bounded tabs: Rockets · Loot · Achievements · Activity, paged, state in the URL.
 * Every number is real: the wallet's indexed trades (lib/profileStats) and its on-chain holdings. Nothing yet → $0 / "—"
 * and each tab's empty state. No sample pilot in production (`next dev` + ?sample=1 loads the seeded persona).
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

  const { data, summary, ready, sample } = useProfileStats(wallet);
  const { identity } = data;
  const prestige = prestigeFromPoints(data.points);
  const kpi = (k: string) => data.kpis.find((x) => x.key === k)?.total ?? 0;

  const [url, setUrl] = useProfileUrlState();
  const tabBar = useRef<HTMLDivElement>(null);
  const goPage = (p: number) => {
    setUrl({ page: p, loot: null });
    const el = tabBar.current;
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: "start" });
  };
  const goTab = (t: ProfileTab) => setUrl({ tab: t, page: 1, loot: null, filter: null });

  // Rockets: live holdings when the wallet has any, otherwise the rockets it traded (real realized PnL), else empty.
  const live = useLiveHoldings(wallet);
  const owner = (isPrivate ? me : publicUsername) || "";
  // Display name for the tabs' empty-state copy: the username, else the default call sign (address slug / no username yet).
  const ownerName = owner || defaultUsername(isPrivate ? wallet : slugAddr);
  // each row's own coin image (moderated store); none ⇒ PairArt's current placeholder
  const rowCoins = useMemo(() => (live && live.length ? live.map((h) => h.coin) : data.rockets.map((r) => r.token)), [live, data.rockets]);
  const coinIcons = useCoinIcons(sample ? [] : rowCoins);
  const rocketRows: RocketCardRow[] = useMemo(() => {
    if (live && live.length) {
      return live.map((h) => {
        const ch = h.tokens * (h.priceNow - h.price24h);
        const tk = h.symbol || h.coin.slice(2, 6).toUpperCase();
        return { key: h.coin, href: `/coin/${h.coin}`, ticker: tk, name: h.coin.slice(0, 6) + "…" + h.coin.slice(-4), amount: h.usd, signed: false, sub: C["rockets.live.change"](signedUsd(ch)), icon: coinIcons[h.coin.toLowerCase()],
          share: () => setShare({ coin: h.coin, ticker: tk, wallet, username: owner || null }) };
      });
    }
    return [...data.rockets].sort((a, b) => b.pnl - a.pnl).map((r) => ({
      key: r.token, href: `/coin/${r.token}`, ticker: r.ticker, name: r.name, tier: r.tierName, amount: r.pnl, signed: true, icon: coinIcons[r.token.toLowerCase()],
      share: () => setShare({ coin: r.token, ticker: r.ticker, wallet, username: owner || null }),
    }));
  }, [live, data.rockets, wallet, owner, coinIcons]);
  const rocketsSample = sample && !(live && live.length);

  // Achievements: only the ones earned from real trades (dev sample: unlocked → in progress → locked), and their loot.
  const achievements = useMemo(() => {
    if (!sample) return data.achievements.filter((a) => a.state === "unlocked");
    const order = { unlocked: 0, in_progress: 1, locked: 2 } as const;
    return [...data.achievements].sort((x, y) => order[x.state] - order[y.state]);
  }, [data, sample]);
  const unlocked = achievements.filter((a) => a.state === "unlocked").length;
  const loot = useMemo(() => lootFromAchievements(achievements), [achievements]);
  const lootFilter = (LOOT_SLOTS as readonly string[]).includes(url.filter ?? "") ? (url.filter as LootSlot) : null;
  const lootShown = useMemo(() => (lootFilter ? loot.filter((p) => p.slot === lootFilter) : loot), [loot, lootFilter]);
  const lootCounts = useMemo(() => {
    const c = { all: loot.length, skin: 0, trail: 0, frame: 0 };
    for (const p of loot) c[p.slot]++;
    return c;
  }, [loot]);

  const total = { rockets: rocketRows.length, loot: lootShown.length, achievements: achievements.length, activity: data.activity.length }[url.tab];
  const pages = pageCount(total, PAGE[url.tab]);
  const page = Math.min(url.page, pages);

  // Popup items = the open page of Loot / Achievements; ?loot=<id> deep-links one (and jumps to its page).
  const popupItems: LootItem[] = useMemo(() => {
    if (url.tab === "loot") return pageSlice(lootShown, page, PAGE.loot).map((part) => ({ kind: "part", part }));
    if (url.tab === "achievements") return pageSlice(achievements, page, PAGE.achievements).map((a) => ({ kind: "ach", a }));
    return [];
  }, [url.tab, lootShown, achievements, page]);
  useEffect(() => {
    if (!url.loot) return;
    const list = url.tab === "loot" ? lootShown.map((p) => p.id) : url.tab === "achievements" ? achievements.map((a) => a.id) : [];
    const i = list.indexOf(url.loot);
    if (i < 0) return;
    const want = Math.floor(i / PAGE.loot) + 1;
    if (want !== page) setUrl({ page: want }, "replace");
  }, [url.loot, url.tab, lootShown, achievements, page, setUrl]);
  const popupIndex = url.loot ? popupItems.findIndex((it) => lootItemId(it) === url.loot) : -1;
  const openPopup = (i: number) => setUrl({ loot: lootItemId(popupItems[i]) });
  const stepPopup = useCallback((i: number) => setUrl({ loot: lootItemId(popupItems[i]) }, "replace"), [popupItems, setUrl]);
  const closePopup = useCallback(() => setUrl({ loot: null }), [setUrl]);

  const shareProfile = () => {
    const path = owner ? profileUrl(owner) : window.location.pathname;
    try { navigator.clipboard?.writeText(`${window.location.origin}${withBase(path)}`); flash(C["profile.share.copied"]); } catch { /* no clipboard */ }
  };
  const [tagsOpen, setTagsOpen] = useState(false);
  const [tagInfo, setTagInfo] = useState<string | null>(null);

  // /profile signed out: no sample pilot pretending to be you (existing copy only).
  if (isPrivate && !wallet) {
    return (
      <div className="profile-page pf-v3">
        <header className="pf-head pf-signedout" data-testid="profile-identity">
          <h1 className="pf-name">Your Profile</h1>
          <p className="muted">Sign in to see this.</p>
        </header>
      </div>
    );
  }

  // No username: the wallet's space-themed default call sign (never with an "@"); public /u/<0x…> slugs likewise.
  const handle = isPrivate ? (me ? `@${me}` : defaultUsername(wallet)) : publicName;
  const img = pfpUrl(meta.pfp);
  const ring = data.rank.border;
  const badge = PERSONA_BADGES[personaBadge(identity)];
  const tags = [{ id: identity.primary.id, label: identity.primary.label, primary: true, rule: `${identityRuleText(identity.primary.id)}. ${badge.blurb}` },
    ...identity.secondary.map((t) => ({ id: t.id, label: t.label, primary: false, rule: identityRuleText(t.id) }))];
  const shownTags = tagsOpen ? tags : tags.slice(0, MAX_TAGS);
  // Header numbers: the server's summary from indexed trades (same for every visitor; PnL is public). Dev sample uses its own.
  const rpnl = sample ? kpi("rpnl") : summary?.realizedPnlUsd ?? 0;
  const traded = ready && data.metrics.tradeCount > 0;
  const closed = sample ? data.metrics.closedTrades > 0 : (summary?.closedTrades ?? 0) > 0;
  const statsOk = ready && (sample || !!summary);   // failed read ⇒ "—", never a fake $0
  const winPct = sample ? Math.round(kpi("wr")) : Math.round((summary?.winRate ?? 0) * 100);
  const bombsDropped = sample ? data.metrics.bombCount : summary?.bombsDropped ?? 0;
  const tabCount = { rockets: String(rocketRows.length), loot: LOOT_ENABLED ? String(loot.length) : "", achievements: sample ? `${unlocked}/${achievements.length}` : String(unlocked), activity: "" };
  const prefetch = (t: ProfileTab) => { void TAB_LOADERS[t](); };

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
            : <IdentitySigil id={identity.primary.id} size={64} />}
        </button>

        <div className="pf-id">
          <h1 className="pf-name"><span>{handle}</span>{meta.flag && <Flag cc={meta.flag} size={20} />}</h1>
          <div className="pf-rankrow">
            <span className="pf-rank" style={{ color: ring, borderColor: ring }} aria-label={C["profile.rank.aria"](data.rank.label)}>{data.rank.label}</span>
            <span className="pf-lvl" aria-label={C["profile.level.aria"](prestige.level)}>{C["profile.level"](prestige.level)}</span>
          </div>
          <ul className="pf-tags" aria-label={C["profile.tags.aria"]}>
            {shownTags.map((t) => (
              <li key={t.id}>
                <button type="button" className={`pf-tag ${t.primary ? "primary" : ""}`} title={t.rule} aria-expanded={tagInfo === t.id}
                  onClick={() => setTagInfo((x) => (x === t.id ? null : t.id))}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {t.primary && <img src={withBase(badge.icon)} alt="" width={14} height={14} />}
                  {t.label}
                </button>
              </li>
            ))}
            {!tagsOpen && tags.length > MAX_TAGS && (
              <li><button type="button" className="pf-tag" onClick={() => setTagsOpen(true)}>{C["profile.tags.more"](tags.length - MAX_TAGS)}</button></li>
            )}
          </ul>
          {tagInfo && <p className="pf-taginfo muted" role="status">{tags.find((t) => t.id === tagInfo)?.rule}</p>}
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
          <div className="pf-stats" data-testid="profile-stats">
            <div className={`pf-stat ${closed && rpnl !== 0 ? (rpnl > 0 ? "pos" : "neg") : ""}`}><span>Realized PnL</span><strong>{!statsOk ? DASH : closed ? signedUsd(rpnl) : "$0"}</strong></div>
            <div className="pf-stat"><span>{C["profile.stat.winrate"]}</span><strong>{statsOk && closed ? `${winPct}%` : DASH}</strong></div>
            <div className="pf-stat"><span>{C["profile.stat.bombs"]}</span><strong>{statsOk ? bombsDropped : DASH}</strong></div>
          </div>
        </div>
      </header>

      {isPrivate && <ProfileClaims />}

      <div className="pf-tabbar" ref={tabBar}>
        <div className="pf-tabs" role="tablist">
          {PROFILE_TABS.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={url.tab === t} className={url.tab === t ? "on" : ""} data-testid={`tab-btn-${t}`}
              onClick={() => goTab(t)} onMouseEnter={() => prefetch(t)} onTouchStart={() => prefetch(t)}>
              {C[`profile.tab.${t}`]}{tabCount[t] && <span className={`pf-count ${t === "achievements" ? "pf-count-desk" : ""}`}>{tabCount[t]}</span>}
            </button>
          ))}
        </div>
      </div>

      <section className="pf-panel" role="tabpanel">
        {url.tab === "rockets" && (
          <RocketsTab rows={pageSlice(rocketRows, page, PAGE.rockets)} total={rocketRows.length} page={page} pages={pages} onPage={goPage}
            isPrivate={isPrivate} owner={ownerName} sample={rocketsSample} />
        )}
        {LOOT_ENABLED && url.tab === "loot" && (
          <LootTab rows={pageSlice(lootShown, page, PAGE.loot)} total={lootShown.length} counts={lootCounts} filter={lootFilter}
            onFilter={(f) => setUrl({ filter: f, page: 1, loot: null })} page={page} pages={pages} onPage={goPage} onOpen={openPopup}
            isPrivate={isPrivate} owner={ownerName} onSeeAchievements={() => goTab("achievements")} />
        )}
        {url.tab === "achievements" && (
          <AchievementsTab rows={pageSlice(achievements, page, PAGE.achievements)} unlocked={unlocked} sample={sample}
            prestige={prestige} nextRank={data.rank.next.tier !== data.rank.tier ? { points: data.pointsToNextRank, label: data.rank.next.label } : null}
            leaderboardRank={data.leaderboardRank} page={page} pages={pages} onPage={goPage} onOpen={openPopup} isPrivate={isPrivate} owner={ownerName} />
        )}
        {url.tab === "activity" && (
          <ActivityTab record={[
            { label: "Volume", value: traded ? fmtUsd(kpi("vol")) : "$0" },
            { label: "Avg hold", value: closed ? fmtHours(kpi("hold")) : DASH },
            { label: "Biggest W", value: closed && data.ct.biggestW > 0 ? fmtUsd(data.ct.biggestW) : DASH, tone: closed && data.ct.biggestW > 0 ? "pos" : undefined },
            { label: "Hardest Fall", value: closed && data.ct.biggestL < 0 ? fmtUsd(data.ct.biggestL) : DASH, tone: closed && data.ct.biggestL < 0 ? "neg" : undefined },
            { label: C["activity.record.grads"], value: String(data.ct.graduationsWitnessed) },
            { label: "Rockets Lost", value: String(data.ct.ruggedCount) },
          ]} pnl={data.cumulativePnl} rows={pageSlice(data.activity, page, PAGE.activity)} total={data.activity.length} page={page} pages={pages} onPage={goPage}
            isPrivate={isPrivate} owner={ownerName} sample={sample} />
        )}
      </section>
    </div>
  );
}
