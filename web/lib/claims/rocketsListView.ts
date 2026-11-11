/** Your rockets list view: instant correct empty when there is truly no wallet,
 *  a loading skeleton while the wallet is resolving or a signed-in fetch is in flight,
 *  and "No rockets yet" only after that fetch returns empty (never a flash for a creator who has rockets). */
export type RocketsListView = "signin" | "loading" | "empty" | "list";
export type WalletPhase = "unknown" | "none" | "in";

export function rocketsListView(phase: WalletPhase, rows: unknown[] | null, demo: boolean): RocketsListView {
  if (demo) return rows == null ? "loading" : rows.length ? "list" : "empty";
  if (phase === "unknown") return "loading";
  if (phase === "none") return "signin";
  if (rows == null) return "loading";
  return rows.length ? "list" : "empty";
}

/** Wallet may still appear (Privy not ready, restore in flight, or Privy is signed in but the account is still linking). */
export function walletPending(me: { toString?: () => string } | string | null, privyIsReady: boolean, privyIsIn: boolean, restored: boolean): boolean {
  if (me) return false;
  if (!restored) return true;
  if (!privyIsReady) return true;
  if (privyIsIn) return true;
  return false;
}
