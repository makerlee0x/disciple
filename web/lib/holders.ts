/**
 * Holders of a rocket from its ERC-20 Transfer logs (pure; unit-tested by scripts/test-holders.mts).
 * Balances are a running sum of Transfer deltas from the coin's first Transfer (mint), so they equal balanceOf for a
 * plain ERC-20 (the rocket token has no rebasing / fee-on-transfer).
 */
export type HolderLabel = "pool" | "curve" | "locker" | null;
/**
 * GAME contract (SITE job 7): what a holder row IS, for the HOLDERS list. "pool" = v4 PoolManager + the DISCIPLE hook
 * (and the rest of the v4/router plumbing and the bonding curve/Launchpad, which hold tradeable liquidity); "locker" =
 * LockedLP + Migration (and the other protocol escrows: TrampWallManager, FeeRouter, RewardsVault, AnonLaunchers);
 * "burn" = 0x…dEaD (LockedLP.BURN) and 0x0; "holder" = everyone else (a player wallet).
 */
export type HolderKind = "pool" | "locker" | "burn" | "holder";
export type Holder = { address: string; balance: string; pct: number; usd: number | null; label: HolderLabel; kind: HolderKind };
export type TransferDelta = { from: string; to: string; value: bigint };
const ZERO = "0x0000000000000000000000000000000000000000";
/** Burn sink — mirror of contracts/src/LockedLP.sol `BURN` (LP / coins sent here are gone for good). */
export const BURN_ADDRESS = "0x000000000000000000000000000000000000dead";
/** Addresses whose balance is burned: LockedLP.BURN + the zero address. */
export const BURN_ADDRESSES = [BURN_ADDRESS, ZERO] as const;

/** Apply Transfer logs (in chain order) to a balance map (lowercase address → raw balance string). Mints/burns skip 0x0. */
export function applyTransfers(bal: Record<string, string>, xs: TransferDelta[]): Record<string, string> {
  const add = (a: string, d: bigint) => {
    const k = a.toLowerCase();
    if (k === ZERO) return;
    const n = BigInt(bal[k] ?? "0") + d;
    if (n === BigInt(0)) delete bal[k]; else bal[k] = n.toString();
  };
  for (const x of xs) { if (x.value === BigInt(0)) continue; add(x.from, -x.value); add(x.to, x.value); }
  return bal;
}

/**
 * Top `limit` holders by balance (desc; ties by address). pct = balance / totalSupply × 100. usd = share of the current
 * market cap (balance / totalSupply × mcapUsd), null when the mcap is unknown. labels: lowercase address → label.
 */
export function rankHolders(bal: Record<string, string>, o: { totalSupply: bigint; mcapUsd: number | null; labels: Record<string, Exclude<HolderLabel, null>>; limit: number; kinds?: Record<string, Exclude<HolderKind, "holder">> }): Holder[] {
  const sup = o.totalSupply > BigInt(0) ? o.totalSupply : BigInt(1);
  return Object.entries(bal)
    .map(([a, b]) => [a, BigInt(b)] as const)
    .filter(([, b]) => b > BigInt(0))
    .sort((x, y) => (x[1] === y[1] ? (x[0] < y[0] ? -1 : 1) : x[1] > y[1] ? -1 : 1))
    .slice(0, o.limit)
    .map(([address, b]) => {
      const share = Number((b * BigInt(1_000_000_000)) / sup) / 1e9; // 1e-9 resolution, no float overflow
      return { address, balance: b.toString(), pct: share * 100, usd: o.mcapUsd == null ? null : share * o.mcapUsd, label: o.labels[address] ?? null, kind: kindOf(address, o.kinds) };
    });
}

/** Protocol contracts that can hold a coin, from the active chain's address book (lib/chains deployment()). */
export type ProtocolBook = Partial<Record<"poolManager" | "hook" | "router" | "universalRouter" | "permit2" | "migration" | "lockedLP"
  | "trampWallManager" | "feeRouter" | "launchpad", string>>;
/**
 * THE holder label map (server /api/holders and the client HoldersBridge): v4 pool plumbing → "pool"; contracts that
 * escrow coins for the protocol (LockedLP, TrampWallManager, FeeRouter fee escrow, RewardsVault, AnonLaunchers) →
 * "locker"; the Launchpad + this coin's curve → "curve". Zero / malformed addresses are skipped. `lockers` = extra
 * escrow addresses read at runtime (e.g. FeeRouter.rewardsVault(), the AnonLaunchers).
 */
export function protocolLabels(d: ProtocolBook, o: { curve?: string; lockers?: (string | undefined)[] } = {}): Record<string, Exclude<HolderLabel, null>> {
  const out: Record<string, Exclude<HolderLabel, null>> = {};
  const lab = (a: string | undefined, l: Exclude<HolderLabel, null>) => { if (a && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() !== ZERO) out[a.toLowerCase()] = l; };
  for (const a of [d.poolManager, d.hook, d.router, d.universalRouter, d.permit2, d.migration]) lab(a, "pool");
  for (const a of [d.lockedLP, d.trampWallManager, d.feeRouter, ...(o.lockers ?? [])]) lab(a, "locker");
  lab(d.launchpad, "curve"); lab(o.curve, "curve");
  return out;
}

/**
 * THE holder kind map (GAME contract; /api/holders `kind`), from the same address book as protocolLabels. Differs from
 * the label only where GAME asked: Migration is a "locker" (label stays "pool"), and burn sinks get "burn". Addresses
 * not in the map are "holder" (kindOf). Zero/malformed book entries are skipped; 0x0 and 0x…dEaD are always "burn".
 */
export function holderKinds(d: ProtocolBook, o: { curve?: string; lockers?: (string | undefined)[] } = {}): Record<string, Exclude<HolderKind, "holder">> {
  const out: Record<string, Exclude<HolderKind, "holder">> = {};
  const set = (a: string | undefined, k: Exclude<HolderKind, "holder">) => { if (a && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() !== ZERO) out[a.toLowerCase()] = k; };
  for (const a of [d.poolManager, d.hook, d.router, d.universalRouter, d.permit2, d.launchpad, o.curve]) set(a, "pool");
  for (const a of [d.lockedLP, d.migration, d.trampWallManager, d.feeRouter, ...(o.lockers ?? [])]) set(a, "locker");
  for (const a of BURN_ADDRESSES) out[a] = "burn";
  return out;
}
/** Kind of one address: the map's entry, "burn" for the burn sinks, else "holder". */
export const kindOf = (address: string, kinds?: Record<string, Exclude<HolderKind, "holder">>): HolderKind => {
  const a = address.toLowerCase();
  return kinds?.[a] ?? ((BURN_ADDRESSES as readonly string[]).includes(a) ? "burn" : "holder");
};

export const clampHoldersLimit = (v: string | null) => Math.min(100, Math.max(1, Math.floor(Number(v)) || 50));
export const isAddr = (a: string | null): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);
