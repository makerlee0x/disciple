"use client";

import type { ActivityItem } from "@/lib/stats";
import { fmtUsd } from "@/lib/config";
import { PROFILE_COPY as C } from "@/lib/copy/profile";
import { SAMPLE_DATA_LABEL } from "@/lib/mock/sample-trades";
import Icon, { OrbMeter, type BombTier } from "@/components/icons/Icon";
import { BOMB_ICON } from "@/components/ui/Icon";
import Pager from "../Pager";
import { useMemo, useState } from "react";
import { CrosshairChart, RangeToggle, sliceRange, type RangeKey } from "../Charts";

/** Activity tab: the "Record" tiles (each stat shown once on the page), then one page (20) of the feed. */
export default function ActivityTab({ record, pnl, rows, total, page, pages, onPage, isPrivate, owner }: {
  record: { label: string; value: string; tone?: "pos" | "neg" }[];
  /** Cumulative PnL series: the profile's one PnL chart (PnL is public, lee 2026-10-24). */
  pnl: { t: number; v: number }[];
  rows: ActivityItem[]; total: number; page: number; pages: number; onPage: (p: number) => void; isPrivate: boolean; owner: string;
}) {
  const [range, setRange] = useState<RangeKey>("30d");
  const pts = useMemo(() => sliceRange(pnl, range, "level"), [pnl, range]);
  return (
    <div className="pf-tab-body" data-testid="tab-activity">
      <div className="pf-chips-row"><span className="pf-eyebrow">{C["activity.record"]}</span><span className="tag mock" title={SAMPLE_DATA_LABEL}>{C["profile.sample"]}</span></div>
      <div className="pf-record">
        {record.map((r) => <div key={r.label} className={`pf-stat ${r.tone ?? ""}`}><span>{r.label}</span><strong>{r.value}</strong></div>)}
      </div>
      <section className="chart-card pf-pnl-chart" data-testid="activity-pnl-chart">
        <div className="chart-head"><h3>{C["activity.pnl.title"]}</h3><RangeToggle value={range} onChange={setRange} /></div>
        <CrosshairChart points={pts} hourly={range === "1d"} formatY={(v) => (v < 0 ? "-" : "") + fmtUsd(Math.abs(v))} color="#c9b6f2" />
      </section>
      {!total ? <p className="muted">{isPrivate ? C["activity.empty.own"] : C["activity.empty.other"](owner)}</p> : (
        <ul className="activity-feed">
          {rows.map((a) => (
            <li key={a.id}>
              <span className={`act-kind ${a.kind}${a.bomb ? " dsc-bomb" : ""}`} data-bomb={a.bomb?.k}>{a.kind}</span>
              <span className="act-text">
                {a.bomb ? (
                  <span className="act-bomb dsc-bomb" data-bomb={a.bomb.k} aria-hidden>
                    <Icon name={BOMB_ICON[a.bomb.tier]} size={14} />
                    <OrbMeter tier={(a.bomb.tier + 1) as BombTier} size={14} label="" />
                  </span>
                ) : null}
                {a.text}
              </span>
              {a.usd != null ? <span className="act-usd">{fmtUsd(a.usd)}</span> : null}
              <span className="act-time muted">{new Date(a.ts).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
            </li>
          ))}
        </ul>
      )}
      <Pager page={page} pages={pages} onPage={onPage} />
    </div>
  );
}
