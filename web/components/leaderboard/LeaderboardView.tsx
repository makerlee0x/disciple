"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import AchievementBadge, { EmptyBadge } from "@/components/profile/AchievementBadge";
import { identityLabel } from "@/components/profile/IdentitySigil";
import { rarityStyle } from "@/lib/achievements";
import { profileUrl } from "@/lib/profile";
import { displayName } from "@/lib/defaultUsername";
import {
  flagEmoji,
  fmtHold,
  fmtPct,
  fmtSignedUsd,
  ladderColor,
  type LeaderboardQuery,
  type LeaderboardRow,
  type LeaderboardSort,
  type LeaderboardWindow,
  emptyLeaderboardAdapter,
  type LeaderboardAdapter,
} from "@/lib/leaderboard";
import { fmtUsd } from "@/lib/config";
import { devSample } from "@/lib/devSample";
import Icon from "@/components/icons/Icon";

const SORTS: { key: LeaderboardSort; label: string }[] = [
  { key: "pnl", label: "PnL" },
  { key: "pctGain", label: "% Gain" },
  { key: "volume", label: "Volume" },
  { key: "holdTime", label: "Total hold" },
];

const WINDOWS: { key: LeaderboardWindow; label: string }[] = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "all", label: "All" },
];

function PnlIcon({ pos }: { pos: boolean }) {
  return <Icon name={pos ? "boost" : "dump"} size={12} />;
}

function HourglassIcon() {
  return <Icon name="clock" size={12} />;
}

function BadgeWithStats({ a }: { a: LeaderboardRow["badges"][number] }) {
  const r = rarityStyle(a.rarity);
  return (
    <span className="lb-badge-wrap" tabIndex={0}>
      <AchievementBadge a={a} size={20} />
      <span className="lb-badge-pop" role="tooltip">
        <strong>{a.name}</strong>
        <span style={{ color: r.border }}>{r.label}</span>
        <span>{a.description}</span>
        <span className="muted">Target {a.target.toLocaleString()} · +{(a.reward.points ?? 0).toLocaleString()} pts</span>
      </span>
    </span>
  );
}

function Row({ row }: { row: LeaderboardRow }) {
  const pos = row.pnlUsd >= 0;
  const badges = row.badges.slice(0, 6);
  const empties = Math.max(0, 6 - badges.length);
  const tierColor = ladderColor(row.ladderTier);
  const name = displayName(row.handle, row.address);   // no handle → space-themed default call sign
  const router = useRouter();
  const href = row.username ? profileUrl(row.username) : `/u/${row.address}`;
  const go = (e: React.MouseEvent | React.KeyboardEvent) => {
    // Let real links / buttons / badge popovers inside the row handle their own clicks.
    if ((e.target as HTMLElement).closest("a,button,[data-no-row-nav]")) return;
    if ("metaKey" in e && (e.metaKey || e.ctrlKey)) { window.open(href, "_blank"); return; }
    router.push(href);
  };

  return (
    <div className={`lb-row lb-row-link ${row.isSelf ? "self" : ""}`} data-rank={row.rank} role="link" tabIndex={0}
      aria-label={`Open ${name || row.address}'s profile`} onClick={go}
      onKeyDown={(e) => { if (e.key === "Enter") go(e); }}>
      <div className="lb-cell lb-rank">
        {row.rank <= 3 ? <span className={`lb-medal m${row.rank}`}>#{row.rank}</span> : `#${row.rank}`}
      </div>
      <div className="lb-cell lb-player">
        <div className="lb-name">
          <Link href={href} className="lb-name-link" title={`Open ${name}'s profile · ${row.address}`}>
            {name}
          </Link>
          <span className="lb-flag" title={row.country}>
            {flagEmoji(row.country)}
          </span>
          {row.isSelf && <span className="lb-you">you</span>}
        </div>
        <div className="lb-id-label">{identityLabel(row.identity)}</div>
      </div>
      <div className={`lb-cell lb-pnl ${pos ? "pos" : "neg"}`}>
        <PnlIcon pos={pos} />
        <span>{fmtSignedUsd(row.pnlUsd)}</span>
      </div>
      <div className={`lb-cell lb-pct ${row.pctGain >= 0 ? "pos" : "neg"}`}>{fmtPct(row.pctGain)}</div>
      <div className="lb-cell lb-vol">{fmtUsd(row.volumeUsd)}</div>
      <div className="lb-cell lb-hold" title={`Cumulative hold time · avg ${fmtHold(row.avgHoldHours)} per position`}>
        <HourglassIcon />
        <span>{fmtHold(row.totalHoldHours)}</span>
      </div>
      <div className="lb-cell lb-badges">
        {badges.map((b) => (
          <BadgeWithStats key={b.id} a={b} />
        ))}
        {Array.from({ length: empties }, (_, i) => (
          <EmptyBadge key={`e${i}`} size={20} />
        ))}
      </div>
      <div className="lb-cell lb-tier">
        <span className="lb-tier-tag" title="Prestige rank tier — climbs with points, like CoD prestige" style={{ color: tierColor, borderColor: `${tierColor}99` }}>
          {row.ladderTier}
        </span>
      </div>
    </div>
  );
}

export default function LeaderboardView() {
  const [sort, setSort] = useState<LeaderboardSort>("pnl");
  const [timeframe, setTimeframe] = useState<LeaderboardWindow>("7d");
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [source, setSource] = useState<"mock" | "indexer" | "none">("none");
  const [busy, setBusy] = useState(true);

  const query: LeaderboardQuery = useMemo(() => ({ sort, window: timeframe }), [sort, timeframe]);

  const load = useCallback(async (q: LeaderboardQuery) => {
    setBusy(true);
    try {
      // Sample pilots only in `next dev` + ?sample=1 (constant false in production builds, so the mock isn't bundled)
      const adapter: LeaderboardAdapter = process.env.NODE_ENV === "development" && devSample() ? (await import("@/lib/mock/leaderboard")).leaderboardAdapter : emptyLeaderboardAdapter;
      const res = await adapter.getLeaderboard(q);
      setRows(res.rows);
      setSource(res.source);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(query);
  }, [query, load]);

  if (!busy && rows.length === 0) {
    return (
      <div className="lb-page">
        <header className="lb-head">
          <div>
            <h1>Leaderboard</h1>
          </div>
        </header>
        <div className="pf-empty" data-testid="lb-empty">
          <strong>No pilots yet</strong>
          <Link href="/create" className="ds-btn">Launch a rocket</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="lb-page">
      <header className="lb-head">
        <div>
          <h1>Leaderboard</h1>
          <div className="sub">PRESTIGE LADDER · TOP PILOTS</div>
          {source === "mock" && <span className="tag mock">SAMPLE DATA · DEV</span>}
        </div>
        <div className="lb-controls">
          <nav className="lb-seg" aria-label="Sort by">
            {SORTS.map((s) => (
              <button
                key={s.key}
                type="button"
                className={sort === s.key ? "on" : ""}
                onClick={() => setSort(s.key)}
              >
                {s.label}
              </button>
            ))}
          </nav>
          <nav className="lb-seg" aria-label="Timeframe">
            {WINDOWS.map((w) => (
              <button
                key={w.key}
                type="button"
                className={timeframe === w.key ? "on" : ""}
                onClick={() => setTimeframe(w.key)}
              >
                {w.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <div className="lb-table-shell" aria-busy={busy || undefined}>
        <div className="lb-colhead" aria-hidden="true">
          <span className="lb-cell lb-rank">#</span>
          <span className="lb-cell lb-player">Pilot</span>
          <span className="lb-cell lb-pnl">PnL</span>
          <span className="lb-cell lb-pct">% Gain</span>
          <span className="lb-cell lb-vol">Volume</span>
          <span className="lb-cell lb-hold" title="Cumulative hold time">Total hold</span>
          <span className="lb-cell lb-badges">Badges</span>
          <span className="lb-cell lb-tier" title="Prestige rank tier">Prestige tier</span>
        </div>
        <div className="lb-body">
          {rows.map((r) => (
            <Row key={r.address} row={r} />
          ))}
        </div>
      </div>
      <p className="lb-footnote">
        Prestige tier = your rank on the heaven ladder: earn points, climb tiers (Normie → Angels → Seraphim…), like
        CoD prestige. Hold = cumulative time held across positions. Click any row to open their public profile. Scores
        are SAMPLE until the indexer wires Trade events.
      </p>
    </div>
  );
}
