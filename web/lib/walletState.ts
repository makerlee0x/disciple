/**
 * The signed-in wallet address and its change events, without viem (mobile plan 2026-11-13, speed fix 1).
 * lib/wallet.ts owns connecting and signing and publishes here; light UI (the lobby level chip, top bars) subscribes here,
 * so the wallet stack stays out of every page's first-load JS. lib/wallet re-exports onWallet / connectedAddress.
 */
type Addr = `0x${string}`;
let current: Addr | null = null;
const subs = new Set<(a: Addr | null) => void>();
/** lib/wallet.ts only. */
export function _emitWallet(a: Addr | null) { current = a; subs.forEach((f) => f(a)); }
export function connectedAddress() { return current; }
export function onWallet(f: (a: Addr | null) => void) { subs.add(f); f(current); return () => { subs.delete(f); }; }
