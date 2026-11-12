"use client";

import PilotCard from "@/components/xp/PilotCard";
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
import { onWallet } from "@/lib/wallet";
import { DEPOSIT_HREF, LEGACY_CASH_HASH, OPEN_SETTINGS_EVENT, SETTINGS_HASHES } from "@/lib/cashLink";
import { tokenAmountLabel } from "@/lib/portfolioHistory";
import { useCoinIcons } from "@/lib/useCoinIcons";
import SettingsModal from "./SettingsModal";
import EditProfileSheet from "./EditProfileSheet";
import IdentitySigil from "./IdentitySigil";
import BioText from "./BioText";
import Pager, { pageCount, pageSlice } from "./Pager";
import { useLivePortfolio, type LiveHolding } from "./LiveHoldings";
import { useRealActivity } from "./RealActivity";
import PortfolioBlock from "./PortfolioBlock";
import { ChestGlyph } from "./Glyphs";
import { agoLabel, signedUsd2, usd2 } from "./money";
import RewardsPopup from "@/components/claims/RewardsPopup";
import { useRewards } from "@/components/claims/useRewards";
import InvitesCard from "@/components/invites/InvitesCard";
import PairArt from "@/components/pairart/PairArt";
import Icon from "@/components/icons/Icon";
import type { ActivityItem } from "@/lib/stats";

const PAGE = { rockets: 8, activity: 20 } as const;

/** Rockets list (profile r5): art · name · `{count} $TICKER` on the left; value · today's change on the right. No tier. */
function Holdings({ rows, icons, isPrivate, owner }: { rows: LiveHolding[] | null; icons: Record<string, string>; isPrivate: boolean; owner: string }) {
  const [page, setPage] = useState(1);
  if (rows == null) return <div className="p5-list" aria-busy="true" data-testid="tab-rockets" />;
  if (!rows.length) {
    return isPrivate ? (
      <div className="p5-empty" data-testid="tab-rockets">
        <strong>{C["rockets.empty.own.title"]}</strong>
        <p>{C["rockets.empty.own.body"]}</p>
        <Link href="/" className="p5-btn">{C["rockets.empty.own.cta"]}</Link>
      </div>
    ) : <div className="p5-empty" data-testid="tab-rockets"><p>{C["rockets.empty.other"](owner)}</p></div>;
  }
  const pages = pageCount(rows.length, PAGE.rockets), p = Math.min(page, pages);
  return (
    <div className="p5-list" data-testid="tab-rockets">
      <ul>
        {pageSlice(rows, p, PAGE.rockets).map((h) => {
          const tk = h.symbol || h.coin.slice(2, 6).toUpperCase();
          const ch = h.tokens * (h.priceNow - h.price24h);
          return (
            <li key={h.coin}>
              <Link href={`/coin/${h.coin}`} className="p5-hold">
                <PairArt src={icons[h.coin.toLowerCase()]} tk={tk} size="list" px={40} />
                <span className="m"><span className="nm">{h.name || `$${tk}`}</span><span className="sub" data-testid="holding-amount">{tokenAmountLabel(h.tokens, tk)}</span></span>
                <span className="vv"><span>{usd2(h.usd)}</span><span className={`ch ${Math.abs(ch) < 0.005 ? "muted" : ch > 0 ? "up" : "down"}`}>{signedUsd2(ch)} today</span></span>
              </Link>
            </li>
          );
        })}
      </ul>
      <Pager page={p} pages={pages} onPage={setPage} />
    </div>
  );
}

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
 * /profile (own) and /u/[username] (public), profile r5 (body) + r3 (header, Edit profile, Rewards popup, Settings):
 *   banner (pilot-uploaded; plain dark panel when none) · picture · name (Instrument Serif) · bio
 *   own only: Edit profile + chest, or a gold "Claim now" in place of the chest when rewards are waiting (opens Rewards)
 *   portfolio block (total, change, 24H/7D/30D/ALL, chart, Cash, Rockets) — public profiles show the same block
 *   Activity + Rockets (desktop: two columns; phone: Rockets then Activity)
 * No cash pill, Share, Settings button, Log out, titles, Achievements card or Withdraw/Deposit on the page: Share lives in
 * the Rewards popup, Log out and the username in Settings (sidebar gear → /profile#settings), money moves on /wallet.
 * Everything shown is live (wallet reads + the trade index); nothing is sample data.
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
  const icons = useCoinIcons(useMemo(() => (pf?.rows ?? []).map((h) => h.coin), [pf]));
  const activity = useRealActivity(wallet);
  const rewards = useRewards(isPrivate && !!wallet);

  // /profile signed out: no sample pilot pretending to be you (existing copy only).
  if (isPrivate && !wallet) {
    return (
      <div className="profile-page pf-v3">
        {/* Settings opens right away, before the wallet resolves; its sections show their own loading / signed-out state */}
        <SettingsModal open={settingsOpen} onClose={closeSettings} />
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
  const banner = pfpUrl(meta.banner ?? "");
  const noWallet = !isPrivate && resolved && !wallet;
  const holdings = pf ? (pf.ok ? pf.rows : []) : noWallet ? [] : null;

  const rocketsSection = (
    <section className="p5-sec p5-rockets" aria-labelledby="p5-h-rockets">
      <div className="p5-sech"><h2 id="p5-h-rockets">{C["profile.tab.rockets"]}</h2>{!!holdings?.length && <span className="a">{C["rockets.filter.holding"](holdings.length)}</span>}</div>
      <Holdings rows={holdings} icons={icons} isPrivate={isPrivate} owner={ownerName} />
    </section>
  );
  const activitySection = (
    <section className="p5-sec p5-activity" aria-labelledby="p5-h-activity">
      <div className="p5-sech"><h2 id="p5-h-activity">{C["profile.tab.activity"]}</h2></div>
      <Activity rows={noWallet ? [] : activity} isPrivate={isPrivate} owner={ownerName} />
    </section>
  );

  return (
    <div className="profile-page p5">
      {isPrivate && <SettingsModal open={settingsOpen} onClose={closeSettings} />}
      {isPrivate && <EditProfileSheet open={!!edit} focus={edit?.focus} wallet={wallet} meta={meta}
        onClose={(saved) => { setEdit(null); if (saved) flash(C["edit.saved"]); }} />}
      {isPrivate && <RewardsPopup open={rewardsOpen} onClose={() => setRewardsOpen(false)} r={rewards} />}
      {toast && <div className="pf-toast" role="status">{toast}</div>}

      <header className="p5-head" data-testid="profile-identity">
        <div className={`p5-banner ${banner ? "" : "none"}`} style={banner ? { backgroundImage: `url(${withBase(banner)})` } : undefined} data-testid="profile-banner" />
        <div className="p5-hrow">
          <div className="p5-av" aria-hidden>
            {img
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={withBase(img)} alt="" width={136} height={136} fetchPriority="high" />
              : <IdentitySigil id={NO_IDENTITY.primary.id} size={72} tip={false} />}
          </div>
          <div className="p5-id">
            <h1 className="p5-name"><span>{handle}</span></h1>
            {meta.bio ? <p className="p5-bio" data-testid="profile-bio"><BioText text={meta.bio} /></p>
              : isPrivate ? <button type="button" className="p5-addbio" onClick={() => setEdit({ focus: "bio" })}><Icon name="plus" size={14} /> {C["profile.bio.empty.own"]}</button> : null}
          </div>
          {isPrivate && (
            <div className="p5-acts">
              <button type="button" className="p5-btn" onClick={() => setEdit({ focus: null })} data-testid="edit-profile-btn">{C["profile.action.edit"]}</button>
              {rewards.canClaim
                ? <button type="button" className="p5-btn claim" onClick={() => setRewardsOpen(true)} data-testid="claim-now"><ChestGlyph size={18} /> Claim now</button>
                : <button type="button" className="p5-icon chest" aria-label="Rewards" title="Rewards" onClick={() => setRewardsOpen(true)} data-testid="rewards-chest"><ChestGlyph size={20} /></button>}
            </div>
          )}
        </div>
      </header>

      <HangarPilot wallet={wallet} isPrivate={isPrivate} />

      {isPrivate && <InvitesCard />}

      <PortfolioBlock pf={noWallet ? { ok: true, cashUsd: 0, rows: [] } : pf} isPrivate={isPrivate} />

      <div className="p5-cols">
        <div className="p5-colm">{activitySection}</div>
        <aside className="p5-cola">{rocketsSection}</aside>
      </div>
    </div>
  );
}

/** Hangar pilot card (level, prestige, XP). Anyone can see a pilot's level; only the owner gets the prestige button. */
function HangarPilot({ wallet, isPrivate }: { wallet: string | null; isPrivate: boolean }) {
  const { xp } = useXp(wallet);
  return <PilotCard xp={xp} wallet={isPrivate ? wallet : null} />;
}
