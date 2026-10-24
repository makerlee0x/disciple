"use client";

import { useEffect, useMemo, useState } from "react";
import { PROFILE_CHANGED_EVENT, localUsername } from "@/lib/profile";
import { fetchProfileMeta } from "@/lib/profileMetaClient";
import { identityRuleText } from "@/lib/identity";
import { onWallet } from "@/lib/wallet";
import { PROFILE_COPY as C } from "@/lib/copy/profile";
import { TITLE_IDS, earnedTitlesFor, profileStatsSeed, shownTitle, titleDef, titleTooltip } from "@/lib/titles";
import Tooltip from "@/components/ui/Tooltip";

/** /achievements#titles: every title, earned first; the one on your profile is marked. Signed-in only. */
export default function TitlesSection() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState("");
  useEffect(() => onWallet((a) => setWallet(a ? a.toLowerCase() : null)), []);
  useEffect(() => {
    if (!wallet) return;
    let alive = true;
    const read = () => {
      const u = localUsername();
      setName(u);
      if (!u) fetch(`/api/profile/username?address=${wallet}`).then((r) => r.json()).then((j: { username?: string | null }) => { if (alive && j.username) setName(j.username); }).catch(() => {});
      fetchProfileMeta(wallet).then((m) => { if (alive) setChosen(m.title || ""); });
    };
    read();
    window.addEventListener(PROFILE_CHANGED_EVENT, read);
    return () => { alive = false; window.removeEventListener(PROFILE_CHANGED_EVENT, read); };
  }, [wallet]);
  const earned = useMemo(() => (wallet ? earnedTitlesFor(profileStatsSeed(name, wallet)) : []), [wallet, name]);
  if (!wallet) return null;
  const shown = shownTitle(chosen, earned);
  const locked = TITLE_IDS.filter((id) => !earned.includes(id));
  const chip = (id: (typeof TITLE_IDS)[number], isLocked: boolean) => {
    const d = titleDef(id)!;
    return (
      <li key={id}>
        <Tooltip content={<><strong>{d.label}{id === shown ? ` · ${C["ach.titles.shown"]}` : ""}</strong>{isLocked ? identityRuleText(id) : titleTooltip(id)}</>}>
          <span className={`ach-title ${isLocked ? "locked" : ""} ${id === shown ? "shown" : ""}`} aria-label={id === shown ? `${d.label}, ${C["ach.titles.shown"]}` : d.label}>{d.label}</span>
        </Tooltip>
      </li>
    );
  };
  return (
    <section className="ach-titles" id="titles" aria-labelledby="ach-titles-h" data-testid="achievements-titles">
      <h2 id="ach-titles-h">{C["ach.titles"]}</h2>
      <span className="pf-eyebrow">{C["ach.titles.earned"]} · {earned.length}</span>
      {earned.length ? <ul className="ach-titles-list">{earned.map((id) => chip(id, false))}</ul> : <p className="muted">{C["edit.title.empty"]}</p>}
      <span className="pf-eyebrow">{C["ach.titles.locked"]} · {locked.length}</span>
      <ul className="ach-titles-list">{locked.map((id) => chip(id, true))}</ul>
    </section>
  );
}
