"use client";
/**
 * Hangar collection (maker's pick 2026-11-16: series + crates + daily shop; static screens in
 * /mnt/project-files/hangar/unlocks): "Your rocket" (skins found per hull, trail, what you fly), "Crates" (open with
 * odds shown) and "Shop" (today's stock for XP to spend). Rules in lib/collection.ts, server in lib/server/collection.ts.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { withBase } from "@/lib/base-path";
import { playSfx } from "@/lib/game/sfx";
import {
  CRATE, CRATE_PRICE, HULL_NAMES, ITEMS, PAINTS, PRESTIGE_HULL, PRICE, RARITY_COLOR as SW, RARITY_NAME as RL, SERIES, SHOP_CRATE_ID, STARTER_TAG, TRAILS,
  crateArt, crateBurstArt, crateOdds, glintArt, itemById, liveSeries, pctLabel, seriesArt, skinArt, skinId, tagArt, trailArt, trailId,
  type Collection as Col, type Crate, type Item, type Opened, type Rarity, type ShopStock,
} from "@/lib/collection";
import { collectionAction } from "@/lib/collectionClient";

const fmt = (n: number) => n.toLocaleString("en-US");
// eslint-disable-next-line @next/next/no-img-element
const Img = ({ src, h, dim }: { src: string; h: number; dim?: boolean }) => <img src={withBase(src)} alt="" loading="lazy" style={{ height: h, width: "auto", maxWidth: "100%", objectFit: "contain", filter: dim ? "brightness(0) opacity(.55)" : undefined }} />;

/** A trail's plume sheet, flickering (6 frames, black drops out with screen blending). */
function Plume({ id, h }: { id: string; h: number }) {
  const t = id.replace(/^trail-/, "");
  return <span className="hgu-plume" aria-hidden style={{ height: h, width: h / 3, backgroundImage: `url(${withBase(trailArt(t))})` }} />;
}
/** Marble & Gold Leaf skins get the gold glint sweeping up them (4 frames, then a pause). */
const GLINT_W: Record<string, number> = { bullet: 145, needle: 128, pulp: 179, wedge: 234, "ring-tail": 139, hauler: 139, shuttle: 184, "twin-booster": 139 };
function SkinArt({ i, h, dim }: { i: Item; h: number; dim?: boolean }) {
  if (i.paint === "marble-gilt" && !dim && GLINT_W[i.hull!]) return <span className="hgu-glint" aria-hidden style={{ height: h, width: (h * GLINT_W[i.hull!]) / 320, ["--ga" as string]: GLINT_W[i.hull!] / 320, backgroundImage: `url(${withBase(glintArt(i.hull!))})` }} />;
  return <Img src={skinArt(i.id)} h={h} dim={dim} />;
}
/** A name-tag plate with the name in its empty middle (prestige plates carry an emblem on the left). */
function Tag({ id, name, w }: { id: string; name: string; w: number }) {
  return <span className={`hgu-plate${id.includes("prestige") ? " pr" : ""}`} style={{ width: w, height: (w * 140) / 600, backgroundImage: `url(${withBase(tagArt(id))})`, fontSize: Math.max(11, w / 13) }}><b>{name}</b></span>;
}
const itemArt = (i: Item, h: number, dim?: boolean, handle = "YOU") => (i.kind === "skin" ? <SkinArt i={i} h={h} dim={dim} /> : i.kind === "trail" ? <Plume id={i.id} h={h} /> : <Tag id={i.id} name={handle} w={Math.min(230, h * 2.2)} />);
const title = (i: Item) => (i.kind === "skin" ? <>{HULL_NAMES[i.hull!]} <em>|</em> {i.name}</> : <>{i.name}</>);
const kindLabel = (i: Item) => (i.kind === "skin" ? HULL_NAMES[i.hull!] : i.kind === "trail" ? "trail" : "name tag");

function Card({ rar, on, locked, name, label, sub, a, onClick, testid, wide }: { rar: Rarity; on?: boolean; locked?: boolean; wide?: boolean; name: ReactNode; label: string; sub: ReactNode; a: ReactNode; onClick?: () => void; testid?: string }) {
  const inner = (
    <>
      <span className="hg-look-art">{a}</span>
      <span className="hg-look-tx">
        <span className="hg-look-r" style={{ color: SW[rar] }}>{label}</span>
        <b>{name}</b>
        <span className="hg-look-s">{sub}</span>
      </span>
    </>
  );
  const cls = `hg-look r-${rar}${on ? " on" : ""}${locked ? " locked" : ""}${wide ? " hgu-wide" : ""}`, style = { ["--sw" as string]: SW[rar] };
  return <li>{onClick ? <button type="button" className={cls} style={style} onClick={onClick} disabled={locked} aria-pressed={!!on} data-testid={testid}>{inner}</button> : <div className={cls} style={style} data-testid={testid}>{inner}</div>}</li>;
}

/* ------------------------------------------------------------ Your rocket ------------------------------------------------------------ */

export function YourRocket({ col, wallet, handle }: { col: Col | null; wallet: string | null; handle: string }) {
  const now = Date.now();
  const owned = useMemo(() => new Set(col?.owned ?? []), [col]);
  const eq = col?.equipped ?? { skin: skinId("bullet", "white-gloss"), trail: trailId("gold"), tag: STARTER_TAG };
  const eqItem = itemById(eq.skin)!;
  const live = liveSeries(now) ?? SERIES[0];
  const released = SERIES.filter((s) => s.start != null && s.start <= now);
  const hullTabs = [...new Set(released.flatMap((s) => s.hulls))];
  const [hull, setHull] = useState<string>(eqItem.hull ?? hullTabs[0]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState(false);
  // open on the hull you fly, once the collection has loaded
  useEffect(() => { if (col && !picked) { setPicked(true); if (eqItem.hull) setHull(eqItem.hull); } }, [col, picked, eqItem.hull]);
  const prestige = col?.prestige ?? 0;
  const paintsFound = new Set([...owned].filter((id) => id.includes("--") && !id.startsWith(PRESTIGE_HULL)).map((id) => id.split("--")[1]));

  const skins: Item[] = hull === PRESTIGE_HULL
    ? Object.keys(PAINTS).map((p) => itemById(skinId(PRESTIGE_HULL, p))!).filter(Boolean)
    : ITEMS.filter((i) => i.kind === "skin" && i.hull === hull && released.some((s) => s.n === i.series));
  const has = (i: Item) => (i.hull === PRESTIGE_HULL ? prestige >= 1 && paintsFound.has(i.paint!) : owned.has(i.id));
  const liveSkins = ITEMS.filter((i) => i.kind === "skin" && i.series === live.n);
  const found = liveSkins.filter((i) => owned.has(i.id)).length;
  const daysLeft = live.end ? Math.max(0, Math.ceil((live.end - now) / 86_400_000)) : null;

  const wear = async (skin: string, trail: string, tag = eq.tag) => {
    if (!wallet || busy) return;
    setBusy(true); setNote("");
    const r = await collectionAction(wallet, { op: "equip", skin, trail, tag });
    setBusy(false);
    if (!r.ok) setNote(r.reason || "Couldn't save that. Try again."); else playSfx("skin_equip", { gapMs: 300 });
  };
  // trails from the series that are out (later ones stay a surprise), the prestige trail; tags: the 6 plates, the prestige plates you have and the next one
  const trails = TRAILS.filter((t) => t.series === 0 || released.some((r) => r.n === t.series));
  const tags = ITEMS.filter((i) => i.kind === "tag" && (!i.prestige || i.prestige <= prestige + 1));
  const count = (h: string) => { const all = ITEMS.filter((i) => i.kind === "skin" && i.hull === h && released.some((s) => s.n === i.series)); return `${all.filter((i) => owned.has(i.id)).length}/${all.length}`; };

  return (
    <section className="hg-sec hgu-sec" aria-labelledby="hg-looks" data-testid="rocket-collection">
      <header className="hg-sech"><div><h2 id="hg-looks" className="dsc3-h2">Your rocket</h2><span>Every skin is made for one hull. Find them in crates or catch them in the shop.</span></div></header>
      <div className="hgu-equip" style={{ ["--sw" as string]: SW[eqItem.rar] }}>
        <span className="hgu-equip-art"><SkinArt i={eqItem} h={210} /><Plume id={eq.trail} h={120} /></span>
        <div className="hgu-equip-tx">
          <span className="hg-look-r" style={{ color: SW[eqItem.rar] }}>{RL[eqItem.rar]}{eqItem.series ? ` · Series ${eqItem.series}` : " · Prestige"}</span>
          <b>{title(eqItem)}</b>
          <span>{itemById(eq.trail)?.name ?? "Gold"} trail · flies in Trading Duels</span>
          <Tag id={eq.tag} name={handle} w={220} />
          <p>Your name tag floats over your rocket in every race.</p>
        </div>
      </div>
      <div className="hgu-series">
        <div><span className="hg-look-r" style={{ color: "var(--dsc3-light-champagne)" }}>Series {live.n} · {live.name}</span><b>{found} of {liveSkins.length} found</b></div>
        <span className="hgu-meter"><i style={{ width: `${Math.round((found / Math.max(1, liveSkins.length)) * 100)}%` }} /></span>
        <span className="hgu-leaves">{daysLeft != null ? `Series ${live.n} crates stop dropping in ${daysLeft} days` : `Series ${live.n} is dropping now`}</span>
      </div>
      <div className="hg-ranges hgu-hulls" role="tablist" aria-label="Hulls">
        {hullTabs.map((h) => <button key={h} type="button" role="tab" aria-selected={hull === h} className={hull === h ? "on" : ""} onClick={() => setHull(h)}>{HULL_NAMES[h]} · {count(h)}</button>)}
        {SERIES.filter((s) => s.start == null).slice(0, 1).flatMap((s) => s.hulls).map((h) => <button key={h} type="button" disabled>{HULL_NAMES[h]} · Series {SERIES.find((s) => s.hulls.includes(h))!.n}</button>)}
        <button type="button" role="tab" aria-selected={hull === PRESTIGE_HULL} className={hull === PRESTIGE_HULL ? "on" : ""} disabled={prestige < 1} onClick={() => setHull(PRESTIGE_HULL)}>Ring-tail · Prestige</button>
      </div>
      {note && <p className="hg-sub" role="status">{note}</p>}
      <ul className="hg-looks">
        {skins.map((s) => {
          const own = has(s), on = s.id === eq.skin;
          return <Card key={s.id} rar={s.rar} on={on} locked={!own} name={own ? s.name : "???"} label={RL[s.rar]} testid={`skin-${s.id}`}
            sub={own ? (on ? "Equipped" : "Tap to equip") : hull === PRESTIGE_HULL ? (prestige < 1 ? "Prestige 1" : "Find this paint first") : "Not found yet"}
            a={<SkinArt i={s} h={98} dim={!own} />} onClick={own && !on ? () => wear(s.id, eq.trail) : undefined} />;
        })}
      </ul>
      <div className="hg-looks-row">
        <div className="hg-looks-h"><h3>Trail</h3><span>Gold core, so you stay easy to spot</span></div>
        <ul className="hg-looks">
          {trails.map((t) => {
            const id = trailId(t.id), own = owned.has(id), on = id === eq.trail;
            return <Card key={id} rar={t.rar} on={on} locked={!own} name={t.name} label={t.prestige ? `Prestige ${t.prestige}` : RL[t.rar]} a={<Plume id={id} h={98} />} testid={`trail-${t.id}`}
              sub={own ? (on ? "Equipped" : "Tap to equip") : t.prestige ? `Reach Prestige ${t.prestige}` : `Series ${t.series} crates`} onClick={own && !on ? () => wear(eq.skin, id) : undefined} />;
          })}
        </ul>
      </div>
      <div className="hg-looks-row">
        <div className="hg-looks-h"><h3>Name tag</h3><span>Prestige plates come with each Prestige</span></div>
        <ul className="hg-looks">
          {tags.map((t) => {
            const own = owned.has(t.id), on = t.id === eq.tag;
            return <Card key={t.id} wide rar={t.rar} on={on} locked={!own} name={t.name} label={t.prestige ? `Prestige ${t.prestige}` : RL[t.rar]} a={<Tag id={t.id} name={own ? handle : "???"} w={150} />} testid={`tag-${t.id}`}
              sub={own ? (on ? "Equipped" : "Tap to equip") : t.prestige ? `Reach Prestige ${t.prestige}` : `${RL[t.rar]} crates and up`} onClick={own && !on ? () => wear(eq.skin, eq.trail, t.id) : undefined} />;
          })}
        </ul>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- Crates ---------------------------------------------------------------- */

export function Crates({ col, wallet }: { col: Col | null; wallet: string | null }) {
  const crates = useMemo(() => [...(col?.crates ?? [])].sort((a, b) => RARITY_RANK(b.tier) - RARITY_RANK(a.tier) || b.at - a.at), [col]);
  const [sel, setSel] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened | null>(col?.recent?.[0] ?? null);
  const [burst, setBurst] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => { if (!sel || !crates.some((c) => c.id === sel)) setSel(crates[0]?.id ?? null); }, [crates, sel]);
  useEffect(() => { if (!opened && col?.recent?.[0]) setOpened(col.recent[0]); }, [col, opened]);
  const cur: Crate | undefined = crates.find((c) => c.id === sel);
  const live = liveSeries(Date.now()) ?? SERIES[0];

  const open = async () => {
    if (!wallet || !cur || busy) return;
    setBusy(true); setNote(""); playSfx("crate_shake", { gapMs: 200 });
    const r = await collectionAction(wallet, { op: "open", crate: cur.id });
    setBusy(false);
    if (r.ok && r.opened) { setOpened(r.opened); setBurst((n) => n + 1); playSfx("crate_open", { gapMs: 200 }); }
    else setNote(r.reason || "Couldn't open it. Try again.");
  };

  return (
    <section className="hg-sec hgu-sec" aria-labelledby="hg-crates" data-testid="rocket-crates">
      <header className="hg-sech"><div><h2 id="hg-crates" className="dsc3-h2">Crates</h2><span>Win a ranked duel and a crate drops. Levels and weekly missions drop them too.</span></div></header>
      {crates.length ? (
        <ul className="hgu-crates">
          {crates.slice(0, 6).map((c) => (
            <li key={c.id} className={c.id === sel ? "on" : ""} style={{ ["--sw" as string]: SW[c.tier] }}>
              <button type="button" onClick={() => setSel(c.id)} aria-pressed={c.id === sel}>
                <Img src={crateArt(c.tier)} h={120} />
                <span className="hg-look-r" style={{ color: SW[c.tier] }}>{RL[c.tier]} crate</span>
                <small>{c.label}</small>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="hg-empty"><b>No crates yet</b><p>Win a ranked duel, level up or finish your weekly missions to get one.</p></div>
      )}
      {crates.length > 6 && <p className="hg-sub">+{crates.length - 6} more to open</p>}
      {cur && (
        <div className="dsc3-panel hg-panel hgu-odds" style={{ ["--sw" as string]: SW[cur.tier] }}>
          <header className="hg-panelh"><div><h2>{RL[cur.tier]} crate</h2><span>Series {live.n} · {live.name}. 1 item, {RL[CRATE[cur.tier].floor]} or better, plus {CRATE[cur.tier].xp} XP.</span></div></header>
          <div className="hgu-odds-grid">
            <ol>
              {crateOdds("common").map(({ rar }) => {
                const row = crateOdds(cur.tier).find((o) => o.rar === rar);
                return <li key={rar} className={row ? "" : "off"}><i style={{ background: SW[rar] }} /><span>{RL[rar]}</span><b>{row ? pctLabel(row.pct) : "Can't drop"}</b></li>;
              })}
            </ol>
            <div className="hgu-odds-note">
              <p>Odds are shown on every crate. Anything you already own turns into XP. Crates hold skins and trails from the series that&apos;s live now, plus name tags.</p>
              <button type="button" className="dsc3-btn dsc3-btn-primary hgu-buy" onClick={open} disabled={busy || !wallet} data-testid="crate-open">{busy ? "Opening…" : "Open crate"}</button>
              {note && <p className="hg-sub" role="status" style={{ marginTop: 10 }}>{note}</p>}
            </div>
          </div>
        </div>
      )}
      {opened && (
        <div className="hgu-reveal" style={{ ["--sw" as string]: SW[opened.item?.rar ?? opened.crate.tier] }} data-testid="crate-reveal">
          <span className="hgu-reveal-crate">
            <Img src={crateArt(opened.crate.tier, true)} h={150} />
            {burst > 0 && <span key={burst} className="hgu-burst" aria-hidden style={{ backgroundImage: `url(${withBase(crateBurstArt(opened.crate.tier))})` }} />}
          </span>
          <div>
            <span className="hg-look-r" style={{ color: SW[opened.item?.rar ?? opened.crate.tier] }}>{opened.dupe ? "Already yours · turned into XP" : `You found · ${RL[opened.item?.rar ?? opened.crate.tier]}`}</span>
            <b>{opened.item ? title(opened.item) : "XP"}</b>
            <span>+{fmt(opened.xp)} XP{opened.item && !opened.dupe ? ". Equip it in Your rocket." : ""}</span>
          </div>
          {opened.item && itemArt(opened.item, 150)}
        </div>
      )}
    </section>
  );
}
const RARITY_RANK = (r: Rarity) => ["common", "uncommon", "rare", "epic", "legendary", "mythic"].indexOf(r);

/* ----------------------------------------------------------------- Shop ----------------------------------------------------------------- */

function untilLabel(ts: number) {
  const m = Math.max(0, Math.round((ts - Date.now()) / 60_000)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d ? `${d} day${d > 1 ? "s" : ""} left` : h ? `${h}h ${m % 60}m` : `${m % 60}m`;
}

export function Shop({ col, shop, wallet }: { col: Col | null; shop: ShopStock | null; wallet: string | null }) {
  const owned = new Set(col?.owned ?? []);
  const spend = col?.spendableXp ?? 0;
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 60_000); return () => clearInterval(t); }, []);
  if (!shop) return null;

  const buy = async (id: string) => {
    if (!wallet || busy) return;
    if (confirm !== id) { setConfirm(id); return; }
    setBusy(id); setNote("");
    const r = await collectionAction(wallet, { op: "buy", item: id });
    setBusy(null); setConfirm(null);
    setNote(r.ok ? (id === SHOP_CRATE_ID ? "Crate added. Open it under Crates." : "It's yours. Equip it in Your rocket.") : r.reason || "Couldn't buy that. Try again.");
  };
  const btn = (id: string, price: number, big = false) => {
    if (id !== SHOP_CRATE_ID && owned.has(id)) return <span className="hgu-owned">Owned</span>;
    const short = spend < price;
    return <button type="button" className={`dsc3-btn dsc3-btn-primary hgu-buy${big ? "" : " sm"}`} disabled={!wallet || short || busy === id} onClick={() => buy(id)} data-testid={`buy-${id}`}>
      {busy === id ? "Buying…" : confirm === id ? `Buy for ${fmt(price)}?` : `${fmt(price)} XP`}</button>;
  };
  const f = shop.featured, live = liveSeries(Date.now());
  const fp = f ? PRICE[f.rar]! : 0;

  return (
    <section className="hg-sec hgu-sec" aria-labelledby="hg-shop" data-testid="rocket-shop">
      <header className="hg-sech">
        <div><h2 id="hg-shop" className="dsc3-h2">Shop</h2><span>A few skins a day, the same for every pilot. When they leave, there&apos;s no telling when they come back.</span></div>
        <span className="hgu-timer">New stock in {untilLabel(shop.endsAt)}</span>
      </header>
      {live && (
        <div className="hgu-banner" style={{ backgroundImage: `url(${withBase(seriesArt(live.n))})` }} data-testid="series-banner">
          <span className="hg-look-r">Series {live.n} · dropping now</span>
          <b>{live.name}</b>
          <span>{live.hulls.map((h) => HULL_NAMES[h]).join(" and ")} hulls, {live.paints.length} paints each</span>
        </div>
      )}
      {f && (
        <div className="hgu-feat" style={{ ["--sw" as string]: SW[f.rar] }}>
          <div className="hgu-feat-tx">
            <span className="hg-look-r" style={{ color: SW[f.rar] }}>Featured · {RL[f.rar]} · {untilLabel(shop.featuredEndsAt)}</span>
            <b>{title(f)}</b>
            <span>Otherwise only in {f.rar === "legendary" ? "Epic" : "Rare"} crates and up.</span>
            {btn(f.id, fp, true)}
            {!owned.has(f.id) && spend < fp && <span className="hgu-short">{fmt(fp - spend)} more XP to buy</span>}
          </div>
          <span className="hgu-feat-art">{itemArt(f, 230)}</span>
        </div>
      )}
      <ul className="hg-looks hgu-stock">
        {shop.daily.map((it) => (
          <Card key={it.id} wide={it.kind === "tag"} rar={it.rar} name={it.name} label={`${RL[it.rar]} · ${kindLabel(it)}`} a={itemArt(it, 98, false, col?.wallet ? "YOU" : "PILOT")}
            sub={<>{btn(it.id, PRICE[it.rar]!)}<span className="hgu-when">Leaves in {untilLabel(shop.endsAt)}</span></>} />
        ))}
        <Card rar="common" name="Common crate" label="Crate" a={<Img src={crateArt("common")} h={70} />}
          sub={<>{btn(SHOP_CRATE_ID, CRATE_PRICE)}<span className="hgu-when">Rare and up are earned only</span></>} />
      </ul>
      {note && <p className="hg-sub" role="status">{note}</p>}
      <p className="hg-sub hgu-note">Paid with XP to spend ({fmt(spend)} now), which never lowers your level. Mythic skins are never sold.</p>
    </section>
  );
}
