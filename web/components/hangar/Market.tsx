"use client";
/**
 * Market and trades (maker 2026-11-16: transferable in Disciple's own database first, NFTs later; market on the website only,
 * 7% fee; no trade lock). Rules in lib/market.ts, server in lib/server/market.ts.
 *   - SellControl: "Sell" on a tradable copy in Your rocket (website only): to anyone, or privately to one @user.
 *   - HangarTrades: private sales for you, cash offers on your copies, offers you sent, your listings, a new offer.
 * Items only ever move as a sale with the 7% fee (maker 2026-11-19): no swaps, no gifts, $1 minimum.
 *   The /market storefront itself is ./MarketShop.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { withBase } from "@/lib/base-path";
import {
  HULL_NAMES, RARITY_COLOR as SW, burnGrade, itemById,
  type Collection as Col, type Copy,
} from "@/lib/collection";
import { isNativeApp } from "@/lib/native";
import { MARKET_FEE_BPS, OFFER_PAY_MS, parsePrice, sellerCents, usd, type Listing, type Offer } from "@/lib/market";
import { marketAction, useMine } from "@/lib/marketClient";
import UserPicker from "@/components/ui/UserPicker";
import type { Recipient } from "@/lib/send/recipient";
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

/** "Sell" on one copy: price, anyone or one @user, what you get after the fee; or take it down. */
export function SellControl({ copy, listing, hooks }: { copy: Copy; listing?: Listing; hooks: SellHooks }) {
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState("");
  const [priv, setPriv] = useState(false);
  const [to, setTo] = useState<Recipient | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const f = () => devSell.get(copy.uid)?.({ setOpen, setPrice, setPriv, setTo });
    f(); addEventListener("disciple:sell-dev", f); return () => removeEventListener("disciple:sell-dev", f);
  }, [copy.uid]);
  if (!hooks.web) return listing ? <span className="hgu-owned">On the market</span> : null;
  const cents = parsePrice(price);
  if (listing) {
    return (
      <span className="mkt-sell">
        <span className="hgu-owned">{listing.state === "pending" ? "Selling…" : `Listed ${usd(listing.price)}`}</span>
        {listing.to && listing.state === "open" && <span className="hgu-chip mkt-priv" data-testid="listed-private">@{listing.toName ?? short(listing.to)}</span>}
        {listing.state === "open" && <button type="button" className="dsc3-btn hgu-scrap" disabled={busy} onClick={async () => { setBusy(true); const r = await marketAction(hooks.wallet, { op: "unlist", listing: listing.id }); setBusy(false); if (!r.ok) setNote(r.reason ?? ""); }}>Take down</button>}
        {note && <small role="status">{note}</small>}
      </span>
    );
  }
  if (!open) return <button type="button" className="dsc3-btn hgu-scrap" onClick={() => setOpen(true)} data-testid={`sell-${copy.uid}`}>Sell</button>;
  const ready = !!cents && (!priv || !!to);
  return (
    <span className="mkt-sell open" data-testid="sell-open">
      <span className="mkt-seg" role="group" aria-label="Who can buy">
        <button type="button" className={`mkt-toggle${priv ? "" : " on"}`} aria-pressed={!priv} onClick={() => setPriv(false)}>Anyone</button>
        <button type="button" className={`mkt-toggle${priv ? " on" : ""}`} aria-pressed={priv} onClick={() => setPriv(true)} data-testid="sell-private">One pilot</button>
      </span>
      <input className="ds-input mkt-price" placeholder="$ price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-label="Price in dollars" autoFocus />
      <button type="button" className="dsc3-btn dsc3-btn-primary hgu-buy sm" disabled={busy || !ready} data-testid={`list-${copy.uid}`}
        onClick={async () => { if (!cents) return; setBusy(true); setNote(""); const r = await marketAction(hooks.wallet, { op: "list", copy: copy.uid, price: cents, ...(priv && to ? { to: to.address } : {}) }); setBusy(false); if (r.ok) setOpen(false); else setNote(r.reason ?? ""); }}>
        {priv && to ? `Sell to @${to.username || short(to.address)}` : "List"}</button>
      <button type="button" className="dsc3-btn hgu-scrap" onClick={() => { setOpen(false); setNote(""); setPriv(false); setTo(null); }}>Cancel</button>
      {priv && <span className="mkt-sell-to"><UserPicker value={to} onChange={setTo} me={hooks.wallet} label="Sell to" id={`sell-to-${copy.uid}`} /></span>}
      <small>{cents ? `You get ${usd(sellerCents(cents))} after the ${FEE} fee` : "$1 to $10,000"}</small>
      {note && <small role="status">{note}</small>}
    </span>
  );
}
// dev only (screenshots): window.__sellDev(uid, { price, priv, to }) opens a copy's Sell control filled in
type SellSet = { setOpen: (v: boolean) => void; setPrice: (v: string) => void; setPriv: (v: boolean) => void; setTo: (v: Recipient | null) => void };
const devSell = new Map<string, (s: SellSet) => void>();
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (window as unknown as { __sellDev?: (uid: string, v: { price?: string; priv?: boolean; to?: Recipient | null }) => void }).__sellDev = (uid, v) => {
    devSell.set(uid, (s) => { s.setOpen(true); if (v.price) s.setPrice(v.price); s.setPriv(!!v.priv); s.setTo(v.to ?? null); });
    dispatchEvent(new Event("disciple:sell-dev"));
  };
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

const itemTitle = (id: string) => { const it = itemById(id); return it ? (it.kind === "skin" ? `${HULL_NAMES[it.hull!]} | ${it.name}` : it.name) : "Item"; };

function CopyChip({ c, on, onClick }: { c: Copy; on?: boolean; onClick?: () => void }) {
  const it = itemById(c.item);
  if (!it) return null;
  const inner = <><span className="mkt-chip-art">{itemArt(it, 40, false, "YOU", c)}</span><span><b>{itemTitle(c.item)}</b><small>{copyLine(c)}</small></span></>;
  return onClick
    ? <button type="button" className={`mkt-chip${on ? " on" : ""}`} style={{ ["--sw" as string]: SW[it.rar] }} onClick={onClick} aria-pressed={!!on}>{inner}</button>
    : <span className="mkt-chip" style={{ ["--sw" as string]: SW[it.rar] }}>{inner}</span>;
}

/** One copy row in the Trades panel: art, name + a line, then the money and the buttons. */
function Row({ item, copy, line, act, testid }: { item: string; copy?: Copy; line: ReactNode; act: ReactNode; testid?: string }) {
  const it = itemById(item);
  if (!it) return null;
  return (
    <li style={{ ["--sw" as string]: SW[it.rar] }} data-testid={testid}>
      <span className="hgu-copy-art">{itemArt(it, 48, false, "YOU", copy)}</span>
      <span className="hgu-copy-tx"><b>{title(it)}</b><span>{line}</span></span>
      <span className="hgu-copy-act">{act}</span>
    </li>
  );
}

/** Make a cash offer on any tradable copy another pilot holds: find them by @username, pick the copy, name a price. */
export function OfferComposer({ wallet, onDone, preset }: { wallet: string; onDone: (msg: string) => void; preset?: { to: Recipient; copies: Copy[]; pick?: string; price?: string } }) {
  const [to, setTo] = useState<Recipient | null>(preset?.to ?? null);
  const [copies, setCopies] = useState<Copy[] | null>(preset?.copies ?? null);
  const [pick, setPick] = useState<string | null>(preset?.pick ?? null);
  const [price, setPrice] = useState(preset?.price ?? "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    if (preset) return;
    setCopies(null); setPick(null);
    if (!to) return;
    fetch(withBase(`/api/collection?wallet=${to.address}`), { cache: "no-store" }).then((r) => r.json())
      .then((j) => setCopies(((j?.collection?.copies ?? []) as Copy[]).filter(tradable))).catch(() => setCopies([]));
  }, [to, preset]);
  const cents = parsePrice(price);
  const send = async () => {
    if (!pick || !cents) return;
    setBusy(true); setNote("");
    const r = await marketAction(wallet, { op: "offer", copy: pick, price: cents });
    setBusy(false);
    if (r.ok) onDone(`Offer sent to @${to?.username ?? ""}.`); else setNote(r.reason ?? "Couldn't send it.");
  };
  return (
    <div className="mkt-new" data-testid="new-offer">
      <UserPicker value={to} onChange={setTo} me={wallet} label="Pilot" id="offer-to" />
      {to && copies && (copies.length
        ? <div className="mkt-chips mkt-pick">{copies.map((c) => <CopyChip key={c.uid} c={c} on={pick === c.uid} onClick={() => setPick(pick === c.uid ? null : c.uid)} />)}</div>
        : <p className="mk-note">Nothing tradable</p>)}
      {pick && (
        <div className="mkt-offer-go">
          <input className="ds-input mkt-price" placeholder="$ offer" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-label="Offer in dollars" />
          <button type="button" className="dsc3-btn dsc3-btn-primary hgu-buy sm" disabled={busy || !cents} onClick={send} data-testid="offer-send">{busy ? "Sending…" : cents ? `Offer ${usd(cents)}` : "Offer"}</button>
          <small>{cents ? "Paid from Cash if they take it" : "$1 to $10,000"}</small>
        </div>
      )}
      {note && <p className="mk-note" role="status">{note}</p>}
    </div>
  );
}

type Tab = "priv" | "req" | "offers" | "listings";
/** Last time you opened each Trades tab (per browser): a tab with anything newer gets a dot. */
const SEEN_KEY = "disciple.trades.seen";
const readSeen = (): Partial<Record<Tab, number>> => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "{}") ?? {}; } catch { return {}; } };
const markSeen = (t: Tab) => { try { localStorage.setItem(SEEN_KEY, JSON.stringify({ ...readSeen(), [t]: Date.now() })); } catch { /* private mode */ } };
const left = (until?: number) => { if (!until) return ""; const h = Math.max(0, Math.ceil((until - Date.now()) / 3_600_000)); return `${h}h left`; };

/** Trades panel beside the rocket card on /rocket: private sales for you, offers on your copies, offers you sent, your listings. */
export function HangarTrades({ wallet, mine }: { col?: Col | null; wallet: string | null; mine: ReturnType<typeof useMine>["mine"] }) {
  const web = useWeb();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [composing, setComposing] = useState(false);
  const [preset, setPreset] = useState<Parameters<typeof OfferComposer>[0]["preset"]>();
  const [tab, setTab] = useState<Tab | null>(null);
  const [seen, setSeen] = useState<Partial<Record<Tab, number>>>({});
  useEffect(() => setSeen(readSeen()), []);
  const tabsRef = useRef<HTMLDivElement>(null);
  // keep the open tab in view when the tab row scrolls (phones)
  useEffect(() => { const r = tabsRef.current, b = r?.querySelector<HTMLElement>("[aria-selected=true]"); if (r && b) r.scrollTo({ left: b.offsetLeft - r.offsetLeft - 8 }); });
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __offerDev?: (p: typeof preset) => void }).__offerDev = (p) => { setPreset(p); setComposing(true); setTab("offers"); };
    (window as unknown as { __tradesTab?: (t: Tab) => void }).__tradesTab = setTab;
  }, []);
  if (!wallet) return null;
  const me = wallet.toLowerCase();
  const offers = mine?.offers ?? [];
  const listings = mine?.listings ?? [];
  const forYou = listings.filter((l) => l.to === me && l.seller !== me && l.state === "open");
  const incoming = offers.filter((o) => o.to === me && o.state === "open");
  const sent = offers.filter((o) => o.from === me && (o.state === "open" || o.state === "accepted"));
  const mineOpen = listings.filter((l) => l.seller === me && (l.state === "open" || l.state === "pending"));
  const sold = listings.filter((l) => l.seller === me && l.state === "sold");
  const act = async (a: Parameters<typeof marketAction>[1], ok: string) => {
    setBusy(true); setNote("");
    const r = await marketAction(wallet, a);
    setBusy(false); setNote(r.ok ? ok : r.reason ?? "Couldn't do that.");
  };
  const buyBtn = (l: Listing) => web
    ? <Link href={`/market?l=${l.id}`} className="dsc3-btn dsc3-btn-primary hgu-buy sm" data-testid="private-buy">Buy {usd(l.price)}</Link>
    : <span className="hgu-owned">{usd(l.price)} · on the web</span>;
  const newest: Record<Tab, number> = {
    priv: Math.max(0, ...forYou.map((l) => l.at)),
    req: Math.max(0, ...incoming.map((o) => o.at)),
    offers: Math.max(0, ...sent.filter((o) => o.state === "accepted").map((o) => o.doneAt ?? o.at)),
    listings: Math.max(0, ...sold.map((l) => l.soldAt ?? l.at)),
  };
  const fresh = (t: Tab) => newest[t] > (seen[t] ?? 0);
  const cur: Tab = tab ?? (["priv", "req", "offers", "listings"] as Tab[]).find(fresh) ?? (forYou.length ? "priv" : incoming.length ? "req" : sent.length ? "offers" : "listings");
  const TABS: [Tab, string, number][] = [["priv", "Private sales", forYou.length], ["req", "Trade requests", incoming.length], ["offers", "Your offers", sent.length], ["listings", "Your listings", mineOpen.length]];
  const pick = (t: Tab) => { setTab(t); markSeen(t); setSeen(readSeen()); };
  return (
    <section className="dsc3-panel hg-panel hgu-trades" aria-labelledby="hg-trades" data-testid="hangar-trades">
      <header className="hg-panelh"><h2 id="hg-trades">Trades</h2>{web && <Link href="/market" data-testid="open-market">Market</Link>}</header>
      <div className="hg-ranges hgu-hulls mkt-tabs" role="tablist" aria-label="Trades" ref={tabsRef}>
        {TABS.map(([k, label, n]) => <button key={k} type="button" role="tab" aria-selected={cur === k} className={cur === k ? "on" : ""} onClick={() => pick(k)} data-testid={`tab-${k}`}>
          {label}{n ? ` · ${n}` : ""}{fresh(k) && cur !== k && <i className="mkt-dot" aria-label="New" />}</button>)}
      </div>
      {note && <p className="hg-sub" role="status">{note}</p>}
      {cur === "priv" && (forYou.length ? (
        <ul className="hgu-copy-rows" data-testid="for-you">
          {forYou.map((l) => (
            <Row key={l.id} item={l.item} copy={l.copy} testid="for-you-row"
              line={<>{pilot(l.sellerName, l.seller)} · {copyLine(l.copy)}{l.until ? ` · ${left(l.until)}` : ""}</>}
              act={buyBtn(l)} />
          ))}
        </ul>
      ) : <p className="mk-note mkt-empty">No private sales</p>)}
      {cur === "req" && (incoming.length ? (
        <ul className="hgu-copy-rows" data-testid="offers-in">
          {incoming.map((o) => (
            <Row key={o.id} item={o.item} copy={o.copy} testid="offer-row"
              line={<>{pilot(o.fromName, o.from)} · {copyLine(o.copy)}</>}
              act={<>
                <span className="mkt-amt"><b>{usd(o.price)}</b><small>You get {usd(sellerCents(o.price))}</small></span>
                <button type="button" className="dsc3-btn dsc3-btn-primary hgu-buy sm" disabled={busy} onClick={() => act({ op: "accept", offer: o.id }, "Accepted. It sells when they pay.")} data-testid="offer-accept">Accept</button>
                <button type="button" className="dsc3-btn hgu-scrap" disabled={busy} onClick={() => act({ op: "decline", offer: o.id }, "Declined.")}>Decline</button>
              </>} />
          ))}
        </ul>
      ) : <p className="mk-note mkt-empty">No requests</p>)}
      {cur === "offers" && (<>
        {sent.length > 0 ? (
          <ul className="hgu-copy-rows" data-testid="offers-out">{sent.map((o) => (
            <Row key={o.id} item={o.item} copy={o.copy} testid="offer-out-row"
              line={<>{pilot(o.toName, o.to)} · {copyLine(o.copy)}</>}
              act={o.state === "accepted" && o.listing
                ? <>{web ? <Link href={`/market?l=${o.listing}`} className="dsc3-btn dsc3-btn-primary hgu-buy sm">Pay {usd(o.price)}</Link> : <span className="hgu-owned">Pay on the web</span>}<span className="hgu-owned">Accepted · {left(o.at + OFFER_PAY_MS)}</span></>
                : <><span className="mkt-amt"><b>{usd(o.price)}</b><small>Waiting</small></span>
                  <button type="button" className="dsc3-btn hgu-scrap" disabled={busy} onClick={() => act({ op: "cancel", offer: o.id }, "Cancelled.")}>Cancel</button></>} />
          ))}</ul>
        ) : !composing && <p className="mk-note mkt-empty">No offers out</p>}
        {composing
          ? <div className="hgu-trades-list"><h3>New offer <button type="button" className="mk-link mkt-x" onClick={() => { setComposing(false); setPreset(undefined); }}>Cancel</button></h3>
              <OfferComposer wallet={wallet} preset={preset} onDone={(m) => { setComposing(false); setPreset(undefined); setNote(m); }} /></div>
          : <div className="mkt-row"><button type="button" className="dsc3-btn dsc3-btn-primary hgu-buy sm" onClick={() => setComposing(true)} data-testid="compose-offer">Make an offer</button></div>}
      </>)}
      {cur === "listings" && ((mineOpen.length || sold.length) ? (
        <ul className="hgu-copy-rows">{[...mineOpen, ...sold.slice(0, 5)].map((l) => (
          <Row key={l.id} item={l.item} copy={l.copy}
            line={<>{copyLine(l.copy)}{l.to ? <> · <span className="mkt-priv-tx">@{l.toName ?? short(l.to)}</span></> : null}</>}
            act={<><span className="hgu-owned">{l.state === "sold" ? `Sold ${usd(l.price)}` : l.state === "pending" ? "Selling…" : usd(l.price)}</span>
              {l.state === "open" && web && <button type="button" className="dsc3-btn hgu-scrap" disabled={busy} onClick={() => act({ op: "unlist", listing: l.id }, "Taken down.")}>Take down</button>}</>} />
        ))}</ul>
      ) : <p className="mk-note mkt-empty">Nothing listed</p>)}
    </section>
  );
}
