/**
 * The signed-in wallet address and its change events, without viem (mobile plan 2026-11-13, speed fix 1).
 * lib/wallet.ts owns connecting and signing and publishes here; light UI (the lobby level chip, top bars) subscribes here,
 * so the wallet stack stays out of every page's first-load JS. lib/wallet re-exports onWallet / connectedAddress.
 */
type Addr = `0x${string}`;
let current: Addr | null = null;
const subs = new Set<(a: Addr | null) => void>();
/** lib/wallet.ts only. */
export function _emitWallet(a: Addr | null) {
  current = a;
  if (a) { try { localStorage.setItem(LAST_LS, a); } catch { /* private mode */ } }
  subs.forEach((f) => f(a));
}
const LAST_LS = "disciple.lastWallet";
/** The last signed-in wallet in this browser (a public address, never a key): lets /profile paint at once while the
 *  saved session restores, then the real wallet confirms or replaces it. */
export function lastWallet(): Addr | null {
  try { const v = localStorage.getItem(LAST_LS); return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Addr) : null; } catch { return null; }
}
/** The last signed-in pill in this browser (public facts only: address, @name, cash). On a refresh the top bar paints it
 *  at once while Privy reconnects (several seconds: SDK chunk, Privy session check, wallet iframe), then the real wallet
 *  confirms or replaces it. */
export type LastPill = { address: Addr; name: string | null; cashUsd: number | null;
  /** what the pill looked like: picture (NFT = hex frame), level and progress. The root layout's YOU_JS paints these into the
   *  top bar placeholder before any script loads (keep the field names in step with it). */
  img?: string | null; nft?: boolean; level?: number; progress?: number; cash?: string; label?: string };
const PILL_LS = "disciple.lastPill";
export function lastPill(): LastPill | null {
  const a = lastWallet();
  if (!a) return null;
  try {
    const v = JSON.parse(localStorage.getItem(PILL_LS) || "null") as Partial<LastPill> | null;
    const same = !!v && typeof v.address === "string" && v.address.toLowerCase() === a.toLowerCase();
    if (!same) return { address: a, name: null, cashUsd: null };
    return { ...v, address: a, name: typeof v!.name === "string" ? v!.name : null, cashUsd: typeof v!.cashUsd === "number" ? v!.cashUsd : null };
  } catch { return { address: a, name: null, cashUsd: null }; }
}
export function saveLastPill(p: LastPill) { try { localStorage.setItem(PILL_LS, JSON.stringify(p)); } catch { /* private mode */ } }
export function connectedAddress() { return current; }
export function onWallet(f: (a: Addr | null) => void) { subs.add(f); f(current); return () => { subs.delete(f); }; }
// dev only (screenshots): window.__walletDev("0x…") shows the signed-in screens with no Privy, like window.__turboDev
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") (window as unknown as { __walletDev?: typeof _emitWallet }).__walletDev = _emitWallet;
