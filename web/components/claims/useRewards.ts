"use client";
/**
 * Rewards data for the private profile (profile r3): the header's chest / Claim now and the Rewards popup read the same
 * load. Live reads only (lib/claims/rewardsData.loadRewards); ?demo=1 sample data on `next dev` only (lib/claims/demo).
 * Moved as-is from the old on-page Rewards section (since removed).
 */
import { useCallback, useEffect, useState } from "react";
import { gateState, type GateState } from "@/lib/claims/referralGate";
import { hasClaimable, loadRewards, type RewardsData } from "@/lib/claims/rewardsData";
import { demoGate, demoRewards } from "@/lib/claims/demo";
import { myHiddenCoins } from "@/lib/privateLaunch";
import { fetchUsernameStatus, localUsername } from "@/lib/profile";
import { pc, useCaps, useWalletAddr } from "./ui";

// One load per wallet, shared by every useRewards (account menu warms it, the Hangar popup reads it at once).
// A remount shows the last result straight away and refreshes behind it; calls in flight are shared, not repeated.
const cache = new Map<string, RewardsData>();
const inflight = new Map<string, Promise<RewardsData | null>>();

export function useRewards(enabled = true) {
  const me = useWalletAddr();
  const { caps, ready, demo } = useCaps();
  const [data, setData] = useState<RewardsData | null>(() => (me ? cache.get(me.toLowerCase()) ?? null : null));
  const [gate, setGate] = useState<GateState | null>(null);
  const [username, setUsername] = useState("");

  const load = useCallback(async () => {
    if (!enabled) return;
    if (demo) { setData(demoRewards(Math.floor(Date.now() / 1000))); if (caps.referralGate) setGate(demoGate(Math.floor(Date.now() / 1000))); return; }
    if (!me || !ready) return;
    const key = me.toLowerCase();
    const hit = cache.get(key); if (hit) setData(hit);
    const c = pc();
    if (caps.referralGate) void gateState(c, me).then(setGate).catch(() => setGate(null));
    let p = inflight.get(key);
    if (!p) {
      p = (async () => {
        // private launches announced to this account's stealth keys (same silent signature the creator dashboard uses)
        const stealth = caps.anonClaims ? await myHiddenCoins(c) : [];
        try { const d = await loadRewards(c, me, caps, stealth); cache.set(key, d); return d; }
        catch (e) { console.warn("[disciple] rewards: load failed", (e as Error)?.message ?? e); return cache.get(key) ?? null; }
      })().finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    setData(await p);
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
