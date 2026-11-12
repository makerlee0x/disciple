"use client";
/**
 * Rewards data for the private profile (profile r3): the header's chest / Claim now and the Rewards popup read the same
 * load. Live reads only (lib/claims/rewardsData.loadRewards); ?demo=1 sample data on `next dev` only (lib/claims/demo).
 * Moved as-is from the old on-page Rewards section (components/claims/ProfileClaims).
 */
import { useCallback, useEffect, useState } from "react";
import { gateState, type GateState } from "@/lib/claims/referralGate";
import { hasClaimable, loadRewards, type RewardsData } from "@/lib/claims/rewardsData";
import { demoGate, demoRewards } from "@/lib/claims/demo";
import { myStealthCoins, myStealthKeys } from "@/lib/privateLaunch";
import { fetchUsernameStatus, localUsername } from "@/lib/profile";
import { pc, useCaps, useWalletAddr } from "./ui";

export function useRewards(enabled = true) {
  const me = useWalletAddr();
  const { caps, ready, demo } = useCaps();
  const [data, setData] = useState<RewardsData | null>(null);
  const [gate, setGate] = useState<GateState | null>(null);
  const [username, setUsername] = useState("");

  const load = useCallback(async () => {
    if (!enabled) return;
    if (demo) { setData(demoRewards(Math.floor(Date.now() / 1000))); if (caps.referralGate) setGate(demoGate(Math.floor(Date.now() / 1000))); return; }
    if (!me || !ready) return;
    const c = pc();
    if (caps.referralGate) void gateState(c, me).then(setGate).catch(() => setGate(null));
    // private launches announced to this account's stealth keys (same silent signature the creator dashboard uses)
    const stealth = caps.anonClaims ? await myStealthKeys().then((k) => myStealthCoins(c, k)).catch(() => []) : [];
    try { setData(await loadRewards(c, me, caps, stealth)); }
    catch (e) { console.warn("[disciple] rewards: load failed", (e as Error)?.message ?? e); setData(null); }
  }, [enabled, me, ready, demo, caps]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    setUsername(localUsername());
    let alive = true;
    void fetchUsernameStatus(me).then((s) => { if (alive && s.username && !localUsername()) setUsername(s.username); }).catch(() => {});
    return () => { alive = false; };
  }, [me]);

  const canClaim = !!data && hasClaimable(data.claim);
  return { me, caps, ready, demo, data, gate, username, canClaim, reload: load };
}
export type Rewards = ReturnType<typeof useRewards>;
