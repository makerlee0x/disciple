"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import AchievementBadge, { EmptyBadge } from "@/components/profile/AchievementBadge";
import IdentitySigil, { identityLabel } from "@/components/profile/IdentitySigil";
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
} from "@/lib/leaderboard";
import { fmtUsd } from "@/lib/config";
import { leaderboardAdapter } from "@/lib/mock/leaderboard";

const SORTS: { key: LeaderboardSort; label: string }[] = [
  { key: "pnl", label: "PnL" },
  { key: "pctGain", label: "% Gain" },
  { key: "volume", label: "Volume" },
  { key: "holdTime", label: "Hold time" },
];

const WINDOWS: { key: LeaderboardWindow; label: string }[] = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "all", label: "All" },
];

function PnlIcon({ pos }: { pos: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
      {pos ? (
        <path d="M4 16l6-6 4 4 6-8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      ) : (
        <path d="M4 8l6 6 4-4 6 8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      )}
    </svg>
  );
}

function HourglassIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 4h12M6 20h12M7 4c0 5 4 6 5 8-1 2-5 3-5 8M17 4c0 5-4 6-5 8 1 2 5 3 5 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CrossedSwords({ lit }: { lit: boolean }) {
  return (
    <span className={`lb-swords ${lit ? "lit" : ""}`} title={lit ? "PvP / Bomber" : "PvE"}>
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M5 3l6 6M3 5l6 6M14 15l6 6M15 14l6 6M19 3l-6 6M21 5l-6 6M10 15l-6 6M9 14l-6 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      </svg>
    </span>
  );
}

function PlayButton({ href, ticker }: { href: string; ticker: string }) {
  return (
    <Link href={href} className="lb-play" title={`Open ${ticker} rocket`} aria-label={`Play ${ticker}`}>
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 5v14l12-7z" fill="currentColor" />
      </svg>
    </Link>
  );
}

function Row({ row }: { row: LeaderboardRow }) {
  const pos = row.pnlUsd >= 0;
  const badges = row.badges.slice(0, 6);
  const empties = Math.max(0, 6 - badges.length);
  const tierColor = ladderColor(row.ladderTier);

  return (
    <div className={`lb-row ${row.isSelf ? "self" : ""}`} data-rank={row.rank}>
      <div className="lb-cell lb-rank">
        {row.rank <= 3 ? <span className={`lb-medal m${row.rank}`}>#{row.rank}</span> : `#${row.rank}`}
      </div>
      <div className="lb-cell lb-avatar">
        <IdentitySigil id={row.identity} size={40} />
      </div>
      <div className="lb-cell lb-player">
        <div className="lb-name">
          <span>{row.handle}</span>
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
      <div className="lb-cell lb-hold">
        <HourglassIcon />
        <span>{fmtHold(row.avgHoldHours)}</span>
      </div>
      <div className="lb-cell lb-mode">
        <CrossedSwords lit={row.mode === "pvp"} />
      </div>
      <div className="lb-cell lb-badges">
        {badges.map((b) => (
          <AchievementBadge key={b.id} a={b} size={22} />
        ))}
        {Array.from({ length: empties }, (_, i) => (
          <EmptyBadge key={`e${i}`} size={22} />
        ))}
      </div>
      <div className="lb-cell lb-tier">
        <span className="lb-tier-tag" style={{ color: tierColor, borderColor: `${tierColor}99` }}>
          {row.ladderTier}
        </span>
      </div>
      <div className="lb-cell lb-actions">
        <Link href="/profile" className="lb-profile-link">
          Profile
        </Link>
        <PlayButton href={`/coin/${row.rocketAddress}`} ticker={row.rocketTicker} />
      </div>
    </div>
  );
}

export default function LeaderboardView() {
  const [sort, setSort] = useState<LeaderboardSort>("pnl");
  const [timeframe, setTimeframe] = useState<LeaderboardWindow>("7d");
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [source, setSource] = useState<"mock" | "indexer">("mock");
  const [busy, setBusy] = useState(true);

  const query: LeaderboardQuery = useMemo(() => ({ sort, window: timeframe }), [sort, timeframe]);

  const load = useCallback(async (q: LeaderboardQuery) => {
    setBusy(true);
    try {
      const res = await leaderboardAdapter.getLeaderboard(q);
      setRows(res.rows);
      setSource(res.source);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(query);
  }, [query, load]);

  return (
    <div className="lb-page">
      <header className="lb-head">
        <div>
          <h1>Leaderboard</h1>
          <div className="sub">HEAVEN LADDER · TOP PILOTS</div>
          <span className={`tag ${source === "mock" ? "mock" : ""}`}>
            {source === "mock" ? "SAMPLE DATA · INDEXER TBD" : "LIVE INDEXER"}
          </span>
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
          <span className="lb-cell lb-avatar" />
          <span className="lb-cell lb-player">Pilot</span>
          <span className="lb-cell lb-pnl">PnL</span>
          <span className="lb-cell lb-pct">% Gain</span>
          <span className="lb-cell lb-vol">Volume</span>
          <span className="lb-cell lb-hold">Hold</span>
          <span className="lb-cell lb-mode">PvP</span>
          <span className="lb-cell lb-badges">Badges</span>
          <span className="lb-cell lb-tier">Ladder</span>
          <span className="lb-cell lb-actions" />
        </div>
        <div className="lb-body">
          {rows.map((r) => (
            <Row key={r.address} row={r} />
          ))}
        </div>
      </div>
      <p className="lb-footnote">
        Angel / heaven theme · Scores are sample until the indexer wires Trade events. PvP swords light for
        bomber / nuker dump playstyles.
      </p>
    </div>
  );
}
