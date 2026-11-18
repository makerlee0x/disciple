"use client";
/**
 * Market and trades (maker 2026-11-16: transferable in Disciple's own database first, NFTs later; market on the website only,
 * 7% fee; no trade lock). Rules in lib/market.ts, server in lib/server/market.ts.
 *   - SellControl: "Sell" on a tradable copy in Your rocket (website only).
 *   - HangarTrades: your listings and trade offers, plus a new offer (works in the app too; listings show web-only).
 *   The /market storefront itself is ./MarketShop.
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { withBase } from "@/lib/base-path";
import {
  HULL_NAMES, RARITY_COLOR as SW, burnGrade, itemById,
  type Collection as Col, type Copy,
} from "@/lib/collection";
import { isNativeApp } from "@/lib/native";
import { MARKET_FEE_BPS, parsePrice, sellerCents, usd, type Listing, type Offer } from "@/lib/market";
import { findPilot, marketAction, useMine } from "@/lib/marketClient";
import { itemArt, title } from "./Collection";

const fmt = (n: number) => n.toLocaleString("en-US");
const FEE = `${MARKET_FEE_BPS / 100}%`;
const short = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;
const pilot = (name: string | null | undefined, w: string) => (name ? `@${name}` : short(w));
const copyLine = (c?: Copy) => (c ? `${c.serial ? `#${fmt(c.serial)}` : "Starter"} · ${burnGrade(c.burn).name}${c.trak != null ? ` · FlightTrak ${c.trak}` : ""}` : "");
const tradable = (c: Copy) => !c.bound && c.origin !== "starter";
/** Is this the website (not the iPhone app)? The market is website-only. Resolved after mount so SSR and the app agree. */
function useWeb() { const [web, setWeb] = useState(false); useEffect(() => setWeb(!isNativeApp()), []); return web; }

/* ------------------------------------------------------------- selling ------------------------------------------------------------- */

export interface SellHooks { web: boolean; listed: (uid: string) => Listing | undefined; wallet: string }

/** "Sell" on one copy: price, what you get after the fee, list it; or take it down. */
export function SellControl({ copy, listing, hooks }: { copy: Copy; listing?: Listing; hooks: SellHooks }) {
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  if (!hooks.web) return listing ? <span className="hgu-owned">On the market</span> : null;
  const cents = parsePrice(price);
  if (listing) {
    return (
      <span className="mkt-sell">
        <span className="hgu-owned">{listing.state === "pending" ? "Selling…" : `Listed ${usd(listing.price)}`}</span>
        {listing.state === "open" && <button type="button" className="dsc3-btn hgu-scrap" disabled={busy} onClick={async () => { setBusy(true); const r = await marketAction(hooks.wallet, { op: "unlist", listing: listing.id }); setBusy(false); if (!r.ok) setNote(r.reason ?? ""); }}>Take down</button>}
        {note && <small role="status">{note}</small>}
      </span>
    );
  }
  if (!open) return <button type="button" className="dsc3-btn hgu-scrap" onClick={() => setOpen(true)} data-testid={`sell-${copy.uid}`}>Sell</button>;
  return (
    <span className="mkt-sell open">
      <input className="ds-input mkt-price" placeholder="$ price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-label="Price in dollars" autoFocus />
      <button type="button" className="dsc3-btn dsc3-btn-primary hgu-buy sm" disabled={busy || !cents} data-testid={`list-${copy.uid}`}
        onClick={async () => { if (!cents) return; setBusy(true); setNote(""); const r = await marketAction(hooks.wallet, { op: "list", copy: copy.uid, price: cents }); setBusy(false); if (r.ok) setOpen(false); else setNote(r.reason ?? ""); }}>List</button>
      <button type="button" className="dsc3-btn hgu-scrap" onClick={() => { setOpen(false); setNote(""); }}>Cancel</button>
      <small>{cents ? `You get ${usd(sellerCents(cents))} after the ${FEE} fee` : "$1 to $10,000"}</small>
      {note && <small role="status">{note}</small>}
    </span>
  );
}

/** Your listings, as hooks for Your rocket. */
export function useSellHooks(wallet: string | null): { hooks?: SellHooks; mine: ReturnType<typeof useMine>["mine"] } {
  const web = useWeb();
  const { mine } = useMine(wallet);
  const hooks = useMemo<SellHooks | undefined>(() => {
    if (!wallet) return undefined;
    const by = new Map((mine?.listings ?? []).filter((l) => l.state === "open" || l.state === "pending").map((l) => [l.uid, l]));
    return { web, wallet, listed: (uid) => by.get(uid) };
  }, [wallet, web, mine]);
  return { hooks, mine };
}

/* ------------------------------------------------------------- trades ------------------------------------------------------------- */

function CopyChip({ c, on, onClick }: { c: Copy; on?: boolean; onClick?: () => void }) {
  const it = itemById(c.item);
  if (!it) return null;
  const inner = <><span className="mkt-chip-art">{itemArt(it, 40, false, "YOU", c)}</span><span><b>{it.kind === "skin" ? `${HULL_NAMES[it.hull!]} | ${it.name}` : it.name}</b><small>{copyLine(c)}</small></span></>;
  return onClick
    ? <button type="button" className={`mkt-chip${on ? " on" : ""}`} style={{ ["--sw" as string]: SW[it.rar] }} onClick={onClick} aria-pressed={!!on}>{inner}</button>
    : <span className="mkt-chip" style={{ ["--sw" as string]: SW[it.rar] }}>{inner}</span>;
}

function NewOffer({ wallet, col, onDone }: { wallet: string; col: Col | null; onDone: (msg: string) => void }) {
  const [to, setTo] = useState("");
  const [them, setThem] = useState<{ wallet: string; copies: Copy[] } | null>(null);
  const [give, setGive] = useState<string[]>([]);
  const [want, setWant] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const mine = (col?.copies ?? []).filter(tradable);
  const flip = (l: string[], set: (v: string[]) => void, u: string) => set(l.includes(u) ? l.filter((x) => x !== u) : l.length >= 8 ? l : [...l, u]);
  const look = async () => {
    setNote(""); setThem(null); setWant([]);
    const w = await findPilot(to);
    if (!w) return setNote("We couldn't find that pilot.");
    if (w === wallet.toLowerCase()) return setNote("That's you.");
    const j = await fetch(withBase(`/api/collection?wallet=${w}`), { cache: "no-store" }).then((r) => r.json()).catch(() => null);
    setThem({ wallet: w, copies: ((j?.collection?.copies ?? []) as Copy[]).filter(tradable) });
  };
  const send = async () => {
    if (!them) return;
    setBusy(true); setNote("");
    const r = await marketAction(wallet, { op: "offer", to: them.wallet, give, want });
    setBusy(false);
    if (r.ok) { setGive([]); setWant([]); setThem(null); setTo(""); onDone("Offer sent. It stays open for a week."); }
    else setNote(r.reason ?? "Couldn't send it.");
  };
  return (
    <div className="dsc3-panel hg-panel mkt-new" data-testid="new-offer">
      <header className="hg-panelh"><div><h2>New trade offer</h2><span>Pick what you give and what you want. Nothing moves until they accept, and then both sides swap at once.</span></div></header>
      <div className="mkt-find">
        <input className="ds-input" placeholder="Pilot name or 0x address" value={to} onChange={(e) => setTo(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void look(); }} aria-label="Pilot" />
        <button type="button" className="dsc3-btn hgu-scrap" onClick={look} disabled={!to.trim()}>Find</button>
      </div>
      <div className="mkt-sides">
        <div><h3>You give {give.length ? `· ${give.length}` : ""}</h3>
          {mine.length ? <div className="mkt-chips">{mine.map((c) => <CopyChip key={c.uid} c={c} on={give.includes(c.uid)} onClick={() => flip(give, setGive, c.uid)} />)}</div> : <p className="hg-sub">Nothing tradable yet. Copies from ranked duel crates trade.</p>}
        </div>
        <div><h3>You want {want.length ? `· ${want.length}` : ""}</h3>
          {!them ? <p className="hg-sub">Find a pilot to see what they have.</p>
            : them.copies.length ? <div className="mkt-chips">{them.copies.map((c) => <CopyChip key={c.uid} c={c} on={want.includes(c.uid)} onClick={() => flip(want, setWant, c.uid)} />)}</div>
              : <p className="hg-sub">They have nothing tradable yet. You can still send them a gift.</p>}
        </div>
      </div>
      <div className="mkt-send">
        <button type="button" className="dsc3-btn dsc3-btn-primary hgu-buy" disabled={busy || !them || (!give.length && !want.length)} onClick={send}>{busy ? "Sending…" : give.length && !want.length ? "Send gift offer" : "Send offer"}</button>
        {note && <p className="hg-sub" role="status">{note}</p>}
      </div>
    </div>
  );
}

function OfferRow({ o, me, onAnswer, busy }: { o: Offer; me: string; onAnswer: (op: "accept" | "decline" | "cancel") => void; busy: boolean }) {
  const incoming = o.to === me.toLowerCase();
  const other = incoming ? pilot(o.fromName, o.from) : pilot(o.toName, o.to);
  const youGive = incoming ? o.wantCopies ?? [] : o.giveCopies ?? [];
  const youGet = incoming ? o.giveCopies ?? [] : o.wantCopies ?? [];
  const STATE: Record<Offer["state"], string> = { open: incoming ? "Waiting on you" : "Waiting on them", accepted: "Done", declined: "Declined", cancelled: "Cancelled", expired: "Expired", failed: "Couldn't go through" };
  return (
    <li className={`mkt-offer ${o.state}`} data-testid="offer-row">
      <div className="mkt-offer-h"><b>{incoming ? `From ${other}` : `To ${other}`}</b><span className={o.state === "open" ? "hgu-owned" : "muted"}>{STATE[o.state]}</span></div>
      <div className="mkt-offer-sides">
        <div><small>You give</small><div className="mkt-chips">{youGive.length ? youGive.map((c) => <CopyChip key={c.uid} c={c} />) : <span className="muted">Nothing</span>}</div></div>
        <div><small>You get</small><div className="mkt-chips">{youGet.length ? youGet.map((c) => <CopyChip key={c.uid} c={c} />) : <span className="muted">Nothing</span>}</div></div>
      </div>
      {o.state === "open" && (
        <div className="hgu-copy-act">
          {incoming ? <>
            <button type="button" className="dsc3-btn dsc3-btn-primary hgu-buy sm" disabled={busy} onClick={() => onAnswer("accept")} data-testid="offer-accept">Accept</button>
            <button type="button" className="dsc3-btn hgu-scrap" disabled={busy} onClick={() => onAnswer("decline")}>Decline</button>
          </> : <button type="button" className="dsc3-btn hgu-scrap" disabled={busy} onClick={() => onAnswer("cancel")}>Cancel offer</button>}
        </div>
      )}
    </li>
  );
}

/** The Hangar's Trades section: your listings (website), trade offers, a new offer. */
export function HangarTrades({ col, wallet, mine }: { col: Col | null; wallet: string | null; mine: ReturnType<typeof useMine>["mine"] }) {
  const web = useWeb();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [composing, setComposing] = useState(false);
  if (!wallet) return null;
  const offers = mine?.offers ?? [];
  const open = offers.filter((o) => o.state === "open"), done = offers.filter((o) => o.state !== "open").slice(0, 6);
  const listings = (mine?.listings ?? []).filter((l) => l.state === "open" || l.state === "pending");
  const sold = (mine?.listings ?? []).filter((l) => l.state === "sold").slice(0, 5);
  const answer = async (o: Offer, op: "accept" | "decline" | "cancel") => {
    setBusy(true); setNote("");
    const r = await marketAction(wallet, { op, offer: o.id });
    setBusy(false);
    setNote(r.ok ? (op === "accept" ? "Traded. The copies are in your Hangar." : op === "decline" ? "Declined." : "Cancelled.") : r.reason ?? "Couldn't do that.");
  };
  return (
    <section className="hg-sec hgu-sec" aria-labelledby="hg-trades" data-testid="hangar-trades">
      <header className="hg-sech">
        <div><h2 id="hg-trades" className="dsc3-h2">Trades</h2><span>Copies from ranked duel crates and weekly orders trade. Each keeps its serial, burn, pattern and history when it moves.</span></div>
        {web && <Link href="/market" className="hg-ghost" data-testid="open-market">Open the market</Link>}
      </header>
      {note && <p className="hg-sub" role="status">{note}</p>}
      {web && (listings.length > 0 || sold.length > 0) && (
        <div className="dsc3-panel hg-panel">
          <header className="hg-panelh"><div><h2>Your listings</h2><span>Buyers pay in Cash. You get the price minus the {FEE} fee, straight to your wallet.</span></div></header>
          <ul className="hgu-copy-rows">
            {[...listings, ...sold].map((l) => { const it = itemById(l.item); if (!it) return null; return (
              <li key={l.id} style={{ ["--sw" as string]: SW[it.rar] }}>
                <span className="hgu-copy-art">{itemArt(it, 56, false, "YOU", l.copy)}</span>
                <span className="hgu-copy-tx"><b>{title(it)}</b><span>{copyLine(l.copy)}</span></span>
                <span className="hgu-copy-act"><span className="hgu-owned">{l.state === "sold" ? `Sold ${usd(l.price)}` : l.state === "pending" ? "Selling…" : usd(l.price)}</span>
                  {l.state === "open" && <button type="button" className="dsc3-btn hgu-scrap" disabled={busy} onClick={async () => { setBusy(true); const r = await marketAction(wallet, { op: "unlist", listing: l.id }); setBusy(false); if (!r.ok) setNote(r.reason ?? ""); }}>Take down</button>}</span>
              </li>
            ); })}
          </ul>
        </div>
      )}
      {open.length > 0 && <ul className="mkt-offers">{open.map((o) => <OfferRow key={o.id} o={o} me={wallet} busy={busy} onAnswer={(op) => answer(o, op)} />)}</ul>}
      {composing ? <NewOffer wallet={wallet} col={col} onDone={(m) => { setComposing(false); setNote(m); }} />
        : <div className="mkt-row"><button type="button" className="dsc3-btn dsc3-btn-primary hgu-buy" onClick={() => setComposing(true)} data-testid="compose-offer">New trade offer</button>
          {!open.length && <span className="hg-sub">No open offers.{web ? " Or sell a copy: open it in Your rocket and tap Sell." : ""}</span>}</div>}
      {done.length > 0 && (
        <details className="mkt-past"><summary>Past offers · {done.length}</summary>
          <ul className="mkt-offers">{done.map((o) => <OfferRow key={o.id} o={o} me={wallet} busy={busy} onAnswer={() => {}} />)}</ul>
        </details>
      )}
    </section>
  );
}
