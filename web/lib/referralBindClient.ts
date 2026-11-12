/**
 * Client side of the account referral bind (lib/server/referralBind). Started once from <RefCapture/> in its own chunk.
 * Listens to the events the app already sends when a player is signed in (lib/wallet onWallet + canTransact, the same
 * "signin" moment FunnelBeacon uses, and lib/aa/session onPrivy for the Privy session). If the browser holds a
 * first-touch referrer with a wallet (lib/referral currentRef), it POSTs it once to /api/referral/bind.
 * Never throws, never blocks: no change to how players sign in or trade.
 */
import { IS_STATIC_PREVIEW, withBase } from "@/lib/base-path";
import { currentRef } from "@/lib/referral";
import { canTransact, onWallet } from "@/lib/wallet";
import { onPrivy, privyAccessToken, privyAuthenticated } from "@/lib/aa/session";

/** Per wallet + referrer: done once the server has answered (saved, already saved, or refused). */
export const BIND_DONE = (wallet: string, ref: string) => `disciple.refbind:${wallet.toLowerCase()}:${ref.toLowerCase()}`;

type Deps = {
  ref: () => { u: string | null; a: string | null; t: number } | null;
  token: () => Promise<string | null>;
  post: (body: string, token: string) => Promise<{ ok: boolean; status: number }>;
  storage: Pick<Storage, "getItem" | "setItem">;
};

const defaultDeps = (): Deps => ({
  ref: currentRef,
  token: privyAccessToken,
  post: async (body, token) => {
    const r = await fetch(withBase("/api/referral/bind"), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body, keepalive: true });
    return { ok: r.ok, status: r.status };
  },
  storage: localStorage,
});

const inflight = new Set<string>();
/** One attempt for this wallet. Exported for tests. */
export async function tryBind(wallet: string | null | undefined, d: Deps = defaultDeps()): Promise<"sent" | "skip"> {
  try {
    if (!wallet) return "skip";
    const w = wallet.toLowerCase();
    const touch = d.ref();
    const a = touch?.a?.toLowerCase();
    if (!touch || !a || a === w) return "skip"; // no wallet in the touch, or self-referral
    const key = BIND_DONE(w, a);
    if (d.storage.getItem(key) || inflight.has(key)) return "skip";
    inflight.add(key);
    try {
      const token = await d.token();
      if (!token) return "skip"; // Privy session not ready yet: onPrivy retries
      const r = await d.post(JSON.stringify({ wallet: w, ref: touch }), token);
      // 2xx (saved / already saved / refused) and 4xx other than auth/rate limit are final for this pair
      if (r.ok || (r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 429)) d.storage.setItem(key, String(Date.now()));
      return "sent";
    } finally { inflight.delete(key); }
  } catch { return "skip"; }
}

export function startRefBind(): () => void {
  if (typeof window === "undefined" || IS_STATIC_PREVIEW) return () => {};
  let wallet: string | null = null;
  const go = () => { if (wallet && canTransact() && privyAuthenticated()) void tryBind(wallet); };
  const offW = onWallet((a) => { wallet = a ?? null; go(); });
  const offP = onPrivy(go);
  return () => { offW(); offP(); };
}
