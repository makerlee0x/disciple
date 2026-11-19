"use client";
/**
 * All rockets (lobby foot): every rocket as a Live window card (LiveCard), with sort chips, difficulty and Verified
 * filters and search. Rockets come only from the HomeData the hero paints with (chain launches + indexed 24h stats),
 * refreshed by the hero's poll ("dsc:home-data"). Lazy-loaded below the lobby (HomeFeedLazy); cards render in chunks.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { MODE } from "@/lib/modeRules";
import { isVerified } from "@/lib/verified";
import { useVerifiedMany } from "@/lib/verifiedClient";
import type { HomeCoin, HomeData } from "@/lib/home/trending";
import Icon from "@/components/icons/Icon";
import DsSelect from "@/components/ui/DsSelect";
import LiveCard from "./LiveCard";
import s from "./rocketGrid.module.css";

/** Sort chips (maker 2026-11-18): Newest, Trending (24h climb), Volume (24h), Near orbit, Ascended (graduated). */
type Sort = "new" | "climbing" | "busy" | "near" | "orbit";
const SORTS: { k: Sort; label: string }[] = [
  { k: "new", label: "Newest" },
  { k: "climbing", label: "Trending" },
  { k: "busy", label: "Volume" },
  { k: "near", label: "Near orbit" },
  { k: "orbit", label: "Ascended" },
];
type Diff = "all" | "easy" | "hard" | "expert";
const DIFFS: { k: Diff; label: string; mode?: number }[] = [
  { k: "all", label: "Any difficulty" },
  { k: "easy", label: "Easy", mode: MODE.EASY },
  { k: "hard", label: "Hard", mode: MODE.HARD },
  { k: "expert", label: "Expert", mode: MODE.TRENCH },
];
const CHUNK = 24;
const NEAR_BPS = 6_000;

export default function RocketGrid({ initial }: { initial: HomeCoin[] }) {
  const [coins, setCoins] = useState(initial);
  useEffect(() => {
    const h = (e: Event) => setCoins((e as CustomEvent<HomeData>).detail.coins);
    window.addEventListener("dsc:home-data", h);
    return () => window.removeEventListener("dsc:home-data", h);
  }, []);
  const [sort, setSort] = useState<Sort>("new");
  const [diff, setDiff] = useState<Diff>("all");
  const [pair, setPair] = useState("all");
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  // the base pairs on the board right now (what each rocket is bought and sold in), most rockets first
  const pairs = useMemo(() => {
    const n = new Map<string, number>();
    for (const c of coins) if (c.pairSym) n.set(c.pairSym, (n.get(c.pairSym) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  }, [coins]);
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(CHUNK);
  const more = useRef<HTMLDivElement>(null);
  const vset = useVerifiedMany(verifiedOnly ? coins.map((c) => c.token) : []);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^\$/, "");
    const mode = DIFFS.find((d) => d.k === diff)?.mode;
    const r = coins.filter((c) => {
      if (needle && !(c.name.toLowerCase().includes(needle) || c.ticker.toLowerCase().includes(needle) || c.token.includes(needle) || (c.pairSym ?? "").toLowerCase().includes(needle))) return false;
      if (pair !== "all" && pairs.includes(pair) && c.pairSym !== pair) return false;
      if (mode !== undefined && (c.graduated || c.mode !== mode)) return false;
      if (verifiedOnly && !isVerified(c.token) && !vset.has(c.token)) return false;
      if (sort === "near") return !c.graduated && (c.progressBps ?? 0) >= NEAR_BPS;
      if (sort === "orbit") return c.graduated;
      return true;
    });
    const vol = (c: HomeCoin) => c.stats?.vol24 ?? 0;
    if (sort === "new" || sort === "orbit") r.sort((a, b) => b.block - a.block);
    else if (sort === "climbing") r.sort((a, b) => (b.stats?.chg24 ?? -Infinity) - (a.stats?.chg24 ?? -Infinity) || vol(b) - vol(a));
    else if (sort === "busy") r.sort((a, b) => vol(b) - vol(a) || b.block - a.block);
    else if (sort === "near") r.sort((a, b) => (b.progressBps ?? 0) - (a.progressBps ?? 0));
    return r;
  }, [coins, q, diff, pair, pairs, verifiedOnly, vset, sort]);

  useEffect(() => setShown(CHUNK), [q, diff, pair, verifiedOnly, sort]);
  useEffect(() => {
    const el = more.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) setShown((n) => n + CHUNK); }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [rows.length, shown]);

  if (!coins.length) return null;
  return (
    <div className={s.wrap} data-testid="rocket-grid">
      <div className={s.bar}>
        <div className={s.chips} role="group" aria-label="Sort rockets">
          {SORTS.map((t) => (
            <button key={t.k} type="button" className="dsc3-chip" aria-pressed={sort === t.k} onClick={() => setSort(t.k)}>{t.label}</button>
          ))}
        </div>
        <div className={s.tools}>
          <label className={s.search}>
            <Icon name="search" size={16} />
            <input type="search" placeholder="Search rockets" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search rockets by name, ticker or pair" />
          </label>
          <DsSelect className="pill" value={diff} onChange={(v) => setDiff(v as Diff)} ariaLabel="Difficulty"
            options={DIFFS.map((d) => ({ value: d.k, label: d.label }))} />
          {pairs.length > 0 && (
            <DsSelect className="pill" value={pairs.includes(pair) ? pair : "all"} onChange={setPair} ariaLabel="Pair"
              options={[{ value: "all", label: "Any pair" }, ...pairs.map((p) => ({ value: p, label: p }))]} />
          )}
          <button type="button" className="dsc3-chip" aria-pressed={verifiedOnly} onClick={() => setVerifiedOnly((v) => !v)} title="Hand-verified rockets only">
            <Icon name="verified" size={16} /> Verified
          </button>
        </div>
      </div>
      <p className={s.count}>{rows.length.toLocaleString("en-US")} {rows.length === 1 ? "rocket" : "rockets"}</p>
      {rows.length ? (
        <div className={s.grid}>
          {rows.slice(0, shown).map((c) => <LiveCard key={c.token} c={c} testId="grid-card" />)}
        </div>
      ) : (
        <p className={s.empty}>No rockets match. Try another filter or clear the search.</p>
      )}
      {shown < rows.length && (
        <div ref={more} className={s.more}>
          <button type="button" className="dsc3-chip" onClick={() => setShown((n) => n + CHUNK)}>Show more rockets</button>
        </div>
      )}
    </div>
  );
}
