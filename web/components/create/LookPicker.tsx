"use client";
/**
 * Pick the launch rocket on the pad (lib/coinLook): the chip on the stage names what's on the pad and opens a tray over the
 * stage with every skin and trail that's out (yours first); the dice shuffles a rocket. The classic chrome rocket is always there.
 */
import { useState } from "react";
import { withBase } from "@/lib/base-path";
import { HULL_NAMES, RARITY_COLOR, RARITY_NAME, TRAILS, itemById, skinArt, trailArt, type Collection, type Copy, type Item } from "@/lib/collection";

const Dice = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></svg>
);
import { CLASSIC, launchPool, lookAllowed, lookName, shuffleLook, trailName, type CoinLook } from "@/lib/coinLook";
import { ROCKET_SRC } from "@/lib/home/trending";
import s from "./launch.module.css";

export type LookChoice = { skin: string; trail: string };
type Opt = { id: string; item: Item | null; copy: Copy | null; mine: boolean };
export type LookOpts = { skins: Opt[]; trails: Opt[] };

/**
 * What can go on a coin: every skin and trail that's out (lib/coinLook launchPool) plus anything the pilot owns (prestige
 * items too). Owned ones come first, each with its best copy (least burnt), which is what gets credited on the coin.
 * Unreleased items never show.
 */
export function lookOptions(col: Collection | null, now = Date.now()): LookOpts {
  const owned = new Set(col?.owned ?? []);
  const best = (id: string) => (col?.copies ?? []).filter((c) => c.item === id).sort((a, b) => a.burn - b.burn)[0] ?? null;
  const rank = (i: Item | null) => (i ? ["mythic", "legendary", "epic", "rare", "uncommon", "common"].indexOf(i.rar) : 9);
  const pool = launchPool(now);
  const build = (kind: "skin" | "trail", list: Item[]) => {
    const ids = new Set(list.map((i) => i.id));
    for (const id of owned) { const it = itemById(id); if (it?.kind === kind) ids.add(id); }
    return [...ids].map((id) => ({ id, item: itemById(id) ?? null, copy: owned.has(id) ? best(id) : null, mine: owned.has(id) }))
      .filter((o) => o.item && lookAllowed(o.id, kind, owned, now))
      .sort((a, b) => Number(b.mine) - Number(a.mine) || rank(a.item) - rank(b.item) || a.id.localeCompare(b.id));
  };
  return { skins: [{ id: CLASSIC, item: null, copy: null, mine: true }, ...build("skin", pool.skins)], trails: build("trail", pool.trails) };
}

const rarColor = (i: Item | null) => (i ? RARITY_COLOR[i.rar] : "#E8EAEE");

export function LookChip({ look, onOpen, onShuffle, disabled }: { look: CoinLook; onOpen: () => void; onShuffle: () => void; disabled?: boolean }) {
  const it = look.skin === CLASSIC ? null : itemById(look.skin) ?? null;
  return (
    <div className={s.lookChipRow}>
    <button type="button" className={s.lookShuffle} onClick={onShuffle} disabled={disabled} title="Shuffle a rocket" aria-label="Shuffle a rocket" data-testid="look-shuffle"><Dice /></button>
    <button type="button" className={s.lookChip} onClick={onOpen} disabled={disabled} data-testid="look-open" style={{ ["--rc" as string]: rarColor(it) }}>
      <span className={s.lookChipArt} aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={withBase(look.skin === CLASSIC ? ROCKET_SRC : skinArt(look.skin))} alt="" />
      </span>
      <span className={s.lookChipTx}>
        <span>Rocket</span>
        <b data-testid="look-name">{lookName(look)}</b>
        <i>{trailName(look.trail)} trail{look.serial ? ` · #${look.serial}` : ""}</i>
      </span>
      <span className={s.lookChipGo}>Change</span>
    </button>
    </div>
  );
}

export default function LookPicker({ opts, signedIn, value, onPick, onClose, hidden }: {
  opts: LookOpts; signedIn: boolean; value: LookChoice; onPick: (v: LookChoice) => void; onClose: () => void; hidden: boolean;
}) {
  const { skins, trails } = opts;
  const [tab, setTab] = useState<"skin" | "trail">("skin");
  const list = tab === "skin" ? skins : trails;
  const mine = skins.filter((o) => o.mine && o.id !== CLASSIC).length;
  return (
    <div className={s.lookTray} role="dialog" aria-label="Pick your rocket" data-testid="look-picker">
      <header className={s.lookHead}>
        <div className={s.lookTabs} role="tablist">
          <button type="button" role="tab" aria-selected={tab === "skin"} className={tab === "skin" ? s.lookTabOn : ""} onClick={() => setTab("skin")} data-testid="look-tab-skin">Skin <span>{skins.length}</span></button>
          <button type="button" role="tab" aria-selected={tab === "trail"} className={tab === "trail" ? s.lookTabOn : ""} onClick={() => setTab("trail")} data-testid="look-tab-trail">Trail <span>{trails.length}</span></button>
        </div>
        <div className={s.lookHeadR}>
          <button type="button" className={s.lookShuffle} title="Shuffle a rocket" aria-label="Shuffle a rocket" data-testid="look-tray-shuffle"
            onClick={() => onPick(shuffleLook(opts, value))}><Dice /></button>
          <button type="button" className={s.lookDone} onClick={onClose} data-testid="look-done">Done</button>
        </div>
      </header>
      <ul className={s.lookGrid} role="radiogroup" aria-label={tab === "skin" ? "Skin" : "Trail"}>
        {list.map((o) => {
          const on = tab === "skin" ? value.skin === o.id : value.trail === o.id;
          const name = tab === "skin" ? (o.id === CLASSIC ? "Classic chrome" : o.item?.name ?? o.id) : (TRAILS.find((t) => `trail-${t.id}` === o.id)?.name ?? o.id);
          const sub = tab === "skin" ? (o.id === CLASSIC ? "Every rocket" : HULL_NAMES[o.item?.hull ?? ""] ?? "") : (o.item ? RARITY_NAME[o.item.rar] : "");
          return (
            <li key={o.id}>
              <button type="button" role="radio" aria-checked={on} className={`${s.lookTile}${on ? ` ${s.lookTileOn}` : ""}`}
                style={{ ["--rc" as string]: rarColor(o.item) }} data-testid={`look-${tab}-${o.id}`}
                onClick={() => onPick(tab === "skin" ? { ...value, skin: o.id } : { ...value, trail: o.id })}>
                <span className={tab === "skin" ? s.lookArt : `${s.lookArt} ${s.lookPlume}`} aria-hidden>
                  {tab === "skin"
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={withBase(o.id === CLASSIC ? ROCKET_SRC : skinArt(o.id))} alt="" />
                    : <i style={{ backgroundImage: `url(${withBase(trailArt(o.id.replace(/^trail-/, "")))})` }} />}
                </span>
                <b>{name}</b>
                <span>{sub}{o.mine && o.id !== CLASSIC && o.id !== "trail-gold" ? <em className={s.lookMine}>{!hidden && o.copy?.serial ? `#${o.copy.serial}` : "Yours"}</em> : null}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className={s.lookNote} data-testid="look-note">
        {hidden ? "Anon launch: your rocket keeps this look, but none of your serials go on it."
          : !signedIn ? "Any skin that's out can go on your rocket. Sign in to put your own copies on it."
          : mine === 0 ? "Any skin that's out can go on your rocket. Skins you find in crates show first, with your serial."
          : "Yours come first, with your serial on the rocket. Your copy stays in your Hangar."}
      </p>
    </div>
  );
}
