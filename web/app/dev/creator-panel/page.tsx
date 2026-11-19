"use client";
/** Dev screenshots (next dev only): /dev/creator-panel?view=strip|home|history|coin|payto|transfer. The real Hangar banner,
 *  balance strip and Rewards panel (components/claims/RewardsPanel) on the SAMPLE rewards data (lib/claims/demo). */
import { useEffect, useState } from "react";
import type { Address } from "viem";
import HangarBay from "@/components/hangar/HangarBay";
import Icon from "@/components/icons/Icon";
import IdentitySigil from "@/components/profile/IdentitySigil";
import { NO_IDENTITY } from "@/lib/identity";
import { ServiceRecord } from "@/components/hangar/HangarSections";
import RewardsPanel from "@/components/claims/RewardsPanel";
import type { Rewards } from "@/components/claims/useRewards";
import { DEMO_CAPS, demoRewards } from "@/lib/claims/demo";

const ME = "0x9f2c0000000000000000000000000000000041de" as Address;
const COIN = "0xcac8A9654dE3aE01470fC9E93e58fb97d5B86bb3";

export default function DevCreatorPanel() {
  const [view, setView] = useState<string | null>(null);
  useEffect(() => { setView(new URLSearchParams(location.search).get("view") || "home"); }, []);
  if (!view) return null;
  const data = demoRewards(Math.floor(Date.now() / 1000));
  const r: Rewards = { me: ME, caps: DEMO_CAPS(true), ready: true, demo: true, data, gate: null, username: "maker", canClaim: true, reload: async () => {} };
  const start = view === "coin" || view === "payto" || view === "transfer" ? { v: view, token: COIN } as const : view === "history" ? { v: "history" } as const : { v: "home" } as const;
  return (
    <div className="profile-page hg">
      <HangarBay handle="@maker" bio={<p className="hg-bio">Flying since block one.</p>} avatar={<IdentitySigil id={NO_IDENTITY.primary.id} size={34} tip={false} />}
        xp={null} spend={false} stats={[{ k: "Points · #12", v: "48,210" }, { k: "Rockets launched", v: "3" }]}
        actions={<><button type="button" className="hg-ghost"><Icon name="share" size={16} /> Invite</button><button type="button" className="hg-ghost">Edit profile</button><button type="button" className="hg-ghost">Settings</button></>} />
      <ServiceRecord pf={{ ok: true, cashUsd: 5789.35, rows: [] }} isPrivate rewards={{ usd: data.summary.claimableUsd, onOpen: () => setView("home") }} />
      {view !== "strip" && <RewardsPanel open onClose={() => setView("strip")} r={r} start={start} />}
    </div>
  );
}
