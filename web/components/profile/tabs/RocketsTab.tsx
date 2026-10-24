"use client";

import Link from "next/link";
import { useState } from "react";
import PairArt from "@/components/pairart/PairArt";
import { sampleArtFor } from "@/lib/pairArt";
import { fmtUsd } from "@/lib/config";
import { PROFILE_COPY as C } from "@/lib/copy/profile";
import { SAMPLE_DATA_LABEL } from "@/lib/mock/sample-trades";
import Pager from "../Pager";

export interface RocketCardRow {
  key: string; href: string; ticker: string; name: string; tier?: string;
  /** Sample rows: realized PnL. Live rows: current value, with the 24h change in `sub`. */
  amount: number; signed: boolean; sub?: string; share?: () => void;
}

/** Rockets tab: one page (12) of rocket cards. Tap → /coin/<address>. "Share this trade" sits in the ⋯ menu. */
export default function RocketsTab({ rows, total, page, pages, onPage, isPrivate, owner, sample }: {
  rows: RocketCardRow[]; total: number; page: number; pages: number; onPage: (p: number) => void;
  isPrivate: boolean; owner: string; sample: boolean;
}) {
  const [menu, setMenu] = useState<string | null>(null);
  if (!total) {
    return isPrivate ? (
      <div className="pf-empty">
        <strong>{C["rockets.empty.own.title"]}</strong>
        <p>{C["rockets.empty.own.body"]}</p>
        <Link href="/" className="ds-btn">{C["rockets.empty.own.cta"]}</Link>
      </div>
    ) : <div className="pf-empty"><p>{C["rockets.empty.other"](owner)}</p></div>;
  }
  return (
    <div className="pf-tab-body" data-testid="tab-rockets">
      <div className="pf-chips-row">
        <span className="pf-chip on">{C["rockets.filter.holding"](total)}</span>
        {sample && <span className="tag mock" title={SAMPLE_DATA_LABEL}>{C["profile.sample"]}</span>}
      </div>
      <ul className="pf-rocket-grid">
        {rows.map((r) => {
          const amt = r.signed ? `${r.amount >= 0 ? "+" : "-"}${fmtUsd(Math.abs(r.amount))}` : fmtUsd(r.amount);
          return (
            <li key={r.key} className="pf-rocket">
              <Link href={r.href} className="pf-rocket-link">
                <PairArt {...sampleArtFor(r.ticker)} tk={r.ticker} size="list" px={40} />
                <span className="pf-rocket-id"><strong>${r.ticker}</strong><span>{r.name}</span></span>
                {r.tier && <span className="tier-chip">{r.tier}</span>}
                <span className={`pf-rocket-amt ${r.signed ? (r.amount >= 0 ? "pos" : "neg") : ""}`} aria-label={r.signed ? C["rockets.card.pnl.aria"](amt) : undefined}>
                  {amt}{r.sub && <small className="muted">{r.sub}</small>}
                </span>
              </Link>
              {r.share && (
                <div className="pf-rocket-more">
                  <button type="button" className="ds-btn pf-icon-btn" aria-haspopup="menu" aria-expanded={menu === r.key} aria-label={`Share this ${r.ticker} trade`}
                    onClick={() => setMenu((m) => (m === r.key ? null : r.key))}>⋯</button>
                  {menu === r.key && (
                    <div className="pf-menu" role="menu">
                      <button type="button" role="menuitem" onClick={() => { setMenu(null); r.share?.(); }}>Share this trade</button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <Pager page={page} pages={pages} onPage={onPage} />
    </div>
  );
}
