# Uniswap routing request (ready to send; v0.2 deployed 2026-11-08)

Addresses filled in from the 2026-11-08 deploy. Still to fill: the review line and your contact. Uniswap allowlists custom-accounting hooks by hand
(support.uniswap.org, article 33829289869965, "hooks routing request" form). Same text works for an aggregator.

---

**Subject:** Routing request: Disciple hook on Robinhood Chain (custom-accounting v4 hook)

Hi, we'd like the Uniswap routing API and Universal Router quoting to include pools of our v4 hook on Robinhood
Chain (chain id 4663).

- **Hook:** `0xC0E513735F35df6A82523744E2aE8a601C772a88` (verified on Sourcify / Blockscout)
- **PoolManager:** `0x8366a39CC670B4001A1121B8F6A443A643e40951`
- **First pool:** STRATEGY/USDG, pool id `0x8a1d5f363db9d4a7b874abc858a8fdc86786a9208835aa8360b953cad223b8cd`, key fee 0, tickSpacing `1`, hooks = the hook above
  (STRATEGY `0x168661C52E5922288dFb2b3f323b6Cf90eb21e18`, USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`)
- **Library:** DiscipleBooks `0xe927AE26D93CBDeD2c0542c590D5eE02d4A812dD` (linked into the hook)
- **Hook flags:** beforeInitialize, beforeAddLiquidity, beforeRemoveLiquidity, beforeSwap, beforeSwapReturnDelta.
  Custom accounting: the hook holds the liquidity as ERC-6909 claims and fills the whole swap in `beforeSwap`
  (no v4 positions, so the pool shows $0 TVL to the indexer).

**What it does.** Each Disciple pool sits next to a real Uniswap "source" pool for the same token and prices every
swap off that source's live price: its ask is never below the source's live ask (minus 1 bp) and its bid never
above the source's live bid (plus 1 bp). Around its centre the curve is nearly flat, so for many orders it adds
depth at the source's price. Traders are never quoted better than the source's own best price, so routing through it
can't be gamed against the source, and a split between both pools is never worse for the trader than the source alone.

**How to quote it.**
- `quoteView(bytes32 poolId, bool zeroForOne, int256 amountSpecified) view returns (uint256 amountIn, uint256 amountOut)`
  is a plain view call. Same sign convention as a v4 swap (negative = exact in). It returns exactly what a swap sent
  in the same block against the same state pays and receives (tested, including the first swap of a block).
- `quote(...)` (same arguments) does the same through a revert, `Quote(uint256 amountIn, uint256 amountOut)`, for
  quoters that use the revert pattern.
- Gas: about 175k for a swap, 250k for the first swap in a block (it also updates the pool's price reading).
- Events: OpenZeppelin `HookSwap(bytes32 id, address sender, int128 amount0, int128 amount1, uint128 fee0, uint128 fee1)`
  and `HookModifyLiquidity(bytes32 id, address sender, int128 amount0, int128 amount1)` for indexing volume and TVL.
- State and TVL: `poolState(bytes32 id)` returns the reserves (`coinReserve`, `quoteReserve`) and the centre price.

**Review.** Reviewed twice before deploy (the v0.1 code, then the v0.2 changes, 2026-11-08) by <who>; every finding above Low fixed and re-checked; report on request. Contracts: https://github.com/makerlee0x/disciple
(`contracts/src/hook/`).

**Contact:** <name, email / Telegram>

Thanks!

---

## Short version for aggregators (1inch, Odos, KyberSwap, 0x)
> We run a Uniswap v4 hook on Robinhood Chain (`0xC0E513735F35df6A82523744E2aE8a601C772a88`) whose pools quote at or near the live price of an existing
> Uniswap pool for the same token, adding depth there. Quote with the view `quoteView(poolId, zeroForOne,
> amountSpecified)` on the hook: it equals the executed swap. Swaps go through the v4 PoolManager like any v4 pool.
> We'd like it added as a liquidity source; happy to help with an adapter. Contracts and tests: github.com/makerlee0x/disciple.
