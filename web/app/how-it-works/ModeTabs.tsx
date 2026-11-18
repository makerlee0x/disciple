"use client";
/**
 * The game-mode tabs on How to play (Launch · Duel · Climb, maker 2026-11-18). Every panel is server-rendered; this only
 * picks which one shows. The hash opens a tab (#duel, #climb); #pro opens the Pro spec sheet (no tab for it).
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { HIW_TABS } from "@/content/how-it-works";
import s from "./page.module.css";

type Game = { id: string; tab: string; tag: string; art: string; tone: string; body: ReactNode };

export default function ModeTabs({ h1, games, pro }: { h1: string; games: Game[]; pro: { h1: string; body: ReactNode } }) {
  const [tab, setTab] = useState(games[0].id);
  useEffect(() => {
    const read = () => {
      const h = location.hash.replace("#", "");
      setTab(h === "pro" || games.some((g) => g.id === h) ? h : games[0].id);
    };
    read();
    addEventListener("hashchange", read);
    return () => removeEventListener("hashchange", read);
  }, [games]);
  const pick = (id: string) => {
    setTab(id);
    history.replaceState(null, "", id === games[0].id ? location.pathname + location.search : `#${id}`);
  };
  const isPro = tab === "pro";
  return (
    <>
      <header className={s.head}>
        <h1 className={s.h1}>{isPro ? pro.h1 : h1}</h1>
        {!isPro && (
          <div className={s.tabs} role="tablist" aria-label={HIW_TABS.label}>
            {games.map((g) => (
              <button key={g.id} type="button" role="tab" id={`hiw-tab-${g.id}`} aria-controls={`hiw-panel-${g.id}`} aria-selected={tab === g.id}
                className={`${s.tab}${tab === g.id ? ` ${s.on}` : ""}`} style={{ "--tc": g.tone, backgroundImage: `url(${g.art})` } as CSSProperties}
                onClick={() => pick(g.id)} data-testid={`hiw-tab-${g.id}`}>
                <span className={s.tabTag}>{g.tag}</span>
                <b>{g.tab}</b>
              </button>
            ))}
          </div>
        )}
      </header>
      {games.map((g) => (
        <section key={g.id} role="tabpanel" id={`hiw-panel-${g.id}`} aria-labelledby={`hiw-tab-${g.id}`} hidden={tab !== g.id} className={s.panel}>{g.body}</section>
      ))}
      <div id="hiw-panel-pro" hidden={!isPro}>{pro.body}</div>
    </>
  );
}
