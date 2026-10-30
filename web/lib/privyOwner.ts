/**
 * One wallet per user (lee, Oct 30): the smart-account OWNER is the user's ORIGINAL Privy embedded Ethereum wallet:
 * HD index 0 first (the first wallet Privy derived for this user), then the earliest linked. Never "whichever embedded
 * wallet the SDK listed first", which can be a newer one and so a fresh, empty smart account.
 * Pure: takes Privy's user.linkedAccounts (shape-typed loosely so tests need no SDK).
 */
export type LinkedLike = {
  type?: string; address?: string; chainType?: string; walletClientType?: string; imported?: boolean;
  walletIndex?: number | null; firstVerifiedAt?: Date | string | null;
};

const isEmbeddedEth = (a: LinkedLike) =>
  a.type === "wallet" && !!a.address && (a.chainType ?? "ethereum") === "ethereum" && (a.walletClientType === "privy" || a.walletClientType === "privy-v2");

const ts = (d: LinkedLike["firstVerifiedAt"]) => { const t = d ? new Date(d).getTime() : NaN; return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER; };

/** All embedded Ethereum wallets, original first (walletIndex asc, imported last, then earliest linked). */
export function embeddedWalletsOldestFirst(linked: ReadonlyArray<LinkedLike> | null | undefined): LinkedLike[] {
  return (linked ?? []).filter(isEmbeddedEth).slice().sort((a, b) =>
    (a.walletIndex ?? Number.MAX_SAFE_INTEGER) - (b.walletIndex ?? Number.MAX_SAFE_INTEGER)
    || Number(!!a.imported) - Number(!!b.imported)
    || ts(a.firstVerifiedAt) - ts(b.firstVerifiedAt));
}

/** The owner address (lowercase) to use, or null when the user has no embedded wallet yet. */
export function ownerWalletAddress(linked: ReadonlyArray<LinkedLike> | null | undefined): string | null {
  const w = embeddedWalletsOldestFirst(linked)[0];
  return w?.address ? w.address.toLowerCase() : null;
}

/** True when the user has no embedded Ethereum wallet at all (only then may the site create one). */
export const needsEmbeddedWallet = (linked: ReadonlyArray<LinkedLike> | null | undefined) => embeddedWalletsOldestFirst(linked).length === 0;
