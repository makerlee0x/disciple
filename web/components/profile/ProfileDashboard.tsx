"use client";

import { useXp } from "@/lib/xpClient";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PROFILE_CHANGED_EVENT, fetchUsernameStatus, localUsername } from "@/lib/profile";
import { defaultUsername, isAddressLike } from "@/lib/defaultUsername";
import { EMPTY_META, pfpUrl, type ProfileMeta } from "@/lib/profileMeta";
import { fetchProfileMeta } from "@/lib/profileMetaClient";
import { PROFILE_COPY as C } from "@/lib/copy/profile";
import { NO_IDENTITY } from "@/lib/identity";
import { withBase } from "@/lib/base-path";
import { connectedAddress, lastWallet, onWallet } from "@/lib/walletState";
import { hasSavedSession, onPrivy, privyAuthenticated, privyLoaded } from "@/lib/aa/sessionState";
import { DEPOSIT_HREF, LEGACY_CASH_HASH, OPEN_SETTINGS_EVENT, SETTINGS_HASHES } from "@/lib/cashLink";
import HolderTags from "@/components/nft/HolderTags";
import IdentitySigil from "./IdentitySigil";
import BioText from "./BioText";
import Pager, { pageCount, pageSlice } from "./Pager";
import { useLivePortfolio } from "./LiveHoldings";
import { useCashHistory, useRealActivity } from "./RealActivity";
import type { CashKind, CashRow } from "@/lib/cashHistory";
import { ACTIVE_CHAIN } from "@/lib/chains";
import PortfolioBlock from "./PortfolioBlock";
import { agoLabel, usd2 } from "./money";
import { shareInvite } from "@/lib/invite";
import { useRewards } from "@/components/claims/useRewards";
import InvitesCard from "@/components/invites/InvitesCard";
import Icon, { type IconName } from "@/components/icons/Icon";
import DsSelect from "@/components/ui/DsSelect";
import type { ActivityItem } from "@/lib/stats";
import type { LifetimeRow } from "@/lib/server/leaderboard";
import HangarBay from "@/components/hangar/HangarBay";
import { fetchXLink, X_CHANGED_EVENT } from "@/lib/xLinkClient";
import HangarSignedOut from "@/components/hangar/HangarSignedOut";
import { RocketCard } from "@/components/hangar/Collection";
import { useCollection } from "@/lib/collectionClient";
import type { Progress } from "@/lib/unlocks";
import { Fleet, ServiceRecord, TrophyCase } from "@/components/hangar/HangarSections";
import { useHiddenLaunches, useHomeCoins, useLoadout, useTrophies } from "@/components/hangar/hangarData";

/* Popups load on first open (speed pass 2026-11-21): Settings, Edit profile, Rewards and the points card were ~40 KB of
   gzipped JS in every Hangar and public profile load, and a public profile never opens three of them. They stay mounted
   after the first open, and their chunks are fetched once the page is idle so the first tap doesn't wait. */
const loadSettings = () => import("./SettingsModal");
const loadEdit = () => import("./EditProfileSheet");
const loadRewards = () => import("@/components/claims/RewardsPanel");
const loadPoints = () => import("@/components/points/PointsShare");
const SettingsModal = dynamic(loadSettings, { ssr: false });
const EditProfileSheet = dynamic(loadEdit, { ssr: false });
const RewardsPanel = dynamic(loadRewards, { ssr: false });
const PointsShare = dynamic(loadPoints, { ssr: false });
/** true from the first time `open` is true */
function useOpened(open: boolean) {
  const [was, setWas] = useState(open);
  if (open && !was) setWas(true);
  return was || open;
}

const PAGE = { activity: 12 } as const;
/** The app's Hangar jump row: section heading id → label. */
const HANGAR_JUMPS = [["hg-looks", "Your rocket"], ["hg-trophies", "Trophies"], ["hg-fleet", "Fleet"], ["hg-log", "Flight log"]] as const;

/** Flight log row looks: chip label, icon, colour (up = green; plain = no tint). */
const LOG_KIND: Record<ActivityItem["kind"] | CashKind, { label: string; icon: IconName; tone: "up" | "down" | "" }> = {
  buy: { label: "BOOST", icon: "arrow-up", tone: "up" },
  sell: { label: "DUMP", icon: "arrow-down", tone: "down" },
  bomb: { label: "DUMP", icon: "arrow-down", tone: "down" },
  bought: { label: "BOUGHT", icon: "wallet", tone: "" },
  sold: { label: "SOLD", icon: "check", tone: "up" },
  deposit: { label: "DEPOSIT", icon: "plus", tone: "up" },
  withdraw: { label: "WITHDRAW", icon: "minus", tone: "" },
  "turbo-in": { label: "TO TURBO", icon: "bolt", tone: "" },
  "turbo-out": { label: "FROM TURBO", icon: "bolt", tone: "up" },
  fees: { label: "FEES", icon: "fees", tone: "up" },
  rewards: { label: "REWARDS", icon: "gift", tone: "up" },
};
const CASH_TEXT: Partial<Record<CashKind, string>> = { "turbo-in": "Turbo cash", "turbo-out": "Turbo cash", fees: "Creator fees", rewards: "Rewards" };
type LogRow = { id: string; ts: number; kind: keyof typeof LOG_KIND; text: string; usd?: number; href?: string; ext?: boolean };
const txUrl = (tx?: string) => { const b = ACTIVE_CHAIN.blockExplorers?.default.url; return b && tx && /^0x[0-9a-fA-F]{64}$/.test(tx) ? `${b}/tx/${tx}` : undefined; };

/** Trades (BOOST / DUMP) and, on your own Hangar, every cash move, newest first. A cash row in a trade's tx is dropped. */
function logRows(trades: ActivityItem[], cash: CashRow[] | null): LogRow[] {
  const tradeTx = new Set(trades.map((a) => a.id.split(":")[0].toLowerCase()));
  const rows: LogRow[] = trades.map((a) => ({ id: a.id, ts: a.ts, kind: a.kind, text: a.text, usd: a.usd, href: a.coin ? `/coin/${a.coin}` : undefined }));
  for (const c of cash ?? []) {
    if (c.tx && tradeTx.has(c.tx.toLowerCase())) continue;
    const market = c.kind === "bought" || c.kind === "sold";
    rows.push({
      id: `cash:${c.id}`, ts: c.ts, kind: c.kind, usd: c.usd, text: c.text ?? CASH_TEXT[c.kind] ?? "",
      ...(txUrl(c.tx) ? { href: txUrl(c.tx), ext: true } : market ? { href: "/market" } : {}),
    });
  }
  return rows.sort((a, b) => b.ts - a.ts);
}

/** Flight log filter (maker 2026-11-19): one entry per kind of move; only kinds this log actually has are offered. */
const LOG_FILTERS: { k: string; label: string; kinds: (keyof typeof LOG_KIND)[] }[] = [
  { k: "boost", label: "Boosts", kinds: ["buy"] },
  { k: "dump", label: "Dumps", kinds: ["sell", "bomb"] },
  { k: "deposit", label: "Deposits", kinds: ["deposit"] },
  { k: "withdraw", label: "Withdrawals", kinds: ["withdraw"] },
  { k: "sold", label: "Market sales", kinds: ["sold"] },
  { k: "bought", label: "Market buys", kinds: ["bought"] },
  { k: "turbo", label: "Turbo cash", kinds: ["turbo-in", "turbo-out"] },
  { k: "fees", label: "Creator fees", kinds: ["fees"] },
  { k: "rewards", label: "Rewards", kinds: ["rewards"] },
];

/** Flight log: ↑ BOOST / ↓ DUMP · rocket, plus (own) market, deposits, withdrawals, Turbo cash · dollars · when. */
function Activity(props: { rows: ActivityItem[] | null; cash: CashRow[] | null; isPrivate: boolean; owner: string }) {
  const [filter, setFilter] = useState("all");
  const all = useMemo(() => (props.rows ? logRows(props.rows, props.cash) : null), [props.rows, props.cash]);
  const options = useMemo(() => {
    const have = new Set(all?.map((r) => r.kind));
    return LOG_FILTERS.filter((f) => f.kinds.some((k) => have.has(k)));
  }, [all]);
  const f = options.find((o) => o.k === filter);
  return (
    <section className="dsc3-panel hg-panel hg-log" aria-labelledby="hg-log">
      <header className="hg-panelh">
        <h2 id="hg-log">Flight log</h2>
        {options.length > 1 && (
          <DsSelect className="pill" value={f ? f.k : "all"} onChange={setFilter} ariaLabel="Show"
            options={[{ value: "all", label: "Everything" }, ...options.map((o) => ({ value: o.k, label: o.label }))]} />
        )}
      </header>
      <LogList {...props} all={all && f ? all.filter((r) => f.kinds.includes(r.kind)) : all} key={f?.k ?? "all"} />
    </section>
  );
}

function LogList({ all: rows, cash, isPrivate, owner }: { all: LogRow[] | null; cash: CashRow[] | null; isPrivate: boolean; owner: string }) {
  const [page, setPage] = useState(1);
  if (rows == null || (isPrivate && cash == null && !rows.length)) return <div className="p5-list" aria-busy="true" data-testid="tab-activity" />;
  if (!rows.length) {
    return isPrivate ? (
      <div className="p5-empty" data-testid="tab-activity">
        <strong>{C["activity.empty.own.title"]}</strong>
      </div>
    ) : <div className="p5-empty" data-testid="tab-activity"><p>{C["activity.empty.other"](owner)}</p></div>;
  }
  const pages = pageCount(rows.length, PAGE.activity), p = Math.min(page, pages);
  return (
    <div className="p5-list" data-testid="tab-activity">
      <ul>
        {pageSlice(rows, p, PAGE.activity).map((a) => {
          const k = LOG_KIND[a.kind];
          return (
            <li key={a.id} className="p5-arow" data-kind={a.kind}>
              <span className={`k ${k.tone}`}><Icon name={k.icon} size={12} />{k.label}</span>
              <span className="r">{a.href ? (a.ext ? <a href={a.href} target="_blank" rel="noreferrer">{a.text}</a> : <Link href={a.href}>{a.text}</Link>) : a.text}</span>
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
 *   bay: call sign as a title card, bio, level bar, Rewards / Edit profile / Settings (own)
 *   service record: hangar value + today, cash (+ Add cash), flights aboard, rockets launched
 *   Your altitude (the portfolio chart) | Your rocket (a half-width card, own only; the full collection and crates are /rocket)
 *   Your fleet (compact Live window cards) over the Trophy case | Flight log (filter by kind, scrolls at that height)
 *   then invites (own)
 * Settings opens from the pilot chip (/profile#settings). Everything shown is live; nothing is sample data.
 */
export default function ProfileDashboard({ mode = "private", username }: { mode?: "private" | "public"; username?: string }) {
  const isPrivate = mode === "private";
  const [me, setMe] = useState("");
  useEffect(() => {
    if (!isPrivate) return;
    // After any save (picture, bio, call sign) re-read the name. An empty browser cache (another device, a sign-in whose
    // name read failed) must not blank the banner back to the default call sign (maker 2026-11-18: "added my pfp and it
    // deleted my call name"): ask the server instead.
    const read = () => {
      const u = localUsername();
      if (u) { setMe(u); return; }
      const a = connectedAddress();
      if (a) fetchUsernameStatus(a).then((s) => setMe(s.username || "")).catch(() => {}); else setMe("");
    };
    read();
    window.addEventListener(PROFILE_CHANGED_EVENT, read);
    return () => window.removeEventListener(PROFILE_CHANGED_EVENT, read);
  }, [isPrivate]);

  const [wallet, setWallet] = useState<string | null>(null);
  // /profile: a saved session is still being restored (Privy loading). Gives up after 8 s so a dead session shows signed out.
  const [restoring, setRestoring] = useState(isPrivate);
  useEffect(() => {
    if (!isPrivate) return;
    const sync = () => setRestoring(!connectedAddress() && (privyAuthenticated() || (!privyLoaded() && hasSavedSession())));
    sync();
    const offP = onPrivy(sync), offW = onWallet(sync);
    const t = window.setTimeout(() => setRestoring(false), 8000);
    return () => { offP(); offW(); window.clearTimeout(t); };
  }, [isPrivate]);
  // Public /u/<0x…> (leaderboard rows without a username link here): the slug IS the wallet; its claimed username,
  // if any, is looked up below, else the page shows the wallet's space-themed default call sign.
  const slugAddr = !isPrivate && isAddressLike(username) ? username!.toLowerCase() : null;
  const [slugName, setSlugName] = useState<string | null>(null);
  // public: the username lookup finished (a name with no wallet then shows empty, not loading)
  const [resolved, setResolved] = useState(false);
  useEffect(() => {
    if (isPrivate) {
      // Paint the last signed-in wallet's profile at once while the saved session restores (Privy takes a second or two);
      // the real wallet then confirms it, or replaces it, or the page falls back to signed out.
      const restoringNow = () => !connectedAddress() && (privyAuthenticated() || (!privyLoaded() && hasSavedSession()));
      const guess = restoringNow() ? lastWallet() : null;
      const apply = () => { const a = connectedAddress(); setWallet(a ? a.toLowerCase() : restoringNow() && guess ? guess.toLowerCase() : null); };
      const offW = onWallet(apply), offP = onPrivy(apply);
      const t = window.setTimeout(() => { if (!connectedAddress()) setWallet(null); }, 8000);
      return () => { offW(); offP(); window.clearTimeout(t); };
    }
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

  // the linked X handle, shown on the banner when X is connected (maker 2026-11-18); re-read when Connect X changes it
  const [xHandle, setXHandle] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const read = () => { fetchXLink(wallet).then((s) => { if (alive) setXHandle(s.link?.username ?? null); }); };
    if (!wallet) { setXHandle(null); return; }
    read();
    window.addEventListener(X_CHANGED_EVENT, read);
    return () => { alive = false; window.removeEventListener(X_CHANGED_EVENT, read); };
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
  const [invited, setInvited] = useState(false);
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
  // your own anon launches: found in this browser with your keys, shown on your Hangar only (never on the public profile)
  const hidden = useHiddenLaunches(isPrivate && !!wallet);
  const trophies = useTrophies(wallet);
  const progress = useMemo<Progress | null>(() => (xp && trophies ? { level: xp.level.level, prestige: xp.level.prestige, trophies: new Set(trophies.keys()) } : null), [xp, trophies]);
  const looks = useLoadout(isPrivate, progress, wallet || null);
  const loadout = looks.loadout;
  const activity = useRealActivity(wallet);
  const cash = useCashHistory(wallet, isPrivate);
  const rewards = useRewards(isPrivate && !!wallet);
  const { col } = useCollection(isPrivate ? wallet || null : null);
  // lifetime points (maker 2026-11-18: never reset, the airdrop ranking) + rank, on every profile
  const [points, setPoints] = useState<LifetimeRow | null>(null);
  const [pointsCard, setPointsCard] = useState(false);
  useEffect(() => {
    setPoints(null);
    if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) return;
    let alive = true;
    fetch(withBase(`/api/leaderboard?sort=lifetime&me=${wallet}`)).then((r) => (r.ok ? r.json() : null))
      .then((d: { me?: LifetimeRow | null } | null) => { if (alive) setPoints(d?.me ?? null); }).catch(() => {});
    return () => { alive = false; };
  }, [wallet]);

  const settingsSeen = useOpened(settingsOpen);
  const editSeen = useOpened(!!edit);
  const rewardsSeen = useOpened(rewardsOpen);
  const pointsSeen = useOpened(pointsCard);
  // warm the Hangar's popups once the page has settled (a public profile only ever opens the points card)
  useEffect(() => {
    if (!isPrivate) return;
    const w = window as Window & { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number };
    const go = () => { void loadSettings(); void loadEdit(); void loadRewards(); void loadPoints(); };
    const t = setTimeout(() => (w.requestIdleCallback ? w.requestIdleCallback(go, { timeout: 4000 }) : go()), 2500);
    return () => clearTimeout(t);
  }, [isPrivate]);
  // Still signing in from a saved session: show nothing yet instead of flashing the signed-out hangar (maker 2026-11-17).
  if (isPrivate && !wallet && restoring) return <div className="profile-page hg hg-restoring" aria-busy="true" data-testid="hangar-restoring"><span className="hg-spin" role="status" aria-label="Signing in" /></div>;
  // /profile signed out: no sample pilot pretending to be you (existing copy only).
  if (isPrivate && !wallet) {
    return (
      <div className="profile-page hg hgo" data-testid="hangar-signedout">
        {/* Settings opens right away, before the wallet resolves; its sections show their own loading / signed-out state */}
        {settingsSeen && <SettingsModal open={settingsOpen} onClose={closeSettings} />}
        <HangarSignedOut loadout={loadout} />
      </div>
    );
  }

  // No username: the wallet's space-themed default call sign (never with an "@"); public /u/<0x…> slugs likewise.
  const handle = isPrivate ? (me ? `@${me}` : defaultUsername(wallet)) : publicName;
  // display name (spaces allowed) is the big title when set; the @username then sits under it
  const title = meta.name?.trim() || handle;
  const at = meta.name?.trim() && handle.startsWith("@") ? handle : undefined;
  const img = pfpUrl(meta.pfp);
  const noWallet = !isPrivate && resolved && !wallet;
  const holdings = pf ? (pf.ok ? pf.rows : []) : noWallet ? [] : null;

  const launched = home && (wallet || slugAddr) ? [...home.values()].filter((c) => c.creatorAddr === (wallet || slugAddr) || (isPrivate && hidden.has(c.token))).sort((x, y) => y.block - x.block) : null;
  const avatar = img
    // eslint-disable-next-line @next/next/no-img-element
    ? <img className="pfp-img" src={withBase(img)} alt="" width={72} height={72} fetchPriority="high" />
    : <IdentitySigil id={NO_IDENTITY.primary.id} size={34} tip={false} />;
  const bio = meta.bio ? <p className="hg-bio" data-testid="profile-bio"><BioText text={meta.bio} /></p>
    : isPrivate ? <button type="button" className="hg-addbio" onClick={() => setEdit({ focus: "bio" })}><Icon name="plus" size={14} /> {C["profile.bio.empty.own"]}</button> : null;
  const actions = isPrivate ? <>
    <button type="button" className="hg-ghost" onClick={() => void shareInvite(wallet, me).then((h) => { if (h === "copied") { setInvited(true); setTimeout(() => setInvited(false), 1400); } })} data-testid="invite-btn"><Icon name="share" size={16} /> {invited ? "Link copied" : "Invite"}</button>
    <button type="button" className="hg-ghost" onClick={() => setEdit({ focus: null })} data-testid="edit-profile-btn">{C["profile.action.edit"]}</button>
    <button type="button" className="hg-ghost" onClick={() => setSettingsOpen(true)} data-testid="hangar-settings-btn">Settings</button>
    {points && points.username && <button type="button" className="hg-ghost" onClick={() => setPointsCard(true)} data-testid="hangar-points-share">Share points</button>}
  </> : <>
    <Link href={`/u/${encodeURIComponent(username ?? "")}/stats`} className="hg-ghost" data-testid="profile-stats-link"><Icon name="leaderboard" size={16} /> Stats</Link>
    <Link href={`/u/${encodeURIComponent(username ?? "")}/turbo`} className="hg-ghost" data-testid="profile-turbo-link"><Icon name="bolt" size={16} /> Turbo</Link>
  </>;
  // the cockpit dash (Hangar banner take A): only numbers we really have
  const dash = [
    points ? { k: `Points · #${points.rank.toLocaleString("en-US")}`, v: points.pts.toLocaleString("en-US") } : null,
    xp ? { k: "Total XP", v: xp.totalXp.toLocaleString("en-US") } : null,
    trophies ? { k: trophies.size === 1 ? "Trophy" : "Trophies", v: String(trophies.size) } : null,
    launched && launched.length ? { k: launched.length === 1 ? "Rocket launched" : "Rockets launched", v: String(launched.length) } : null,
  ].filter((x): x is { k: string; v: string } => !!x);

  return (
    <div className="profile-page hg">
      {isPrivate && settingsSeen && <SettingsModal open={settingsOpen} onClose={closeSettings} />}
      {isPrivate && editSeen && <EditProfileSheet open={!!edit} focus={edit?.focus} wallet={wallet} meta={meta}
        handle={handle} level={xp?.level ? `Level ${xp.level.level} · ${xp.level.prestigeName}` : undefined}
        onClose={(saved) => { setEdit(null); if (saved) flash(typeof saved === "string" ? saved : C["edit.saved"]); }} />}
      {isPrivate && rewardsSeen && <RewardsPanel open={rewardsOpen} onClose={closeRewards} r={rewards} />}
      {toast && <div className="pf-toast" role="status">{toast}</div>}
      {points?.username && pointsSeen && <PointsShare handle={points.username} pts={points.pts} rank={points.rank} open={pointsCard} onClose={() => setPointsCard(false)} />}

      <HangarBay handle={title} at={at} x={xHandle} bio={bio} avatar={avatar} xp={xp} actions={actions} spend={false} stats={dash}
        nftAvatar={!!img && !!meta.nft} tags={wallet ? <HolderTags wallet={wallet} /> : null} />

      {/* iPhone app only (html.app): the desktop Hangar is one long page on a phone, so a sticky row jumps to each part */}
      {isPrivate && (
        <nav className="hg-appjump" aria-label="Hangar sections" data-testid="hangar-jump">
          {HANGAR_JUMPS.map(([id, label]) => (
            <button key={id} type="button" onClick={() => document.getElementById(id)?.closest("section")?.scrollIntoView({ behavior: "smooth", block: "start" })}>{label}</button>
          ))}
        </nav>
      )}

      <ServiceRecord pf={noWallet ? { ok: true, cashUsd: 0, rows: [] } : pf} isPrivate={isPrivate}
        rewards={isPrivate && wallet ? { usd: rewards.data ? rewards.data.summary.claimableUsd : null, onOpen: () => setRewardsOpen(true) } : null} />

      {/* maker 2026-11-17: Altitude top left beside a half-width Your rocket card; Trophy case and Your fleet side by side under
          them. Skins, trails, trade up and crates live on /rocket. */}
      <div className={`hg-duo${isPrivate ? "" : " solo"}`}>
        <PortfolioBlock pf={noWallet ? { ok: true, cashUsd: 0, rows: [] } : pf} isPrivate={isPrivate} title={isPrivate ? "Your altitude" : "Altitude"} />
        {isPrivate && <RocketCard col={col} handle={handle} />}
      </div>
      {/* maker 2026-11-19: Your fleet (compact cards) with the Trophy case under it on the left, the Flight log on the right at
          the left column's height (it scrolls inside) */}
      <div className="hg-duo hg-split">
        <div className="hg-stack">
          <Fleet rows={holdings} home={home} launched={launched} isPrivate={isPrivate} owner={ownerName} />
          <TrophyCase got={trophies} href={isPrivate ? "/achievements" : `/u/${encodeURIComponent(username ?? "")}/stats`} />
        </div>
        <Activity rows={noWallet ? [] : activity} cash={noWallet ? [] : cash} isPrivate={isPrivate} owner={ownerName} />
      </div>
      {isPrivate && <InvitesCard />}
    </div>
  );
}
