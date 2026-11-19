"use client";
/**
 * Site search in the top bar (maker 2026-11-19): pilots (@username, display name), rockets (name, ticker) and market items,
 * grouped by type. A pilot opens their Hangar (/u/<name>), a rocket its coin page, an item the market (its cheapest copy,
 * or the market search when none is listed).
 *  - Wide desktop: a rounded field after the tabs; results drop down under it. "/" or Cmd/Ctrl+K focuses it.
 *  - Narrower screens and phones: a magnifier button that opens a full-screen search. On phones it takes the "?" slot,
 *    so the empty search screen carries How to play and Docs.
 * Results come from /api/search (lib/server/search), debounced as the player types.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Icon from "@/components/icons/Icon";
import { withBase } from "@/lib/base-path";
import { isStoreSrc } from "@/lib/coinImages";
import { RARITY_COLOR, RARITY_NAME, type Rarity } from "@/lib/collection";
import { fmtMcap } from "@/lib/chart/candles";
import { usd } from "@/lib/market";
import { TOPBAR_POPOVER_EVENT } from "@/components/account/WelcomeToast";
import {
  EMPTY_RESULT, SEARCH_MIN, SEARCH_NAV_EVENT, isHexAddr, itemHref, normQuery, pilotHref, rocketHref,
  type ItemHit, type PilotHit, type RocketHit, type SearchResult,
} from "@/lib/search";

export const SEARCH_COPY = {
  placeholder: "Search pilots, rockets, items",
  label: "Search",
  close: "Close search",
  clear: "Clear",
  pilots: "Pilots",
  rockets: "Rockets",
  items: "Items",
  none: "No matches",
  howToPlay: "How to play",
  docs: "Docs",
} as const;

const DEBOUNCE_MS = 200;
const cache = new Map<string, SearchResult>();

function useSearch(raw: string): { res: SearchResult; busy: boolean } {
  const q = normQuery(raw);
  const ready = q.length >= SEARCH_MIN || isHexAddr(q);
  const [res, setRes] = useState<SearchResult>(() => cache.get(q) ?? EMPTY_RESULT);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!ready) { setRes(EMPTY_RESULT); setBusy(false); return; }
    const hit = cache.get(q);
    if (hit) { setRes(hit); setBusy(false); return; }
    setBusy(true);
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      fetch(withBase(`/api/search?q=${encodeURIComponent(q)}`), { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((j: SearchResult) => {
          const v: SearchResult = { q, pilots: j.pilots ?? [], rockets: j.rockets ?? [], items: j.items ?? [] };
          if (cache.size > 80) cache.clear();
          cache.set(q, v); setRes(v); setBusy(false);
        })
        .catch((e) => { if ((e as Error).name !== "AbortError") setBusy(false); });
    }, DEBOUNCE_MS);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [q, ready]);
  return { res: ready ? res : EMPTY_RESULT, busy: ready && busy };
}

type Row = { key: string; href: string; node: ReactNode };

function Avatar({ src, nft, text }: { src: string | null; nft?: boolean; text: string }) {
  return (
    <span className={`ss-av${nft ? " ss-av-nft" : ""}`} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src ? <img src={withBase(src)} alt="" loading="lazy" decoding="async" /> : <b>{text.slice(0, 1).toUpperCase()}</b>}
    </span>
  );
}

const pilotRow = (p: PilotHit): Row => ({
  key: `p:${p.username}`, href: pilotHref(p),
  node: <>
    <Avatar src={p.pfp} nft={p.nft} text={p.name || p.username} />
    <span className="ss-tx"><b>{p.name || `@${p.username}`}</b>{p.name ? <small>@{p.username}</small> : null}</span>
  </>,
});
const rocketRow = (r: RocketHit): Row => ({
  key: `r:${r.token}`, href: rocketHref(r),
  node: <>
    <span className="ss-av ss-av-coin" aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {isStoreSrc(r.icon) ? <img src={r.icon} alt="" loading="lazy" decoding="async" /> : <b>{r.ticker.slice(0, 1).toUpperCase()}</b>}
    </span>
    <span className="ss-tx"><b>{r.name}</b><small>${r.ticker}</small></span>
    <span className="ss-end"><b>{fmtMcap(r.mcapUsd)}</b>{r.graduated ? <small className="ss-orbit">In orbit</small> : null}</span>
  </>,
});
const itemRow = (i: ItemHit): Row => ({
  key: `i:${i.id}`, href: itemHref(i),
  node: <>
    <span className="ss-av ss-av-item" style={{ ["--rc" as string]: RARITY_COLOR[i.rar as Rarity] ?? "#A7AFBE" }} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {i.art ? <img src={withBase(i.art)} alt="" loading="lazy" decoding="async" /> : null}
    </span>
    <span className="ss-tx"><b>{i.title}</b><small style={{ color: RARITY_COLOR[i.rar as Rarity] }}>{RARITY_NAME[i.rar as Rarity] ?? i.rar}</small></span>
    {i.floor != null ? <span className="ss-end"><b>{usd(i.floor)}</b>{i.listed > 1 ? <small>{i.listed} listed</small> : null}</span> : null}
  </>,
});

function Results({ res, raw, busy, onPick, active, setActive, listId, extra }: {
  res: SearchResult; raw: string; busy: boolean; onPick: () => void; active: number; setActive: (n: number) => void; listId: string; extra?: ReactNode;
}) {
  const C = SEARCH_COPY;
  const groups = useMemo(() => [
    { k: "pilots", label: C.pilots, rows: res.pilots.map(pilotRow) },
    { k: "rockets", label: C.rockets, rows: res.rockets.map(rocketRow) },
    { k: "items", label: C.items, rows: res.items.map(itemRow) },
  ].filter((g) => g.rows.length), [res, C]);
  const q = normQuery(raw);
  const typed = q.length >= SEARCH_MIN || isHexAddr(q);
  if (!typed) return extra ? <div className="ss-body">{extra}</div> : null;
  if (!groups.length) return <div className="ss-body"><div className="ss-empty">{busy ? <span className="ss-spin" aria-label="Searching" /> : C.none}</div></div>;
  let n = -1;
  return (
    <div className="ss-body" id={listId} role="listbox" aria-label={C.label}>
      {groups.map((g) => (
        <section key={g.k} className="ss-group" aria-label={g.label}>
          <h3>{g.label}</h3>
          {g.rows.map((r) => {
            const i = ++n;
            return (
              <Link key={r.key} href={r.href} id={`${listId}-${i}`} role="option" aria-selected={active === i} className={`ss-row${active === i ? " on" : ""}`}
                onMouseEnter={() => setActive(i)} onClick={onPick} data-testid="search-hit">
                {r.node}
              </Link>
            );
          })}
        </section>
      ))}
    </div>
  );
}

const flat = (res: SearchResult) => [...res.pilots.map(pilotHref), ...res.rockets.map(rocketHref), ...res.items.map(itemHref)];

export default function SiteSearch() {
  const C = SEARCH_COPY;
  const router = useRouter();
  const pathname = usePathname();
  const listId = useId().replace(/:/g, "");
  const [raw, setRaw] = useState("");
  const [drop, setDrop] = useState(false);   // desktop dropdown open
  const [sheet, setSheet] = useState(false); // full-screen search open
  const [active, setActive] = useState(-1);
  const { res, busy } = useSearch(raw);
  const field = useRef<HTMLInputElement>(null);
  const sheetField = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const hrefs = useMemo(() => flat(res), [res]);
  useEffect(() => { setActive(-1); }, [res]);

  const close = useCallback(() => { setDrop(false); setSheet(false); setActive(-1); field.current?.blur(); }, []);
  const done = useCallback(() => { close(); setRaw(""); window.setTimeout(() => dispatchEvent(new Event(SEARCH_NAV_EVENT)), 0); }, [close]);
  useEffect(() => { close(); }, [pathname, close]);

  // "/" and Cmd/Ctrl+K: focus the field (or open the sheet where the field is hidden)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      const k = (e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey);
      if (!k && (e.key !== "/" || typing)) return;
      e.preventDefault();
      const f = field.current;
      if (f && f.offsetParent !== null) { f.focus(); f.select(); setDrop(true); } else setSheet(true);
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);

  // dropdown: a click outside closes it; other top bar popovers close it too
  useEffect(() => {
    if (!drop) return;
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setDrop(false); };
    const other = () => setDrop(false);
    addEventListener("pointerdown", away); addEventListener(TOPBAR_POPOVER_EVENT, other);
    return () => { removeEventListener("pointerdown", away); removeEventListener(TOPBAR_POPOVER_EVENT, other); };
  }, [drop]);

  // sheet: focus its field, lock the page behind it
  useEffect(() => {
    if (!sheet) return;
    dispatchEvent(new Event(TOPBAR_POPOVER_EVENT));
    const t = window.setTimeout(() => sheetField.current?.focus(), 30);
    document.documentElement.classList.add("ss-lock");
    return () => { window.clearTimeout(t); document.documentElement.classList.remove("ss-lock"); };
  }, [sheet]);

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { e.preventDefault(); if (raw) setRaw(""); else close(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!hrefs.length) return;
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      const m = hrefs.length + 1; // -1 (the field) .. last row, wrapping
      setActive((a) => ((a + 1 + d + m) % m) - 1);
      return;
    }
    if (e.key === "Enter") {
      const h = hrefs[active >= 0 ? active : 0];
      if (h) { e.preventDefault(); router.push(h); done(); }
    }
  };

  const input = (ref: typeof field, onFocus?: () => void) => (
    <span className="ss-in">
      <Icon name="search" size={20} className="ss-mag" />
      <input ref={ref} type="search" value={raw} placeholder={C.placeholder} aria-label={C.label} autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
        enterKeyHint="search" role="combobox" aria-expanded={!!hrefs.length} aria-controls={listId} aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        onChange={(e) => { setRaw(e.target.value); setDrop(true); }} onFocus={onFocus} onKeyDown={onKey} data-testid="search-input" />
      {busy ? <span className="ss-spin" aria-hidden /> : raw ? (
        <button type="button" className="ss-clear" aria-label={C.clear} onClick={() => { setRaw(""); ref.current?.focus(); }}><Icon name="close" size={18} /></button>
      ) : null}
    </span>
  );

  const typed = normQuery(raw).length >= SEARCH_MIN || isHexAddr(normQuery(raw));
  const help = (
    <nav className="ss-links" aria-label="Help">
      <Link href="/how-it-works" className="ss-link" onClick={done}><Icon name="play" size={18} />{C.howToPlay}<Icon name="chevron-right" size={16} className="ss-go" /></Link>
      <Link href="/docs" className="ss-link" onClick={done}><Icon name="grid" size={18} />{C.docs}<Icon name="chevron-right" size={16} className="ss-go" /></Link>
    </nav>
  );

  return (
    <div ref={root} className="ss" data-testid="site-search">
      <div className={`ss-field${drop && typed ? " open" : ""}`}>
        {input(field, () => { dispatchEvent(new Event(TOPBAR_POPOVER_EVENT)); setDrop(true); })}
        {drop && typed && (
          <div className="ss-drop">
            <Results res={res} raw={raw} busy={busy} onPick={done} active={active} setActive={setActive} listId={listId} />
          </div>
        )}
      </div>
      <button type="button" className="ss-icon" aria-label={C.label} onClick={() => setSheet(true)} data-testid="search-open">
        <Icon name="search" size={22} />
      </button>
      {sheet && createPortal(
        <div className="ss-sheet" role="dialog" aria-modal="true" aria-label={C.label} data-testid="search-sheet">
          <div className="ss-sheet-top">
            <button type="button" className="ss-back" aria-label={C.close} onClick={close}><Icon name="chevron-left" size={24} /></button>
            {input(sheetField)}
          </div>
          <Results res={res} raw={raw} busy={busy} onPick={done} active={active} setActive={setActive} listId={`${listId}s`} extra={help} />
        </div>,
        document.body,
      )}
    </div>
  );
}
