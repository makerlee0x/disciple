"use client";
/** Mockup page (next dev only): /dev/creator-panel?view=strip|home|history|payto|coin|transfer. The Hangar banner without the
 *  Rewards button, the four-tile balance strip with Rewards, and the Rewards panel (components/claims/CreatorPanel) on
 *  sample numbers. For maker's sign-off screenshots; nothing here is live. */
import { useEffect, useState } from "react";
import HangarBay from "@/components/hangar/HangarBay";
import Icon from "@/components/icons/Icon";
import IdentitySigil from "@/components/profile/IdentitySigil";
import { NO_IDENTITY } from "@/lib/identity";
import CreatorPanel, { type PanelData, type PanelView } from "@/components/claims/CreatorPanel";

const D: PanelData = {
  ready: 1284.52, allTime: 9410.37, week: 212.08,
  byKind: { host: 842.1, crew: 96.42, kol: 250, drops: 96 },
  nHost: 3, nCrew: 2, nKol: 2, nDrops: 1,
  payTo: { kind: "me", label: "Your wallet", addr: "0x9f2c…41De" },
  rockets: [
    { token: "a", name: "Shroom Rocket", ticker: "SHROOM", img: "/pairs/coin/shroom.webp", kind: "host", usd: 6120.4, ready: 611.3,
      desc: "The fungi that went to orbit. Community run, burn mode on.", links: { x: "x.com/shroomrocket", tg: "t.me/shroomrkt", web: "" } },
    { token: "b", name: "Zzz Cruise", ticker: "ZZZ", img: "/pairs/coin/zzz.webp", kind: "host", usd: 1410.2, ready: 186.4 },
    { token: "c", name: "Night Shift", ticker: "NITE", img: "/pairs/coin/orbio.webp", kind: "host", usd: 520, ready: 44.4, anon: true },
    { token: "d", name: "Pons Pump", ticker: "PONS", img: "/pairs/coin/pons.webp", kind: "crew", usd: 210.7, ready: 64.2 },
    { token: "e", name: "Delta V", ticker: "DELTA", img: "/pairs/coin/delta.webp", kind: "crew", usd: 80.1, ready: 32.22 },
  ],
  history: [
    { k: "Bonus", note: "Season 1 top 100", day: "Nov 19", usd: 96 },
    { k: "Hosting", day: "Nov 19", usd: 118.4 },
    { k: "Referral", note: "Week 46", day: "Nov 18", usd: 150 },
    { k: "Crew", day: "Nov 18", usd: 21.7 },
    { k: "Hosting", day: "Nov 17", usd: 302.66 },
    { k: "Referral", note: "Week 45", day: "Nov 11", usd: 100 },
  ],
  invite: "disciple.vip/r/maker",
};

export default function DevCreatorPanel() {
  const [view, setView] = useState<PanelView | "strip" | null>(null);
  useEffect(() => { setView((new URLSearchParams(location.search).get("view") as PanelView | "strip") || "home"); }, []);
  if (!view) return null;
  const actions = <>
    <button type="button" className="hg-ghost"><Icon name="share" size={16} /> Invite</button>
    <button type="button" className="hg-ghost">Edit profile</button>
    <button type="button" className="hg-ghost">Settings</button>
  </>;
  return (
    <div className="profile-page hg">
      <HangarBay handle="@maker" bio={<p className="hg-bio">Flying since block one.</p>} avatar={<IdentitySigil id={NO_IDENTITY.primary.id} size={34} tip={false} />}
        xp={null} actions={actions} spend={false} stats={[{ k: "Points · #12", v: "48,210" }, { k: "Rockets launched", v: "3" }]} />
      <section className="hg-record four" aria-label="Service record">
        <div><span className="l">Hangar value</span><b>$6,084.85</b><span className="s down">−$104.49 today</span></div>
        <div className="act"><span className="rw-tx"><span className="l">Cash</span><b>$5,789.35</b></span><a href="#" className="hg-act white">Deposit</a></div>
        <div className="act"><span className="rw-tx"><span className="l">Turbo cash</span><b>$0.01</b></span><a href="#" className="hg-act">Transfer</a></div>
        <div className="act rw"><span className="rw-tx"><span className="l">Rewards</span><b>$1,284.52</b></span><a href="#" className="hg-act gold">Claim</a></div>
      </section>
      {view !== "strip" && <CreatorPanel d={D} view={view} coin="a" />}
    </div>
  );
}
