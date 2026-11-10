import type { Hex } from "viem";

/** Robinhood Chain (chain id 4663). The v0.2 hook went live 2026-11-08. */
export const ROBINHOOD = {
  chainId: 4663,
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Hex,
  /** DiscipleHook v0.2 (one hook serves every Disciple pool on the chain) */
  hook: "0xC0E513735F35df6A82523744E2aE8a601C772a88" as Hex,
  tokens: {
    STRATEGY: "0x168661C52E5922288dFb2b3f323b6Cf90eb21e18" as Hex,
    MSTR: "0xec262a75e413fAfD0dF80480274532C79D42da09" as Hex,
    USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Hex,
  },
  /** Live STRATEGY/USDG pool, 1% fee, priced off STRATEGY/MSTR x MSTR/USDG (both Uniswap v4). */
  strategyUsdg: {
    id: "0x8a1d5f363db9d4a7b874abc858a8fdc86786a9208835aa8360b953cad223b8cd" as Hex,
    sourceV4Ids: [
      "0xa6975f4720a95aa9cdfa9b010a065b0e941534c93f9fa708104c08f0ac029ca0", // STRATEGY/MSTR (hooked, dynamic fee)
      "0x319bac87e616a89e241c10aeb8afd4892a852cdd8b373cd9765ecddc40b87cfe", // USDG/MSTR 0.25%
    ] as Hex[],
  },
} as const;
