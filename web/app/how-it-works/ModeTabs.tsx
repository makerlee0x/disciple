"use client";
/** The Pilot / Pro switch on How to play. Both panels are server-rendered; this only picks which one shows. #pro opens Pro. */
import { useEffect, useState, type ReactNode } from "react";
import { HIW_TABS } from "@/content/how-it-works";
import s from "./page.module.css";

type Panel = { eyebrow: string; h1: string; sub: string; body: ReactNode };

export default function ModeTabs({ pilot, pro }: { pilot: Panel; pro: Panel }) {
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
        <div className={s.tog} role="tablist" aria-label={HIW_TABS.label}>
          {(["pilot", "pro"] as const).map((t) => (
            <button key={t} type="button" role="tab" id={`hiw-tab-${t}`} aria-controls={`hiw-panel-${t}`} aria-selected={tab === t}
              className={tab === t ? s.on : ""} onClick={() => pick(t)} data-testid={`hiw-tab-${t}`}>{HIW_TABS[t]}</button>
          ))}
        </div>
      </header>
      <div role="tabpanel" id="hiw-panel-pilot" aria-labelledby="hiw-tab-pilot" hidden={tab !== "pilot"}>{pilot.body}</div>
      <div role="tabpanel" id="hiw-panel-pro" aria-labelledby="hiw-tab-pro" hidden={tab !== "pro"}>{pro.body}</div>
    </>
  );
}
