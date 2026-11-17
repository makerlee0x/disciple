"use client";
/**
 * Hangar collection (maker's pick 2026-11-16: series + crates; the daily XP shop was cut the same day; static screens in
 * /mnt/project-files/hangar/unlocks): "Your rocket" (skins found per hull, trail, what you fly), "Crates" (open with
 * odds shown). Rules in lib/collection.ts, server in lib/server/collection.ts.
 */
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import Icon from "@/components/icons/Icon";
import { withBase } from "@/lib/base-path";
import { playSfx } from "@/lib/game/sfx";
import {
  CRATE, DUPE_XP, FLOURISHES, HULL_NAMES, ITEMS, PAINTS, PRESTIGE_HULL, RARITY_COLOR as SW, RARITY_NAME as RL, SERIES, STARTER_TAG,
  TRADE_UP_N, burnGrade, releasedSeries, copyLook, crateArt, crateBurstArt, crateOdds, glintArt, itemById, itemTitle, liveSeries, pctLabel, seriesArt, skinArt, skinId,
  tagArt, tradeUpTarget, trailArt, trailId, itemOut, nextDrop, rewardFor, rewardLabel,
  type Collection as Col, type CollectionAction, type Copy, type Crate, type Item, type Opened, type Rarity, type Slot,
} from "@/lib/collection";
import { collectionAction } from "@/lib/collectionClient";
import { MILESTONE_COPY } from "@/lib/xp";

const fmt = (n: number) => n.toLocaleString("en-US");
/** "Level 10 reward" / "Final Push trophy reward" for items you earn by playing, else null */
const earnHow = (id: string) => { const r = rewardFor(id); return r ? rewardLabel(r.rule, r.rule.kind === "trophy" ? MILESTONE_COPY[r.rule.trophy]?.name : undefined) : null; };
// eslint-disable-next-line @next/next/no-img-element
const Img = ({ src, h, dim }: { src: string; h: number; dim?: boolean }) => <img src={withBase(src)} alt="" loading="lazy" style={{ height: h, width: "auto", maxWidth: "100%", objectFit: "contain", filter: dim ? "brightness(0) opacity(.55)" : undefined }} />;

/** A trail's plume sheet, flickering (6 frames, black drops out with screen blending). */
function Plume({ id, h }: { id: string; h: number }) {
  const t = id.replace(/^trail-/, "");
  return <span className="hgu-plume" aria-hidden style={{ height: h, width: h / 3, backgroundImage: `url(${withBase(trailArt(t))})` }} />;
}
/** Marble & Gold Leaf skins get the gold glint sweeping up them (4 frames, then a pause). */
const GLINT_W: Record<string, number> = { bullet: 145, needle: 128, pulp: 179, wedge: 234, "ring-tail": 139, hauler: 139, shuttle: 184, "twin-booster": 139 };
/** A skin, drawn as one copy looks: its pattern seed shifts the hue of pattern paints, its burn lays soot over the paint. */
function SkinArt({ i, h, dim, copy }: { i: Item; h: number; dim?: boolean; copy?: Copy }) {
  const base = i.paint === "marble-gilt" && !dim && GLINT_W[i.hull!]
    ? <span className="hgu-glint" aria-hidden style={{ height: h, width: (h * GLINT_W[i.hull!]) / 320, ["--ga" as string]: GLINT_W[i.hull!] / 320, backgroundImage: `url(${withBase(glintArt(i.hull!))})` }} />
    : <Img src={skinArt(i.id)} h={h} dim={dim} />;
  if (!copy || dim) return base;
  const L = copyLook(copy), m = `url(${withBase(skinArt(i.id))})`;
  return (
    <span className="hgu-copy-look" style={{ filter: L.hue ? `hue-rotate(${L.hue}deg) saturate(${L.sheen})` : undefined }}>
      {base}
      {L.soot > 0.01 && <span className="hgu-soot" aria-hidden style={{ opacity: L.soot, WebkitMaskImage: m, maskImage: m }} />}
    </span>
  );
}
/** A name-tag plate with the name in its empty middle (prestige plates carry an emblem on the left). */
function Tag({ id, name, w }: { id: string; name: string; w: number }) {
  return <span className={`hgu-plate${id.includes("prestige") ? " pr" : ""}`} style={{ width: w, height: (w * 140) / 600, backgroundImage: `url(${withBase(tagArt(id))})`, fontSize: Math.max(11, w / 13) }}><b>{name}</b></span>;
}
const itemArt = (i: Item, h: number, dim?: boolean, handle = "YOU", copy?: Copy) => (i.kind === "skin" ? <SkinArt i={i} h={h} dim={dim} copy={copy} /> : i.kind === "trail" ? <Plume id={i.id} h={h} />
  : i.kind === "flourish" ? <Burst src={FLOURISHES.find((f) => f.id === i.id)?.art ?? ""} /> : <Tag id={i.id} name={handle} w={Math.min(230, h * 2.2)} />);
const title = (i: Item) => (i.kind === "skin" ? <>{HULL_NAMES[i.hull!]} <em>|</em> {i.name}</> : <>{i.name}</>);
const kindLabel = (i: Item) => (i.kind === "skin" ? HULL_NAMES[i.hull!] : i.kind === "trail" ? "trail" : i.kind === "tag" ? "name tag" : "flourish");

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

const isStarter = (c: Copy) => c.origin === "starter";
/** your copies of an item, best (least burnt) first */
const copiesOf = (col: Col | null, id: string) => (col?.copies ?? []).filter((c) => c.item === id).sort((a, b) => a.burn - b.burn);
/** Spare copies: everything but your best copy of each item, never what you fly or a starter. Trade-ups only use these. */
function spares(col: Col | null): Copy[] {
  const worn = new Set(Object.values(col?.equippedCopy ?? {}));
  const by = new Map<string, Copy[]>();
  for (const c of col?.copies ?? []) if (!isStarter(c)) by.set(c.item, [...(by.get(c.item) ?? []), c]);
  return [...by.values()].flatMap((l) => l.sort((a, b) => a.burn - b.burn).slice(1)).filter((c) => !worn.has(c.uid));
}

/** One item's copies: serial, burn, pattern, FlightTrak, first edition, whether it trades; equip one or scrap one. */
function CopyList({ col, item, onEquip, onScrap, busy }: { col: Col | null; item: Item; onEquip: (v: string) => void; onScrap: (uid: string) => void; busy: boolean }) {
  const [sure, setSure] = useState<string | null>(null);
  const list = copiesOf(col, item.id), worn = new Set(Object.values(col?.equippedCopy ?? {})), sup = col?.supply?.[item.id] ?? 0;
  const owned = new Set(col?.owned ?? []);
  return (
    <div className="dsc3-panel hg-panel hgu-copies" style={{ ["--sw" as string]: SW[item.rar] }} data-testid="copy-list">
      <header className="hg-panelh"><div><h2>{title(item)}</h2><span>{list.length ? `You have ${list.length} ${list.length === 1 ? "copy" : "copies"}${sup ? ` · ${fmt(sup)} made` : ""}. Every copy is rolled on its own.` : item.prestige || item.hull === PRESTIGE_HULL ? "Prestige items aren't copies. They come with your Prestige and never trade." : "You don't have one yet."}</span></div></header>
      {!list.length && owned.has(item.id) && <button type="button" className="dsc3-btn dsc3-btn-primary hgu-buy sm" disabled={busy} onClick={() => onEquip(item.id)}>Equip</button>}
      {!!list.length && (
        <ul className="hgu-copy-rows">
          {list.map((c) => {
            const g = burnGrade(c.burn), on = worn.has(c.uid);
            return (
              <li key={c.uid} className={on ? "on" : ""}>
                <span className="hgu-copy-art">{itemArt(item, 56, false, "YOU", c)}</span>
                <span className="hgu-copy-tx">
                  <b>{c.serial ? <>#{fmt(c.serial)}{sup ? <em> of {fmt(sup)}</em> : null}</> : "Starter"} · {g.name}</b>
                  <span>Burn {c.burn.toFixed(4)} · Pattern {c.seed}{c.trak != null ? ` · FlightTrak ${c.trak}` : ""}</span>
                  <span className="hgu-copy-tags">{c.fe && <i className="fe">First edition</i>}{c.trak != null && <i className="trak">FlightTrak</i>}<i>{c.bound ? "Never trades" : "Tradable"}</i></span>
                </span>
                <span className="hgu-copy-act">
                  {on ? <span className="hgu-owned">Flying</span> : <button type="button" className="dsc3-btn dsc3-btn-primary hgu-buy sm" disabled={busy} onClick={() => onEquip(c.uid)} data-testid={`equip-${c.uid}`}>Equip</button>}
                  {!on && !isStarter(c) && <button type="button" className="dsc3-btn hgu-scrap" disabled={busy} onClick={() => { if (sure !== c.uid) { setSure(c.uid); return; } setSure(null); onScrap(c.uid); }}>{sure === c.uid ? `Scrap for ${DUPE_XP[item.rar]} XP?` : "Scrap"}</button>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function YourRocket({ col, wallet, handle }: { col: Col | null; wallet: string | null; handle: string }) {
  const now = Date.now();
  const owned = useMemo(() => new Set(col?.owned ?? []), [col]);
  const eq = col?.equipped ?? { skin: skinId("bullet", "white-gloss"), trail: trailId("gold"), tag: STARTER_TAG, flourish: "" };
  const eqc = col?.equippedCopy ?? {};
  const eqItem = itemById(eq.skin)!;
  const copyById = (uid?: string) => (uid ? col?.copies?.find((c) => c.uid === uid) : undefined);
  const live = liveSeries(now) ?? SERIES[0];
  const released = releasedSeries(now);
  const hullTabs = [...new Set(released.flatMap((s) => s.hulls))];
  const [hull, setHull] = useState<string>(eqItem.hull ?? hullTabs[0]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState(false);
  const [insp, setInsp] = useState<string | null>(null);
  // open on the hull you fly, once the collection has loaded
  useEffect(() => { if (col && !picked) { setPicked(true); if (eqItem.hull) setHull(eqItem.hull); } }, [col, picked, eqItem.hull]);
  const prestige = col?.prestige ?? 0;
  const paintsFound = new Set([...owned].filter((id) => id.includes("--") && !id.startsWith(PRESTIGE_HULL)).map((id) => id.split("--")[1]));

  const skins: Item[] = hull === PRESTIGE_HULL
    ? Object.keys(PAINTS).map((p) => itemById(skinId(PRESTIGE_HULL, p))!).filter(Boolean)
    : ITEMS.filter((i) => i.kind === "skin" && i.hull === hull && itemOut(i, now));
  const has = (i: Item) => (i.hull === PRESTIGE_HULL ? prestige >= 1 && paintsFound.has(i.paint!) : owned.has(i.id));
  const liveSkins = ITEMS.filter((i) => i.kind === "skin" && i.series === live.n && itemOut(i, now));
  const next = nextDrop(now);
  const found = liveSkins.filter((i) => owned.has(i.id)).length;
  const daysLeft = live.end ? Math.max(0, Math.ceil((live.end - now) / 86_400_000)) : null;

  const act = async (a: CollectionAction, ok: string) => {
    if (!wallet || busy) return;
    setBusy(true); setNote("");
    const r = await collectionAction(wallet, a);
    setBusy(false);
    if (!r.ok) setNote(r.reason || "Couldn't save that. Try again.");
    else { if (a.op === "equip") playSfx("skin_equip", { gapMs: 300 }); if (ok) setNote(ok); }
  };
  // equip one slot (a copy uid or an item id), keeping the rest of the look as it is
  const wear = (slot: Slot, v: string) => {
    const cur = { skin: eqc.skin ?? eq.skin, trail: eqc.trail ?? eq.trail, tag: eqc.tag ?? eq.tag, flourish: eqc.flourish ?? (eq.flourish || "none") };
    void act({ op: "equip", ...cur, [slot]: v }, "");
  };
  const scrap = (uid: string) => { const c = copyById(uid), it = c && itemById(c.item); void act({ op: "scrap", copy: uid }, it ? `Scrapped for ${DUPE_XP[it.rar]} XP.` : ""); };
  const inspect = (id: string) => setInsp((v) => (v === id ? null : id));
  const sub = (i: Item, on: boolean) => { const n = copiesOf(col, i.id).length; return on ? `Flying${n > 1 ? ` · ×${n}` : ""}` : n > 1 ? `×${n} copies` : "Tap to see it"; };
  const panel = (list: Item[]) => { const it = list.find((i) => i.id === insp); return it ? <CopyList col={col} item={it} busy={busy} onEquip={(v) => wear(it.kind as Slot, v)} onScrap={scrap} /> : null; };
  // trails from the series that are out (later ones stay a surprise), the prestige trail; tags: the 6 plates, the prestige plates you have and the next one
  const trails = ITEMS.filter((i) => i.kind === "trail" && (!!i.prestige || itemOut(i, now)));
  const tags = ITEMS.filter((i) => i.kind === "tag" && (!i.prestige || i.prestige <= prestige + 1));
  const flourishes = ITEMS.filter((i) => i.kind === "flourish" && itemOut(i, now));
  const count = (h: string) => { const all = ITEMS.filter((i) => i.kind === "skin" && i.hull === h && itemOut(i, now)); return `${all.filter((i) => owned.has(i.id)).length}/${all.length}`; };
  const best = (i: Item) => (i.id === eq.skin || i.id === eq.trail ? copyById(i.kind === "skin" ? eqc.skin : eqc.trail) : undefined) ?? copiesOf(col, i.id)[0];

  // trade-ups: spare copies grouped by series and rarity
  const groups = useMemo(() => {
    const m = new Map<string, { series: number; rar: Rarity; list: Copy[] }>();
    for (const c of spares(col)) { const it = itemById(c.item); if (!it || !tradeUpTarget(it.rar)) continue; const k = `${it.series}:${it.rar}`; const g = m.get(k) ?? { series: it.series, rar: it.rar, list: [] }; g.list.push(c); m.set(k, g); }
    return [...m.values()].sort((a, b) => a.series - b.series || RARITY_RANK(a.rar) - RARITY_RANK(b.rar));
  }, [col]);
  const tradeUpGo = async (g: { series: number; rar: Rarity; list: Copy[] }) => {
    if (!wallet || busy) return;
    const ten = [...g.list].sort((a, b) => b.burn - a.burn).slice(0, TRADE_UP_N).map((c) => c.uid);
    setBusy(true); setNote("");
    const r = await collectionAction(wallet, { op: "tradeup", copies: ten });
    setBusy(false);
    const it = r.item;
    setNote(r.ok && it ? `Traded up into ${itemTitle(it)} (${RL[it.rar]}).` : r.reason || "Couldn't trade up. Try again.");
    if (r.ok) playSfx("crate_open", { gapMs: 200 });
  };

  return (
    <section className="hg-sec hgu-sec" aria-labelledby="hg-looks" data-testid="rocket-collection">
      <header className="hg-sech"><div><h2 id="hg-looks" className="dsc3-h2">Your rocket</h2><span>Every skin is made for one hull. Every copy you find is rolled on its own: a serial, a burn and a pattern.</span></div></header>
      <div className="hgu-equip" style={{ ["--sw" as string]: SW[eqItem.rar] }}>
        <span className="hgu-equip-art"><SkinArt i={eqItem} h={210} copy={copyById(eqc.skin)} /><Plume id={eq.trail} h={120} /></span>
        <div className="hgu-equip-tx">
          <span className="hg-look-r" style={{ color: SW[eqItem.rar] }}>{RL[eqItem.rar]}{eqItem.series ? ` · Series ${eqItem.series}` : " · Prestige"}</span>
          <b>{title(eqItem)}</b>
          {(() => { const c = copyById(eqc.skin); return c ? <span>{c.serial ? `#${fmt(c.serial)}` : "Starter"} · {burnGrade(c.burn).name}{c.trak != null ? ` · FlightTrak ${c.trak}` : ""}{c.fe ? " · First edition" : ""}</span> : null; })()}
          <span>{itemById(eq.trail)?.name ?? "Gold"} trail{eq.flourish ? ` · ${itemById(eq.flourish)?.name} flourish` : ""} · flies in Trading Duels</span>
          <Tag id={eq.tag} name={handle} w={220} />
          <p>Your name tag floats over your rocket in every race.</p>
        </div>
      </div>
      <div className="hgu-series">
        <div><span className="hg-look-r" style={{ color: "var(--dsc3-light-champagne)" }}>Series {live.n} · {live.name}</span><b>{found} of {liveSkins.length} found</b></div>
        <span className="hgu-meter"><i style={{ width: `${Math.round((found / Math.max(1, liveSkins.length)) * 100)}%` }} /></span>
        <span className="hgu-leaves">{next && next.series === live.n ? `${next.name} drops in ${untilDays(next.start - now)}, with new paints and trails` : daysLeft != null ? `Series ${live.n} crates stop dropping in ${daysLeft} days` : `Series ${live.n} is dropping now`}</span>
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
          return <Card key={s.id} rar={s.rar} on={on || insp === s.id} locked={!own} name={own ? s.name : "???"} label={RL[s.rar]} testid={`skin-${s.id}`}
            sub={own ? sub(s, on) : hull === PRESTIGE_HULL ? (prestige < 1 ? "Prestige 1" : "Find this paint first") : earnHow(s.id) ?? "Not found yet"}
            a={<SkinArt i={s} h={98} dim={!own} copy={own ? best(s) : undefined} />} onClick={own ? () => inspect(s.id) : undefined} />;
        })}
      </ul>
      {panel(skins)}
      <div className="hg-looks-row">
        <div className="hg-looks-h"><h3>Trail</h3><span>Gold core, so you stay easy to spot</span></div>
        <ul className="hg-looks">
          {trails.map((t) => {
            const own = owned.has(t.id), on = t.id === eq.trail;
            return <Card key={t.id} rar={t.rar} on={on || insp === t.id} locked={!own} name={t.name} label={t.prestige ? `Prestige ${t.prestige}` : RL[t.rar]} a={<Plume id={t.id} h={98} />} testid={t.id}
              sub={own ? sub(t, on) : t.prestige ? `Reach Prestige ${t.prestige}` : earnHow(t.id) ?? `Series ${t.series} crates`} onClick={own ? () => inspect(t.id) : undefined} />;
          })}
        </ul>
        {panel(trails)}
      </div>
      <div className="hg-looks-row">
        <div className="hg-looks-h"><h3>Name tag</h3><span>Prestige plates come with each Prestige</span></div>
        <ul className="hg-looks">
          {tags.map((t) => {
            const own = owned.has(t.id), on = t.id === eq.tag;
            return <Card key={t.id} wide rar={t.rar} on={on || insp === t.id} locked={!own} name={t.name} label={t.prestige ? `Prestige ${t.prestige}` : RL[t.rar]} a={<Tag id={t.id} name={own ? handle : "???"} w={150} />} testid={t.id}
              sub={own ? sub(t, on) : t.prestige ? `Reach Prestige ${t.prestige}` : `${RL[t.rar]} crates and up`} onClick={own ? () => inspect(t.id) : undefined} />;
          })}
        </ul>
        {panel(tags)}
      </div>
      <div className="hg-looks-row">
        <div className="hg-looks-h"><h3>Win flourish</h3><span>Plays over your rocket when you win a duel</span></div>
        <ul className="hg-looks">
          {flourishes.map((f) => {
            const own = owned.has(f.id), on = f.id === eq.flourish;
            return <Card key={f.id} rar={f.rar} on={on || insp === f.id} locked={!own} name={own ? f.name : "???"} label={RL[f.rar]} a={<Burst src={FLOURISHES.find((x) => x.id === f.id)!.art} />} testid={f.id}
              sub={own ? sub(f, on) : `Series ${f.series} crates`} onClick={own ? () => inspect(f.id) : undefined} />;
          })}
          {!!eq.flourish && <Card rar="common" name="None" label="Flourish" a={<span className="hgu-none" />} sub="Tap to take it off" onClick={() => wear("flourish", "none")} />}
        </ul>
        {panel(flourishes)}
      </div>
      <div className="dsc3-panel hg-panel hgu-tradeup" data-testid="trade-up">
        <header className="hg-panelh"><h2>Trade up</h2></header>
        <TradeUpGraphic />
        {groups.length ? (
          <ul className="hgu-tu-rows">
            {groups.map((g) => (
              <li key={`${g.series}:${g.rar}`} style={{ ["--sw" as string]: SW[g.rar] }}>
                <span className="hg-look-r" style={{ color: SW[g.rar] }}>{g.series ? `Series ${g.series}` : "Any series"} · {RL[g.rar]}</span>
                <span className="hgu-meter"><i style={{ width: `${Math.min(100, (g.list.length / TRADE_UP_N) * 100)}%`, background: SW[g.rar] }} /></span>
                <b>{Math.min(g.list.length, TRADE_UP_N)}/{TRADE_UP_N}</b>
                <button type="button" className="dsc3-btn dsc3-btn-primary hgu-buy sm" disabled={busy || g.list.length < TRADE_UP_N} onClick={() => tradeUpGo(g)}>Trade up to {RL[tradeUpTarget(g.rar)!]}</button>
              </li>
            ))}
          </ul>
        ) : <p className="hg-sub">No spare copies yet. Spares are the extra copies you find of things you already have.</p>}
      </div>
    </section>
  );
}

/** an 8-frame burst sheet, shown as a still of its brightest frame */
function Burst({ src }: { src: string }) { return <span className="hgu-burst-still" aria-hidden style={{ backgroundImage: `url(${withBase(src)})` }} />; }

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
  const live = liveSeries(Date.now()) ?? SERIES[0], nd = nextDrop(Date.now());
  const [proof, setProof] = useState<string | null>(null);
  useEffect(() => { fetch(withBase("/api/collection?proof=1"), { cache: "no-store" }).then((r) => r.json()).then((j: { proof?: { today?: { hash?: string } } }) => setProof(j?.proof?.today?.hash ?? null)).catch(() => {}); }, []);

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
      <header className="hg-sech"><div><h2 id="hg-crates" className="dsc3-h2">Crates</h2><span>Win a ranked duel and a crate drops. Finishing your weekly missions drops one too.</span></div></header>
      {live && (
        <div className="hgu-banner" style={{ backgroundImage: `url(${withBase(seriesArt(live.n))})` }} data-testid="series-banner">
          <span className="hg-look-r">Series {live.n} · dropping now</span>
          <b>{live.name}</b>
          <span>{live.hulls.map((h) => HULL_NAMES[h]).join(" and ")} hulls, {ITEMS.filter((i) => i.kind === "skin" && i.series === live.n && i.hull === live.hulls[0] && itemOut(i, Date.now())).length} paints each</span>
          {nd && nd.series === live.n && <span className="hg-look-r" data-testid="next-drop">{nd.name} drops in {untilDays(nd.start - Date.now())}</span>}
        </div>
      )}
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
        <div className="hg-empty"><b>No crates yet</b><p>Win a ranked duel or finish your weekly missions to get one.</p></div>
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
              <p>Odds are shown on every crate. Crates hold skins, trails and flourishes from the series that&apos;s live now, plus name tags. Copies from your welcome crate never trade.</p>
              {proof && <p className="hgu-proof" data-testid="roll-proof">Every roll is provable. Today&apos;s seed hash is <code>{proof.slice(0, 10)}…{proof.slice(-6)}</code>, and the seed is revealed tomorrow so you can check any crate you open today.</p>}
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
            <span className="hg-look-r" style={{ color: SW[opened.item?.rar ?? opened.crate.tier] }}>{opened.dupe ? `Another copy · ${RL[opened.item?.rar ?? opened.crate.tier]}` : `You found · ${RL[opened.item?.rar ?? opened.crate.tier]}`}</span>
            <b>{opened.item ? title(opened.item) : "XP"}</b>
            {opened.copy && <span className="hgu-reveal-copy">#{fmt(opened.copy.serial)} · {burnGrade(opened.copy.burn).name} {opened.copy.burn.toFixed(4)} · Pattern {opened.copy.seed}</span>}
            {opened.copy && (opened.copy.fe || opened.copy.trak != null || opened.copy.bound) && <span className="hgu-copy-tags">{opened.copy.fe && <i className="fe">First edition</i>}{opened.copy.trak != null && <i className="trak">FlightTrak</i>}{opened.copy.bound && <i>Never trades</i>}</span>}
            <span>+{fmt(opened.xp)} XP{opened.item ? (opened.dupe ? ". Keep it, trade it up, or scrap it for XP." : ". Equip it in Your rocket.") : ""}</span>
          </div>
          {opened.item && itemArt(opened.item, 150, false, "YOU", opened.copy)}
        </div>
      )}
    </section>
  );
}
/** "3 days", "5 hours", "20 minutes" */
function untilDays(ms: number) {
  const m = Math.max(1, Math.round(ms / 60_000)), d = Math.round(m / 1440), h = Math.round(m / 60);
  return m >= 1440 * 1.5 ? `${d} days` : m >= 1440 ? "1 day" : h >= 2 ? `${h} hours` : `${m} minutes`;
}
const RARITY_RANK = (r: Rarity) => ["common", "uncommon", "rare", "epic", "legendary", "mythic"].indexOf(r);


/* ------------------------------------------------------------ Trade up, as a picture ------------------------------------------------------------ */

const LADDER: Rarity[] = ["common", "uncommon", "rare", "epic", "legendary"];
/** a real skin of this rarity from the live series, for the picture (falls back to any series) */
const sampleSkin = (r: Rarity) => {
  const live = liveSeries(Date.now())?.n;
  const skins = ITEMS.filter((i) => i.kind === "skin" && i.rar === r && i.hull !== PRESTIGE_HULL);
  return skins.find((i) => i.series === live) ?? skins[0];
};

/** 10 spares → 1 of the next rarity, burn averaged; the rarity ladder; Mythic only from crates. */
function TradeUpGraphic() {
  const [from, setFrom] = useState<Rarity>("common");
  const to = tradeUpTarget(from) ?? "uncommon";
  const a = sampleSkin(from), b = sampleSkin(to);
  return (
    <div className="hgu-tug" data-testid="trade-up-graphic">
      <div className="hgu-tug-eq">
        <div className="hgu-tug-in" style={{ ["--sw" as string]: SW[from] }}>
          <span className="hgu-tug-stack" aria-hidden>
            {Array.from({ length: TRADE_UP_N }, (_, k) => <i key={k} style={{ ["--k" as string]: k }}>{a ? <SkinArt i={a} h={54} /> : <Img src={crateArt(from)} h={40} />}</i>)}
          </span>
          <b>{TRADE_UP_N} ×</b>
          <span className="hg-look-r" style={{ color: SW[from] }}>{RL[from]} spares</span>
        </div>
        <div className="hgu-tug-arrow" aria-hidden>
          <span>Burn averaged</span>
          <svg viewBox="0 0 120 24"><path d="M2 12h104" /><path d="M98 3l12 9-12 9" /></svg>
          <span>Same series</span>
        </div>
        <div className="hgu-tug-out" style={{ ["--sw" as string]: SW[to] }}>
          <span className="hgu-tug-one">{b ? <SkinArt i={b} h={120} /> : <Img src={crateArt(to)} h={90} />}</span>
          <b>1 ×</b>
          <span className="hg-look-r" style={{ color: SW[to] }}>{RL[to]}</span>
        </div>
      </div>
      <ol className="hgu-tug-ladder" aria-label="Rarity ladder">
        {LADDER.map((r, k) => (
          <li key={r} style={{ ["--sw" as string]: SW[r] }}>
            <button type="button" className={r === from || r === to ? "on" : ""} disabled={k === LADDER.length - 1} onClick={() => setFrom(r)}>
              <i /><span>{RL[r]}</span>
            </button>
          </li>
        ))}
        <li className="hgu-tug-mythic" style={{ ["--sw" as string]: SW.mythic }}>
          <Img src={crateArt("mythic")} h={34} />
          <span><b>{RL.mythic}</b> crates only</span>
        </li>
      </ol>
      <ul className="hgu-tug-rules">
        <li><Icon name="copy" size={16} />Only your spare copies</li>
        <li><Icon name="rocket" size={16} />Never what you fly</li>
        <li><Icon name="star" size={16} />Never your best copy</li>
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------ Your rocket, profile card ------------------------------------------------------------ */

/** The profile's compact Your rocket card: what you fly, its trail and tag, and a way into skins and crates (/rocket). */
export function RocketCard({ col, handle }: { col: Col | null; handle: string }) {
  const eq = col?.equipped ?? { skin: skinId("bullet", "white-gloss"), trail: trailId("gold"), tag: STARTER_TAG, flourish: "" };
  const eqItem = itemById(eq.skin)!;
  const copy = col?.copies?.find((c) => c.uid === col?.equippedCopy?.skin);
  const crates = col?.crates?.length ?? 0;
  return (
    <section className="dsc3-panel hg-panel hgu-card" style={{ ["--sw" as string]: SW[eqItem.rar] }} aria-labelledby="hg-looks" data-testid="rocket-card">
      <header className="hg-panelh"><h2 id="hg-looks">Your rocket</h2><Link href="/rocket">Skins &amp; crates</Link></header>
      <div className="hgu-card-body">
        <span className="hgu-card-art"><SkinArt i={eqItem} h={170} copy={copy} /><Plume id={eq.trail} h={90} /></span>
        <div className="hgu-card-tx">
          <span className="hg-look-r" style={{ color: SW[eqItem.rar] }}>{RL[eqItem.rar]}{eqItem.series ? ` · Series ${eqItem.series}` : " · Prestige"}</span>
          <b>{title(eqItem)}</b>
          <span>{itemById(eq.trail)?.name ?? "Gold"} trail{copy ? ` · ${copy.serial ? `#${fmt(copy.serial)}` : "Starter"}` : ""}</span>
          <Tag id={eq.tag} name={handle} w={180} />
          <Link className="dsc3-btn dsc3-btn-primary hgu-buy sm" href={crates ? "/rocket#crates" : "/rocket"} data-testid="rocket-card-open">{crates ? `Open ${crates} ${crates === 1 ? "crate" : "crates"}` : "Change your look"}</Link>
        </div>
      </div>
    </section>
  );
}
