# Routing to Disciple pools

Disciple separates price from pool depth. A Disciple pool takes its price from the coin's main onchain pool and uses its own reserves only as inventory, so a small pool can quote close to the main market. It is a Uniswap v4 hook. One hook contract serves every Disciple pool on a chain, and anyone can create a pool.

This page covers what a router or aggregator needs to quote and fill these pools. The TypeScript helpers are in [`hook-sdk/`](../../hook-sdk).

0x already routes to the live pool on Robinhood Chain: every outside trade so far came through its AllowanceHolder and Settler. Nothing on this page needs an allowlist.

## Live deployment (Robinhood Chain, id 4663)

| What | Address / id |
|---|---|
| PoolManager (Uniswap v4) | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| DiscipleHook v0.2 | `0xC0E513735F35df6A82523744E2aE8a601C772a88` |
| STRATEGY/USDG pool id | `0x8a1d5f363db9d4a7b874abc858a8fdc86786a9208835aa8360b953cad223b8cd` |
| Its key | currency0 STRATEGY `0x168661C52E5922288dFb2b3f323b6Cf90eb21e18`, currency1 USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, fee `0`, tickSpacing `1`, hooks = the hook |
| Its source legs (v4) | STRATEGY/MSTR `0xa6975f47…9ca0`, USDG/MSTR 0.25% `0x319bac87…7cfe` |
| Disciple fee | 1% (held in the hook; the key's fee is 0) |

## How these pools differ from normal v4 pools

- **No v4 liquidity.** Adding liquidity through the PoolManager is refused. The v4 `sqrtPriceX96` stays at 2^96 and means nothing. Don't use tick math, `getSlot0` or `getLiquidity` to price these pools.
- **The hook fills every swap.** It uses `beforeSwapReturnDelta` to take the whole specified amount, so the core v4 swap moves nothing. From a router's point of view it is a normal `PoolManager.swap` whose deltas you settle and take as usual.
- **The fee is in the hook**, and it is already included in every quote. `HookSwap` reports it per trade.

## Finding pools

A pool's key is `(currency0, currency1, fee 0, tickSpacing n, hook)`, where `n` counts the Disciple pools for that token pair, starting at 1.

- `poolsOf(currency0, currency1)` on the hook returns how many there are, so you can build every key and id without scanning logs (SDK: `poolsForPair`).
- New pools emit `Created(id, coin, quote, creator, remoteEid, fee)` on the hook. The PoolManager also emits its usual `Initialize`.
- `poolState(id)` returns the reserves, whether the pool is live, and the centre price (`anchorX128`, quote raw units per coin raw unit, X128).

## Quoting

```solidity
function quoteView(bytes32 id, bool zeroForOne, int256 amountSpecified)
    external view returns (uint256 amountIn, uint256 amountOut);
```

- Signs follow v4: a negative `amountSpecified` means exact input, a positive one means exact output.
- It is a plain view (no revert to decode), so you can call it from a contract or batch it with multicall.
- It returns exactly what a swap would give against the same state, including the per-block centre step and the first-swap-in-block bookkeeping. Tests: `contracts/test/hook/QuoteView.t.sol`.
- These reverts mean "can't fill this size here": `UnknownPool`, `NotLive`, `NoAnchor`, `BadParams`, `ZeroOutput`, `TradeTooLarge`, `InsufficientReserve`. Treat them as zero depth, not as errors (SDK: `tryQuoteExactIn`). Exact-input orders rarely hit them, because the curve's constant-product tail always pays something, so measure depth by price impact instead (SDK: `maxSizeWithinImpact`).
- `quote()` (same arguments, always reverts with `Quote(amountIn, amountOut)`) still exists for older tooling. Use `quoteView`.

### When a cached quote goes stale

The price depends on more than the pool's own reserves:

1. **A new block.** The centre moves toward the source at most one step per block (1% on Robinhood). On Robinhood and other Arbitrum-stack chains, `block.number` inside contracts is the L1 block number, so this step happens about every 12 s, not every L2 block.
2. **Any swap or liquidity change on a source leg.** Every fill is capped against the live source price, read during the swap. For the live pool, those are the two v4 pools above. On another pool, read the legs from storage (SDK: `readPoolInfo` and `watchSet`).
3. **Hook events for that pool id:** `HookSwap`, `HookModifyLiquidity`, `Tipped` (someone called `sample()` and moved the centre), `JarFunded`, and for cross-chain pools `PriceAccepted` and `LocalMode`.

## Executing

Use any standard v4 swap path, such as your own `unlock` callback, the Universal Router's `V4_SWAP`, or a Settler-style executor:

- `PoolManager.swap(key, {zeroForOne, amountSpecified, sqrtPriceLimitX96}, hookData)`
- `sqrtPriceLimitX96`: `MIN_SQRT_PRICE + 1` when zeroForOne, `MAX_SQRT_PRICE - 1` otherwise. The hook enforces its own limits, so the v4 limit only has to be valid.
- `hookData`: empty.
- Then settle the input currency and take the output currency as usual. ERC-6909 is not involved on your side.

`contracts/script/hook/SwapSameChainRH.s.sol` is a working example through `PoolSwapTest`.

## Gas

About 250k gas for the first swap of a block on the pool, and about 180k for later swaps in the same block (forge measurements; live receipts come in somewhat lower because of transient-storage refunds). An aggregator should net this out against the price gain like any other venue's gas.

## Behaviour worth knowing

- **Price:** the centre steps toward the source by at most 1% per block. Around the centre the curve is flat, then constant-product outside a band. Every fill also respects the live source price: our ask is never more than 1bp below the source's ask, and our bid never more than 1bp above its bid.
- **Size:** depth is the pool's own inventory. On the live ~$200 pool (2026-11-10), about $22 per side fills within 1% of the $1 price, and about $60 within 5%. The pool never drains, because quotes get worse as one side runs low and very large orders revert with `TradeTooLarge`.
- **No admin switch.** Parameters are fixed per pool. Cross-chain pools keep trading in local mode if the price feed stops for 2 hours, and same-chain pools read their source directly.

## Turnover

We report turnover, meaning volume divided by pool value. The trade watcher prints it (`cd keeper && npm run trades:summary`), and the SDK has `turnover()`. As of 2026-11-10 the live pool did about 0.8x in its first 1.1 days ($166 of volume on about $200).
