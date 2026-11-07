/**
 * Live Robinhood Chain (4663) DiscipleHook pool. Same numbers as
 * contracts/deployments/rh-4663-disciple-hook.json and contracts/script/hook/SwapSameChainRH.s.sol.
 * PoolKey.fee is 0. hookFeePips is the hook's own fee (Created.fee), not part of the pool id.
 */
export const DISCIPLE_HOOK = "0xcEdc3C312C5B3C4310F0fba0323DDeC797E4aA88" as const;
export const DISCIPLE_POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as const;
export const DISCIPLE_V4_QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94" as const;
export const DISCIPLE_RPC = "https://rpc.mainnet.chain.robinhood.com";

export const DISCIPLE_POOL = {
  id: "0xddbfa6efd15715013f50e7f1cdceaab3b69b0b8e4c9d4b47fcc28e47f6a80e8f" as const,
  currency0: "0x168661C52E5922288dFb2b3f323b6Cf90eb21e18" as const,
  currency1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const,
  coin: "0x168661C52E5922288dFb2b3f323b6Cf90eb21e18" as const,
  quote: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const,
  fee: 0,
  tickSpacing: 1,
  hooks: DISCIPLE_HOOK,
  hookFeePips: 10000,
  /** USD WAD per 1e18 raw USDG ($1, 6 decimals). */
  quotePriceUsdWad: 10n ** 30n,
} as const;

export const isDisciplePoolId = (id: string | null | undefined) =>
  !!id && id.toLowerCase() === DISCIPLE_POOL.id;
