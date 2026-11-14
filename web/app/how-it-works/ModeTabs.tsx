"use client";
/** The Pilot / Pro switch on How to play. Both panels are server-rendered; this only picks which one shows. #pro opens Pro. */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { HIW_FINAL, HIW_TABS } from "@/content/how-it-works";
import { PRO_HUD_ENABLED } from "@/lib/features";
import s from "./page.module.css";

type Panel = { eyebrow: string; h1: string; sub: string; body: ReactNode };

/** Pro HUD hidden for launch (lib/features PRO_HUD_ENABLED, maker 2026-11-14): no Pilot / Pro tabs here or on the Ready up
 *  banner, so How to play is the Pilot lesson. #pro (the lobby's "See the spec sheet" link) still opens the spec sheet. */
/** `final`: the Ready up banner. It repeats the switch (approved 2026-11-13: "add the pilot/pro toggle down at the ready up banner"). */
export default function ModeTabs({ pilot, pro, final, finalStyle }: { pilot: Panel; pro: Panel; final?: ReactNode; finalStyle?: CSSProperties }) {
  const [tab, setTab] = useState<"pilot" | "pro">("pilot");
  useEffect(() => {
    const read = () => setTab(location.hash === "#pro" ? "pro" : "pilot");
    read();
    addEventListener("hashchange", read);
    return () => removeEventListener("hashchange", read);
  }, []);
  const pick = (t: "pilot" | "pro") => {
    setTab(t);
    history.replaceState(null, "", t === "pro" ? "#pro" : location.pathname + location.search);
  };
  const P = tab === "pro" ? pro : pilot;
  return (
    <>
      <header className={s.head}>
        <div className={s.headC}>
          <span className={s.eb}>{P.eyebrow}</span>
          <h1 className={s.h1}>{P.h1}</h1>
          <p className={s.sub}>{P.sub}</p>
        </div>
        {PRO_HUD_ENABLED && <div className={s.tog} role="tablist" aria-label={HIW_TABS.label}>
          {(["pilot", "pro"] as const).map((t) => (
            <button key={t} type="button" role="tab" id={`hiw-tab-${t}`} aria-controls={`hiw-panel-${t}`} aria-selected={tab === t}
              className={tab === t ? s.on : ""} onClick={() => pick(t)} data-testid={`hiw-tab-${t}`}>{HIW_TABS[t]}</button>
          ))}
        </div>}
      </header>
      <div role={PRO_HUD_ENABLED ? "tabpanel" : undefined} id="hiw-panel-pilot" aria-labelledby={PRO_HUD_ENABLED ? "hiw-tab-pilot" : undefined} hidden={tab !== "pilot"}>{pilot.body}</div>
      <div role={PRO_HUD_ENABLED ? "tabpanel" : undefined} id="hiw-panel-pro" aria-labelledby={PRO_HUD_ENABLED ? "hiw-tab-pro" : undefined} hidden={tab !== "pro"}>{pro.body}</div>
      {final && (
        <section className={s.final} style={finalStyle} aria-labelledby="hiw-final">
          <div className={s.finalC}>
            {final}
            {PRO_HUD_ENABLED && <div className={s.finalTog}>
              <span>{HIW_FINAL.tog}</span>
              <div className={s.tog} role="group" aria-label={HIW_TABS.label}>
                {(["pilot", "pro"] as const).map((t) => (
                  <button key={t} type="button" aria-pressed={tab === t} className={tab === t ? s.on : ""} data-testid={`hiw-final-tab-${t}`}
                    onClick={() => { pick(t); scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }}>{HIW_TABS[t]}</button>
                ))}
              </div>
            </div>}
          </div>
        </section>
      )}
    </>
  );
}
