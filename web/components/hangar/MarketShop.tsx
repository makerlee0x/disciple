"use client";
/**
 * /market storefront (maker 2026-11-17: "convert like the CS2 skin markets and the Fortnite item shop", short labels, no
 * word vomit). Funnel: featured banner → your crates → browse (filters + dense grid) → item sheet → buy.
 *   - Featured: the rarest live listings rotate in a big banner on the series art, price and Buy up front.
 *   - Browse: filters on the left (price, burn, rarity, hull, special), sort + search on top, cards lead with art and price.
 *   - Item sheet: big art, price, one gold Buy, burn bar and rolls, cheaper copies of the same item, last sales.
 * Data: lib/marketClient (one fetch of every open listing; filtering and sorting happen here). Selling and trades live in
 * ./Market (Your rocket). Website only: the iPhone app shows a pointer to the site.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatUnits } from "viem";
import { withBase } from "@/lib/base-path";
import {
  BURN_GRADES, HULL_NAMES, ITEMS, RARITIES, RARITY_COLOR as SW, RARITY_NAME as RL, SERIES, burnGrade, itemById, liveSeries, seriesArt,
  type Item, type Rarity,
} from "@/lib/collection";
import { isNativeApp } from "@/lib/native";
import { usd, type Listing, type Sale } from "@/lib/market";
import { buyListing, buyQuote, useMarket } from "@/lib/marketClient";
import { WALLET_CTA_CLICK_EVENT } from "@/lib/walletCta";
import { itemArt } from "./Collection";
import AnimClip from "@/components/ui/AnimClip";

const fmt = (n: number) => n.toLocaleString("en-US");
const short = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;
const who = (name: string | null | undefined, w: string) => (name ? `@${name}` : short(w));
const rank = (r: Rarity) => RARITIES.indexOf(r);
const kindLine = (i: Item) => (i.kind === "skin" ? HULL_NAMES[i.hull!] : i.kind === "trail" ? "Trail" : i.kind === "tag" ? "Name tag" : "Win flourish");
const nameOf = (i: Item) => i.name;
const fullName = (i: Item) => (i.kind === "skin" ? `${HULL_NAMES[i.hull!]} | ${i.name}` : `${i.name} ${kindLine(i).toLowerCase()}`);
const signIn = () => window.dispatchEvent(new Event(WALLET_CTA_CLICK_EVENT));

/** Burn grade colours, Factory Fresh → Burnt Out (the CS2 wear bar, in our five grades). */
const GRADE_COLOR: Record<string, string> = { FF: "#5FF0A0", TF: "#B5E86A", FW: "#F2C14E", RS: "#FF9A3C", BO: "#FF5A4E" };
function BurnBar({ burn, big }: { burn: number; big?: boolean }) {
  let from = 0;
  return (
    <span className={`mk-burn${big ? " big" : ""}`} aria-label={`Burn ${burn.toFixed(4)}`}>
      <span className="mk-burn-track">
        {BURN_GRADES.map((g) => { const w = Math.min(1, g.max) - from; const el = <i key={g.short} style={{ width: `${w * 100}%`, background: GRADE_COLOR[g.short] }} />; from = Math.min(1, g.max); return el; })}
      </span>
      {burn >= 0 && <b className="mk-burn-pin" style={{ left: `${Math.min(100, Math.max(0, burn * 100))}%` }} />}
    </span>
  );
}

/* ------------------------------------------------------------- filters ------------------------------------------------------------- */

type Kind = "" | Item["kind"];
type Sort = "new" | "price-asc" | "price-desc" | "burn-asc" | "rare" | "deal";
const KINDS: [Kind, string][] = [["", "All"], ["skin", "Skins"], ["trail", "Trails"], ["tag", "Name tags"], ["flourish", "Flourishes"]];
const SORTS: [Sort, string][] = [["new", "Newest"], ["deal", "Best deals"], ["price-asc", "Price: low"], ["price-desc", "Price: high"], ["rare", "Rarest"], ["burn-asc", "Least burn"]];
const PRICE_CHIPS: [string, number, number | null][] = [["<$5", 0, 5], ["$5–25", 5, 25], ["$25–100", 25, 100], ["$100+", 100, null]];

interface F { kind: Kind; q: string; min: string; max: string; rars: Rarity[]; grades: string[]; hulls: string[]; trak: boolean; fe: boolean; sort: Sort }
const NONE: F = { kind: "", q: "", min: "", max: "", rars: [], grades: [], hulls: [], trak: false, fe: false, sort: "new" };
const flip = <T,>(l: T[], v: T) => (l.includes(v) ? l.filter((x) => x !== v) : [...l, v]);
const active = (f: F) => (f.min || f.max ? 1 : 0) + f.rars.length + f.grades.length + f.hulls.length + (f.trak ? 1 : 0) + (f.fe ? 1 : 0);

/** Last sale price per item, from the recent sales feed: a listing under it is a deal. */
function lastSales(sales: Sale[]) { const m = new Map<string, number>(); for (const s of sales) if (!m.has(s.item)) m.set(s.item, s.price); return m; }
const dealPct = (l: Listing, last: Map<string, number>) => { const p = last.get(l.item); return p && l.price < p ? Math.round((1 - l.price / p) * 100) : 0; };

function apply(rows: Listing[], f: F, last: Map<string, number>): Listing[] {
  const q = f.q.trim().toLowerCase();
  const min = f.min ? Number(f.min) * 100 : 0, max = f.max ? Number(f.max) * 100 : Infinity;
  const out = rows.filter((l) => {
    const it = itemById(l.item); if (!it) return false;
    if (f.kind && it.kind !== f.kind) return false;
    if (l.price < min || l.price > max) return false;
    if (f.rars.length && !f.rars.includes(it.rar)) return false;
    if (f.grades.length && (!l.copy || !f.grades.includes(burnGrade(l.copy.burn).short))) return false;
    if (f.hulls.length && (it.kind !== "skin" || !f.hulls.includes(it.hull!))) return false;
    if (f.trak && l.copy?.trak == null) return false;
    if (f.fe && !l.copy?.fe) return false;
    if (q && !`${fullName(it)} ${RL[it.rar]} ${l.copy?.serial ?? ""} ${l.sellerName ?? ""}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const r = (l: Listing) => rank(itemById(l.item)!.rar);
  return out.sort((a, b) =>
    f.sort === "price-asc" ? a.price - b.price : f.sort === "price-desc" ? b.price - a.price
      : f.sort === "burn-asc" ? (a.copy?.burn ?? 1) - (b.copy?.burn ?? 1)
        : f.sort === "rare" ? r(b) - r(a) || a.price - b.price
          : f.sort === "deal" ? dealPct(b, last) - dealPct(a, last) || a.price - b.price
            : b.at - a.at);
}

function Filters({ f, set, rows }: { f: F; set: (p: Partial<F>) => void; rows: Listing[] }) {
  const count = (pred: (l: Listing, it: Item) => boolean) => rows.filter((l) => { const it = itemById(l.item); return !!it && pred(l, it); }).length;
  const hulls = Object.keys(HULL_NAMES).filter((h) => h !== "ring-tail");
  return (
    <div className="mk-filters">
      <fieldset><legend>Price</legend>
        <div className="mk-range">
          <label><span>$</span><input inputMode="decimal" placeholder="Min" value={f.min} onChange={(e) => set({ min: e.target.value.replace(/[^\d.]/g, "") })} aria-label="Min price" /></label>
          <label><span>$</span><input inputMode="decimal" placeholder="Max" value={f.max} onChange={(e) => set({ max: e.target.value.replace(/[^\d.]/g, "") })} aria-label="Max price" /></label>
        </div>
        <div className="mk-chiprow">{PRICE_CHIPS.map(([label, lo, hi]) => { const on = f.min === (lo ? String(lo) : "") && f.max === (hi ? String(hi) : ""); return (
          <button key={label} type="button" className={on ? "on" : ""} aria-pressed={on} onClick={() => set(on ? { min: "", max: "" } : { min: lo ? String(lo) : "", max: hi ? String(hi) : "" })}>{label}</button>
        ); })}</div>
      </fieldset>
      <fieldset><legend>Burn</legend>
        <BurnBar burn={-1} />
        <div className="mk-chiprow g5">{BURN_GRADES.map((g) => <button key={g.short} type="button" title={g.name} className={f.grades.includes(g.short) ? "on" : ""} aria-pressed={f.grades.includes(g.short)} style={{ ["--gc" as string]: GRADE_COLOR[g.short] }} onClick={() => set({ grades: flip(f.grades, g.short) })}>{g.short}</button>)}</div>
      </fieldset>
      <fieldset><legend>Rarity</legend>
        <ul className="mk-checks">{[...RARITIES].reverse().map((r) => (
          <li key={r}><label><input type="checkbox" checked={f.rars.includes(r)} onChange={() => set({ rars: flip(f.rars, r) })} /><i style={{ background: SW[r] }} /><span style={{ color: SW[r] }}>{RL[r]}</span><small>{count((_, it) => it.rar === r)}</small></label></li>
        ))}</ul>
      </fieldset>
      <fieldset><legend>Hull</legend>
        <div className="mk-chiprow">{hulls.map((h) => <button key={h} type="button" className={f.hulls.includes(h) ? "on" : ""} aria-pressed={f.hulls.includes(h)} onClick={() => set({ hulls: flip(f.hulls, h) })}>{HULL_NAMES[h]}</button>)}</div>
      </fieldset>
      <fieldset><legend>Special</legend>
        <ul className="mk-checks">
          <li><label><input type="checkbox" checked={f.trak} onChange={() => set({ trak: !f.trak })} /><span className="mk-ft">FlightTrak™</span><small>{count((l) => l.copy?.trak != null)}</small></label></li>
          <li><label><input type="checkbox" checked={f.fe} onChange={() => set({ fe: !f.fe })} /><span className="mk-fe">First edition</span><small>{count((l) => !!l.copy?.fe)}</small></label></li>
        </ul>
      </fieldset>
      {active(f) > 0 && <button type="button" className="mk-clear" onClick={() => set({ min: "", max: "", rars: [], grades: [], hulls: [], trak: false, fe: false })}>Clear all</button>}
    </div>
  );
}

/* --------------------------------------------------------------- cards --------------------------------------------------------------- */

function ListingCard({ l, deal, onOpen }: { l: Listing; deal: number; onOpen: () => void }) {
  const it = itemById(l.item)!, c = l.copy, g = c ? burnGrade(c.burn) : null;
  return (
    <li>
      <button type="button" className={`mk-card r-${it.rar}`} style={{ ["--sw" as string]: SW[it.rar] }} onClick={onOpen} data-testid={`listing-${l.id}`}>
        <span className="mk-card-top">
          {g && c ? <span className="mk-grade"><i style={{ background: GRADE_COLOR[g.short] }} />{g.short} · {c.burn.toFixed(4)}</span> : <span />}
          <span className="mk-tags">{c?.fe && <i className="fe">1st</i>}{c?.trak != null && <i className="ft">FT</i>}</span>
        </span>
        <span className="mk-card-art">{itemArt(it, 118, false, l.sellerName ?? "PILOT", c)}</span>
        <span className="mk-card-tx">
          <small style={{ color: SW[it.rar] }}>{kindLine(it)}</small>
          <b>{nameOf(it)}</b>
          <span className="mk-card-price"><b>{usd(l.price)}</b>{deal >= 5 && <i className="mk-deal">-{deal}%</i>}</span>
          {c && <BurnBar burn={c.burn} />}
          <span className="mk-card-foot"><span>#{c ? fmt(c.serial) : "—"}</span><span>{who(l.sellerName, l.seller)}</span></span>
        </span>
      </button>
    </li>
  );
}

/* ------------------------------------------------------------- featured ------------------------------------------------------------- */

function Hero({ rows, sales, live, onOpen, wallet }: { rows: Listing[] | null; sales: Sale[]; live: { n: number; name: string }; onOpen: (id: string) => void; wallet: string | null }) {
  const feat = useMemo(() => (rows ?? []).slice().sort((a, b) => rank(itemById(b.item)!.rar) - rank(itemById(a.item)!.rar) || Number(!!b.copy?.fe) - Number(!!a.copy?.fe) || a.price - b.price).slice(0, 5), [rows]);
  const [i, setI] = useState(0);
  const paused = useRef(false);
  useEffect(() => { setI(0); }, [feat.length]);
  useEffect(() => {
    if (feat.length < 2) return;
    const t = setInterval(() => { if (!paused.current) setI((n) => (n + 1) % feat.length); }, 6000);
    return () => clearInterval(t);
  }, [feat.length]);
  const floor = rows?.length ? Math.min(...rows.map((l) => l.price)) : null;
  const l = feat[i], it = l ? itemById(l.item) : null;
  // nothing listed yet: show off the series' top drops instead of an empty banner
  const top = useMemo(() => ITEMS.filter((x) => x.kind === "skin" && x.series === live.n && (x.rar === "mythic" || x.rar === "legendary")).sort((a, b) => rank(b.rar) - rank(a.rar)).filter((x, n, all) => all.findIndex((y) => y.paint === x.paint) === n).slice(0, 3), [live.n]);
  // Grok loop A4 (2026-11-17): a showroom spotlight behind the featured item. The wide cut while the banner is wide, the
  // 4:5 cut once it stacks (its still with reduced motion). Picked from the banner's shape after mount.
  const hero = useRef<HTMLElement>(null);
  const [cut, setCut] = useState<"3x1" | "4x5" | null>(null);
  useEffect(() => { const el = hero.current; if (el) setCut(el.offsetWidth / Math.max(1, el.offsetHeight) > 1.4 ? "3x1" : "4x5"); }, []);
  return (
    <section ref={hero} className="mk-hero" style={{ backgroundImage: `url(${withBase(seriesArt(live.n))})` }} onMouseEnter={() => { paused.current = true; }} onMouseLeave={() => { paused.current = false; }} data-testid="market-hero">
      {cut && <AnimClip key={cut} id={`A4-featured-${cut}`} ratio="none" loop poster className="mk-hero-vid" />}
      <div className="mk-hero-l">
        <h1 className="mk-title">Market</h1>
        <span className="mk-series">Series {live.n} · {live.name}</span>
        <dl className="mk-stats">
          <div><dt>Listed</dt><dd>{rows ? fmt(rows.length) : "—"}</dd></div>
          <div><dt>Floor</dt><dd>{floor != null ? usd(floor) : "—"}</dd></div>
          <div><dt>Last sale</dt><dd>{sales[0] ? usd(sales[0].price) : "—"}</dd></div>
        </dl>
        <div className="mk-hero-cta">
          <Link href="/rocket" className="hg-ghost">Sell yours</Link>
          {wallet && <Link href="/rocket#hg-trades" className="hg-ghost">Trades</Link>}
        </div>
      </div>
      {l && it ? (
        <div className="mk-feat" style={{ ["--sw" as string]: SW[it.rar] }}>
          <button type="button" className="mk-feat-card" onClick={() => onOpen(l.id)} data-testid="featured">
            <span className="mk-feat-r" style={{ color: SW[it.rar] }}>Featured · {RL[it.rar]}</span>
            <span key={l.id} className="mk-feat-art">{itemArt(it, 230, false, l.sellerName ?? "PILOT", l.copy)}</span>
            <span className="mk-feat-tx">
              <small>{kindLine(it)}{l.copy ? ` · #${fmt(l.copy.serial)} · ${burnGrade(l.copy.burn).short}` : ""}</small>
              <b>{nameOf(it)}</b>
              <span className="mk-feat-buy"><b>{usd(l.price)}</b><span className="dsc3-btn dsc3-btn-primary">Buy</span></span>
            </span>
          </button>
          {feat.length > 1 && <div className="mk-dots" role="tablist" aria-label="Featured">{feat.map((x, n) => <button key={x.id} type="button" role="tab" aria-selected={n === i} aria-label={`Featured ${n + 1}`} className={n === i ? "on" : ""} onClick={() => setI(n)} />)}</div>}
        </div>
      ) : (
        <div className="mk-feat mk-feat-empty">
          <span className="mk-feat-r">In crates now</span>
          <span className="mk-feat-row">{top.map((x) => <span key={x.id} style={{ ["--sw" as string]: SW[x.rar] }}>{itemArt(x, 150)}<small style={{ color: SW[x.rar] }}>{RL[x.rar]}</small><b>{x.name}</b></span>)}</span>
          <Link href="/turbo/duel" className="dsc3-btn dsc3-btn-primary">Win duels. Get crates.</Link>
        </div>
      )}
    </section>
  );
}

function JustSold({ sales }: { sales: Sale[] }) {
  if (!sales.length) return null;
  return (
    <div className="mk-sold" aria-label="Just sold">
      <span className="mk-sold-h">Just sold</span>
      <ol>{sales.slice(0, 12).map((s) => { const it = itemById(s.item); if (!it) return null; return (
        <li key={s.listing} style={{ ["--sw" as string]: SW[it.rar] }}><span className="mk-sold-art">{itemArt(it, 34)}</span><span><small>{fullName(it)}</small><b>{usd(s.price)}</b></span></li>
      ); })}</ol>
    </div>
  );
}

/* ------------------------------------------------------------ item sheet ------------------------------------------------------------ */

function Spark({ sales }: { sales: Sale[] }) {
  const pts = sales.slice(0, 20).reverse();
  if (pts.length < 2) return null;
  const lo = Math.min(...pts.map((s) => s.price)), hi = Math.max(...pts.map((s) => s.price)), W = 280, H = 56;
  const xy = pts.map((s, n) => `${(n / (pts.length - 1)) * W},${H - 4 - ((s.price - lo) / Math.max(1, hi - lo)) * (H - 8)}`).join(" ");
  return <svg className="mk-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden><polyline points={xy} fill="none" stroke="var(--sw)" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>;
}

function Sheet({ l, rows, me, onPick, onClose }: { l: Listing; rows: Listing[]; me: string | null; onPick: (id: string) => void; onClose: () => void }) {
  const it = itemById(l.item)!, c = l.copy;
  const [sales, setSales] = useState<Sale[]>([]);
  const [step, setStep] = useState<"idle" | "quote" | "confirm" | "busy" | "done">("idle");
  const [net, setNet] = useState(0);
  const [note, setNote] = useState("");
  useEffect(() => {
    setStep("idle"); setNote(""); setSales([]);
    fetch(withBase(`/api/market?listing=${l.id}`), { cache: "no-store" }).then((r) => r.json()).then((j: { ok?: boolean; sales?: Sale[] }) => { if (j?.ok) setSales(j.sales ?? []); }).catch(() => {});
  }, [l.id]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", k); document.body.style.overflow = "hidden";
    return () => { removeEventListener("keydown", k); document.body.style.overflow = ""; };
  }, [onClose]);
  const mine = !!me && l.seller === me.toLowerCase();
  const others = rows.filter((x) => x.item === l.item && x.id !== l.id).sort((a, b) => a.price - b.price).slice(0, 4);
  const avg = sales.length ? Math.round(sales.slice(0, 10).reduce((s, x) => s + x.price, 0) / Math.min(10, sales.length)) : null;
  const ask = async () => {
    setStep("quote"); setNote("");
    const q = await buyQuote(l.id);
    if ("error" in q) { setStep("idle"); return setNote(q.error); }
    setNet(Math.ceil(Number(formatUnits(q.networkRaw, q.decimals)) * 100)); setStep("confirm");
  };
  const buy = async () => {
    setStep("busy"); setNote("");
    const r = await buyListing(l.id);
    if (r.ok) setStep("done"); else { setStep("idle"); setNote(r.reason ?? "Couldn't buy it."); }
  };
  let cta: ReactNode;
  if (l.state === "sold" || step === "done") cta = null;
  else if (mine) cta = <p className="mk-note">Your listing.</p>;
  else if (!me) cta = <button type="button" className="dsc3-btn dsc3-btn-primary mk-buy" onClick={signIn} data-testid="buy-signin">Sign in to buy</button>;
  else if (step === "confirm" || step === "busy") cta = (
    <div className="mk-confirm">
      <dl><div><dt>Price</dt><dd>{usd(l.price)}</dd></div><div><dt>Network</dt><dd>{usd(net)}</dd></div><div className="tot"><dt>Total</dt><dd>{usd(l.price + net)}</dd></div></dl>
      <button type="button" className="dsc3-btn dsc3-btn-primary mk-buy" onClick={buy} disabled={step === "busy"} data-testid="buy-confirm">{step === "busy" ? "Paying…" : `Pay ${usd(l.price + net)}`}</button>
      <button type="button" className="mk-link" onClick={() => setStep("idle")} disabled={step === "busy"}>Cancel</button>
      <small>Paid from Cash</small>
    </div>
  );
  else cta = <button type="button" className="dsc3-btn dsc3-btn-primary mk-buy" disabled={step === "quote" || l.state !== "open"} onClick={ask} data-testid="buy">{l.state === "pending" ? "Being bought" : step === "quote" ? "…" : `Buy ${usd(l.price)}`}</button>;
  return (
    <div className="mk-scrim" onClick={onClose} data-testid="market-detail">
      <div className="mk-sheet" role="dialog" aria-modal="true" aria-label={fullName(it)} style={{ ["--sw" as string]: SW[it.rar] }} onClick={(e) => e.stopPropagation()}>
        <button type="button" className="mk-x" onClick={onClose} aria-label="Close">×</button>
        <div className="mk-sheet-art"><span className="mk-sheet-r" style={{ color: SW[it.rar] }}>{RL[it.rar]}{it.series ? ` · Series ${it.series}` : ""}</span>{itemArt(it, 300, false, l.sellerName ?? "PILOT", c)}</div>
        <div className="mk-sheet-tx">
          <small className="mk-kind">{kindLine(it)}</small>
          <h2>{nameOf(it)}</h2>
          <span className="mk-tags lg">{c?.fe && <i className="fe">First edition</i>}{c?.trak != null && <i className="ft">FlightTrak™ · {fmt(c.trak)} wins</i>}</span>
          <b className="mk-big">{usd(l.price)}</b>
          {avg && <span className="mk-avg">Avg sale {usd(avg)}{l.price < avg ? <i className="mk-deal">-{Math.round((1 - l.price / avg) * 100)}%</i> : null}</span>}
          {cta}
          {step === "done" && <div className="mk-done"><b>It&apos;s yours.</b><Link href="/rocket" className="dsc3-btn dsc3-btn-primary">Equip it</Link></div>}
          {note && <p className="mk-note" role="status">{note}</p>}
          {c && (
            <div className="mk-rolls">
              <div className="mk-roll-burn"><span><b>{burnGrade(c.burn).name}</b><code>{c.burn.toFixed(6)}</code></span><BurnBar burn={c.burn} big /></div>
              <dl><div><dt>Serial</dt><dd>#{fmt(c.serial)}</dd></div><div><dt>Pattern</dt><dd>{c.seed}</dd></div><div><dt>Seller</dt><dd>{who(l.sellerName, l.seller)}</dd></div></dl>
            </div>
          )}
          {others.length > 0 && (
            <div className="mk-more"><h3>More listed · {others.length}</h3>
              <ul>{others.map((x) => <li key={x.id}><button type="button" onClick={() => onPick(x.id)}><span>#{x.copy ? fmt(x.copy.serial) : "—"}</span><span>{x.copy ? `${burnGrade(x.copy.burn).short} · ${x.copy.burn.toFixed(4)}` : ""}</span><b>{usd(x.price)}</b></button></li>)}</ul>
            </div>
          )}
          <div className="mk-more"><h3>Sales</h3>
            {sales.length ? <><Spark sales={sales} /><ul>{sales.slice(0, 5).map((s) => <li key={s.listing}><span>#{fmt(s.serial)}</span><span>{burnGrade(s.burn).short}</span><b>{usd(s.price)}</b><small>{new Date(s.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</small></li>)}</ul></> : <p className="mk-note">No sales yet.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- page ---------------------------------------------------------------- */

export function MarketShop({ wallet, crates }: { wallet: string | null; crates?: ReactNode }) {
  const [web, setWeb] = useState<boolean | null>(null);
  useEffect(() => setWeb(!isNativeApp()), []);
  const { rows, sales } = useMarket({ sort: "new", limit: 200 });
  const [f, setF] = useState<F>(NONE);
  const set = (p: Partial<F>) => setF((x) => ({ ...x, ...p }));
  const [sel, setSel] = useState<string | null>(null);
  const [showF, setShowF] = useState(false);
  const live = liveSeries(Date.now()) ?? SERIES[0];
  const last = useMemo(() => lastSales(sales), [sales]);
  const shown = useMemo(() => apply(rows ?? [], f, last), [rows, f, last]);
  const close = useCallback(() => setSel(null), []);
  const open = sel ? rows?.find((l) => l.id === sel) ?? null : null;
  if (web === false) {
    return <section className="mk-app"><b>Market&apos;s on the web</b><p>disciple.vip/market</p></section>;
  }
  const n = active(f);
  return (
    <div className="mk" data-testid="market">
      <Hero rows={rows} sales={sales} live={live} onOpen={setSel} wallet={wallet} />
      {crates}
      <JustSold sales={sales} />
      <div className="mk-browse">
        <aside className={`mk-side${showF ? " open" : ""}`} aria-label="Filters"><Filters f={f} set={set} rows={rows ?? []} /></aside>
        <div className="mk-main">
          <div className="mk-bar">
            <div className="mk-tabs" role="tablist" aria-label="Type">{KINDS.map(([k, label]) => <button key={label} type="button" role="tab" aria-selected={f.kind === k} className={f.kind === k ? "on" : ""} onClick={() => set({ kind: k })}>{label}</button>)}</div>
            <label className="mk-search"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M20 20l-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
              <input placeholder="Search skins, serials, pilots" value={f.q} onChange={(e) => set({ q: e.target.value })} aria-label="Search" /></label>
            <button type="button" className={`mk-ftoggle${n ? " on" : ""}`} onClick={() => setShowF((v) => !v)} aria-expanded={showF}>Filters{n ? ` · ${n}` : ""}</button>
            <select className="mk-sort" value={f.sort} onChange={(e) => set({ sort: e.target.value as Sort })} aria-label="Sort">{SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select>
          </div>
          {(rows == null || shown.length > 0) && <span className="mk-count">{rows == null ? "Loading…" : `${fmt(shown.length)} ${shown.length === 1 ? "item" : "items"}`}</span>}
          {rows != null && (shown.length ? (
            <ul className="mk-grid">{shown.map((l) => <ListingCard key={l.id} l={l} deal={dealPct(l, last)} onOpen={() => setSel(l.id)} />)}</ul>
          ) : (
            <div className="mk-empty">
              <b>{rows.length ? "No matches" : "Nothing listed yet"}</b>
              {rows.length ? <button type="button" className="hg-ghost" onClick={() => setF(NONE)}>Clear filters</button> : <Link href="/rocket" className="hg-ghost">List the first one</Link>}
            </div>
          ))}
        </div>
      </div>
      {open && <Sheet l={open} rows={rows ?? []} me={wallet} onPick={setSel} onClose={close} />}
    </div>
  );
}
