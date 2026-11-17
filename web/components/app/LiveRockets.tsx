"use client";
/**
 * iPhone app: "Live rockets" (app home concept C, maker 2026-11-16). Replaces the old Live flights card, which opened a
 * random coin: a full-screen sheet to search every rocket by name or ticker and sort it four ways. Rows open that rocket's
 * flight. Nothing flying (or nothing matching) points to Host a launch. Only real launches from HomeData, never samples.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtUsd } from "@/lib/config";
import { difficultyOf } from "@/lib/difficulty";
import type { HomeCoin } from "@/lib/home/trending";
import { liveRockets, ROCKET_SORTS, type RocketSort } from "@/lib/home/appHome";
import Icon from "@/components/icons/Icon";
import { flightHref, lit, Mark, orbitPct, pct } from "@/components/home/rocketBits";
import s from "./appHome.module.css";

export default function LiveRockets({ coins, open, onClose }: { coins: HomeCoin[]; open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<RocketSort>("trend");
  const list = useMemo(() => liveRockets(coins, q, sort), [coins, q, sort]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", k);
    ref.current?.focus();
    return () => removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  const flying = coins.filter((c) => !c.graduated).length;
  return (
    <div className={s.sheet} role="dialog" aria-modal="true" aria-labelledby="live-rockets-title" ref={ref} tabIndex={-1} data-testid="app-live-rockets">
      <header className={s.sheetHd}>
        <div>
          <h2 id="live-rockets-title" className={s.sheetT}>Live rockets</h2>
          <span className={s.sheetSub}>{flying ? `${flying} flying now` : "Nothing flying right now"}</span>
        </div>
        <button type="button" className={s.x} onClick={onClose} aria-label="Close"><Icon name="close" size={20} /></button>
      </header>
      <label className={s.search}>
        <Icon name="search" size={20} />
        <input type="search" id="app-rocket-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a name or ticker" autoComplete="off" enterKeyHint="search" aria-label="Search rockets" />
      </label>
      <div className={s.chips} role="tablist" aria-label="Sort rockets">
        {ROCKET_SORTS.map((x) => (
          <button key={x.k} type="button" role="tab" aria-selected={sort === x.k} className={sort === x.k ? `${s.chip} ${s.chipOn}` : s.chip} onClick={() => setSort(x.k)} data-testid={`rockets-sort-${x.k}`}>{x.label}</button>
        ))}
      </div>
      <div className={s.rows}>
        {list.length ? list.map((c) => {
          const d = difficultyOf(c.mode, c.graduated);
          const chg = c.stats?.chg24 ?? null;
          return (
            <Link key={c.token} href={flightHref(c)} prefetch={false} className={s.row} style={lit(c)} data-testid="app-rocket-row">
              <Mark c={c} className={s.rowMark} />
              <span className={s.rowTx}>
                <b>{c.name}</b>
                <span className={s.rowMeta}>
                  {d && <span className={s.diff} data-d={d.key}>{d.label}</span>}
                  <span>{fmtUsd(c.mcapUsd)}</span>
                  {c.stats?.crew ? <span>{c.stats.crew.toLocaleString("en-US")} aboard</span> : null}
                </span>
              </span>
              <span className={s.rowRt}>
                {chg != null && <span className={chg >= 0 ? s.up : s.dn}>{chg >= 0 ? "+" : "−"}{pct(Math.abs(chg))}</span>}
                <span className={s.orbitBar} aria-label={`${pct(orbitPct(c))} to orbit`}><i style={{ width: `${orbitPct(c)}%` }} /></span>
              </span>
            </Link>
          );
        }) : (
          <div className={s.empty} data-testid="app-rockets-empty">
            <b>{q ? `No rocket called “${q}”` : "Nothing flying yet"}</b>
          </div>
        )}
      </div>
      <Link href="/create" className={s.host} data-testid="app-rockets-host">
        <span><b>Host a launch</b></span>
        <Icon name="chevron-right" size={20} />
      </Link>
    </div>
  );
}
