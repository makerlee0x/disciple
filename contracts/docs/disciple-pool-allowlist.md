# DiscipleHook pool allowlist (Robinhood Chain 4663)

DiscipleHook pools are real Uniswap v4 pools, but they do not look like a normal v4 position:

- `PoolKey.fee` is **0**. The hook's own fee is the pips passed to `createPool` (on this pool, `Created.fee` = **10000**, 1%). Putting 10000 in `PoolKey.fee` hashes a different pool.
- `tickSpacing` is the pair's creation index (`poolsOf`), **1** for the first STRATEGY/USDG pool.
- `initialize` uses sqrt price `2^96` (price 1). That slot0 value is a placeholder. Do not price or size the pool from it.
- `beforeAddLiquidity` reverts, so `StateView.getLiquidity` stays **0**. Reserves sit in the hook's ERC-6909 claims on PoolManager (`balanceOf(hook, uint256(uint160(token)))`).
- Swaps are `beforeSwap` + return-delta. The hook emits `Swapped`, not the AscensionHook `Trade` event, and it does not move v4 liquidity.

Routers and quoters that only pick up pools with v4 liquidity will skip this pool. Add it to a **manual v4 pool list**.

Verified against `contracts/script/hook/SwapSameChainRH.s.sol` (the script requires the key hashes to the id below) and against a live `eth_call` on `https://rpc.mainnet.chain.robinhood.com`: `poolState` reserves equal the hook's ERC-6909 balances, and `V4Quoter.poolManager()` returns the PoolManager below.

## PoolKey — STRATEGY / USDG

| Field | Value |
|---|---|
| currency0 (STRATEGY, 18 dec) | `0x168661C52E5922288dFb2b3f323b6Cf90eb21e18` |
| currency1 (USDG, 6 dec) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| fee | `0` |
| tickSpacing | `1` |
| hooks | `0xcEdc3C312C5B3C4310F0fba0323DDeC797E4aA88` |
| pool id | `0xddbfa6efd15715013f50e7f1cdceaab3b69b0b8e4c9d4b47fcc28e47f6a80e8f` |

Pool id = `keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))`. Same constants: `contracts/deployments/rh-4663-disciple-hook.json`.

## Addresses

| Contract | Address |
|---|---|
| DiscipleHook | `0xcEdc3C312C5B3C4310F0fba0323DDeC797E4aA88` |
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| V4Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |

The quoter address is the same one recorded for Robinhood testnet in `contracts/deployments/rh-testnet-46630.json` and `contracts/docs/frontend-api.md`. On chain 4663, `poolManager()` on that quoter returns the PoolManager above.

## Allowlist

1. Add the PoolKey above to the router's manual v4 pool list (Universal Router command, aggregator pool registry, or a custom list). Do not discover it via `getLiquidity` or slot0.
2. Swap with that exact key. `zeroForOne = true` sells STRATEGY (currency0) for USDG. `zeroForOne = false` buys STRATEGY with USDG.
3. `hookData` can be empty (`0x`). This hook does not read it.

## Quote

`V4Quoter.quoteExactInputSingle` is not a `view`. Call it with `eth_call` (viem `simulateContract`). It runs the hook's `beforeSwap`, so the quote includes the hook fee.

```solidity
struct QuoteExactSingleParams {
    PoolKey poolKey;   // the key above, fee 0 / tickSpacing 1
    bool zeroForOne;
    uint128 exactAmount;
    bytes hookData;    // 0x
}
// quoteExactInputSingle(params) → (uint256 amountOut, uint256 gasEstimate)
```

## TVL

Do not use `getLiquidity`, PoolManager `Swap` amounts, or slot0.

- Per pool: `DiscipleHook.poolState(poolId)` → `coinReserve`, `quoteReserve`, `anchorX128` (quote raw per coin raw, ×2^128).
- Quote-raw TVL = `quoteReserve + coinReserve * anchorX128 / 2^128`.
- Hook-wide check: PoolManager `balanceOf(hook, uint256(uint160(token)))`. One hook can hold several pools, so a claim balance is the sum for that token. On this pool (the only one) the claims match `poolState`.

USDG is $1, so USD = quote-raw TVL / 10^6. The indexer and `GET /api/disciple/tvl` use this read. See `indexer/README.md` (`DISCIPLE_HOOK` or `DEPLOYMENT_JSON` pointed at the catalog above).
