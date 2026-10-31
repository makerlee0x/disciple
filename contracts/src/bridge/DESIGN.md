# Disciple

Disciple is a Uniswap v4 hook that bootstraps a new liquidity pool from a tiny seed through incentivized arbitrage. It uses an onchain bonding curve anchored to an existing pool's price, compounds every fee back into the pool, and earns Morpho yield on idle USDG while the pool's graduated status is on.

The contract is `DiscipleHook`. Its engine is `DiscipleEngine`. Writes go through `DiscipleSwapFacet`, `DiscipleLpFacet`, and `DiscipleAdminFacet`, which share `DiscipleFacetBase`. The curve, fee, arb search, anchor, and storage libraries keep the `Bridge*` names (`BridgeCurve`, `BridgeFee`, `BridgeConstants`, `BridgeArb`, `BridgeV3Anchor`, `BridgeV4Anchor`, `BridgeStorage`). `AscensionHook` is a separate post-graduation 1% fee hook. Latched graduation does not migrate a pool onto it. The word is still graduation.

One immutable hook. Many coin/USDG pools. The hook is generic and permissionless. It does not assume a team-owned flow, and it does not special-case any coin address. JESUS (`0x777A8DD86f0E29A28DAcf548Aebf42BB484daBBa` on Robinhood Chain) is the reference seed in the docs and in `test_recommendedSeedIsAllCoin` only.

Nothing here is deployed. The deploy script is `script/bridge/DeployDisciple.s.sol`. It has not been run. Tests use mocks for LayerZero, the reference pool, and Morpho. v1 does not set a bridge fee and does not run an arb bot. Docs and tests assume a 0% bridge fee. `suggestedFeeBps` is the pool's own progress fee, not a subsidy for bridging coin in.

## What it does

A coin that already trades somewhere gets a new fee-earning book. The anchor is that other pool's 30-minute TWAP. The anchor source is chosen once, per pool, at creation: a cross-chain lzRead, a same-chain Uniswap v3 `observe`, a same-chain v4 hook `consult`, or a 30-minute ring this hook samples from a v4 pool. See Anchor source.

The curve starts 33% below the anchor (0.67×) and climbs toward it as buyers add USDG. After every trade both Dutch quotes reset to the anchor. Then, until someone trades, the bid (USDG the pool pays for the coin) rises above the anchor and the ask (coin sold for USDG) falls below it. There is no cap on that gap. One taker can only lift a shrinking slice. The seed guard, the tail, the USDG floor, and the same-block LP rules bind on that slice too.

The fee is only the progress slide: 2% while the pool is tiny, 0.3% once pool TVL reaches the live graduation target. It does not rise with the gap, with volume, or because the anchor is stale. The gap is the incentive. The keeper still earns a $1 tip when a cross-chain quote is stale.

Graduation status turns on only after pool TVL has stayed at or above the live target for 77 continuous minutes, and then it stays on. The target is 12% of the reference pool's smoothed TVL, read on the same path as the anchor and smoothed with a 30-minute half-life. It moves. It is not frozen at $86,520. The band, the fee, the LP boost, and Dutch size use that live progress as soon as TVL changes, including after status has latched. Only the status flag waits, and only that flag turns Morpho and the creator's 10% cut on.

There is no upgrade and no key that can move user funds, fees, or the price. Per-pool settings (floor, launch discount, creator wallet, outflow cap, Morpho cap, Dutch drift, anchor source) are fixed at creation except two narrow keys. The creator can point their fee wallet at a new address. That only redirects their fee. A vault admin, set at creation and able to renounce itself, can only pull the ERC-4626 position back into the pool, or replace that vault with another ERC-4626 of the same USDG after a 48-hour public timelock. It cannot pause trading.

## Why the OpenZeppelin hook bases are not inherited

`BaseCustomCurve` / `BaseCustomAccounting` (OpenZeppelin Uniswap Hooks) are the right idea: quote in `beforeSwap`, return a delta, and keep the hook's own liquidity as ERC-6909 claims. They do not fit this repo:

- Current OZ imports `SwapParams` from `PoolOperation.sol`. This repo pins Uniswap v4-core v4.0.0 (`e50237c4`), which is before that refactor. The matching OZ tag (v1.0.0) is single-pool.
- This hook serves many pools from one deployment. A singular `poolKey` cannot do that.

The curve, the Dutch fill, and the arb search live in `DiscipleEngine`, a stateless contract with no admin. Swaps, LP accounting, and the vault admin live in three more contracts (`DiscipleSwapFacet`, `DiscipleLpFacet`, `DiscipleAdminFacet`). The mined hook holds the storage and answers every view itself. Anything that writes is a `delegatecall` to a facet, so the pool manager, the vault, and the tokens still see the hook. Facet addresses are fixed in the hook constructor and cannot be replaced. That split is what keeps every deployed contract under the 24kb limit. The engine cannot move tokens. A facet holds none: it only runs as the hook. Public library functions (`BridgeV4Anchor`, `engine.decayed`, `engine.anchorOk`, `engine.normalizeDrift`) are linked with `DELEGATECALL` so they are not copied into every facet. Internal library functions are inlined into every caller. `DiscipleFacetBase` is inherited by the LP, swap, and admin facets, so growth there hits all three.

So the same pattern is implemented directly on v4-core v4.0.0. v4 concentrated liquidity is disabled (`beforeAddLiquidity` / `beforeRemoveLiquidity` revert). `slot0` is a dummy set at tick 0 and is never read. The pool fee flag is dynamic, but the number v4 stores is not the fee users pay. Real fees are USDG taken inside the quote, because a single v4 pips fee cannot express a progress-dependent USDG fee that compounds into the book.

External `initialize` reverts. The hook initializes the pool itself; v4 skips `beforeInitialize` on that self-call.

## Curve

Reserves are 18-decimal normalized. `spot = (y + vy) / (x + vx)`.

- Launch: `vx = 0`, `vy` so spot = anchor × (1 − discount). At 33% off, that is 0.67×. Real USDG is not required. The $77 seed is the coin the curve sells.
- The constant-product term reaches the anchor after selling about `1 − √0.67 ≈ 18%` of the seed. The price can then go through the anchor, which is what pays sellers to refill the coin.
- Seed floor: the last 50% of the original seed cannot be bought while spot is still below the anchor. On the launch virtuals this does not bind (the anchor is hit at ~18%). It binds if something makes the book so deep that the price cannot reach the anchor in time. It binds on a Dutch fill too.
- Depth: once spot is at or above the anchor, virtual reserves grow with the TVL high-water and never shrink. The band is how far trading inventory worth the whole TVL moves the price. It is ±25% at or below $100 TVL and about ±3.33% at that pool's live graduation target. In between it is linear in ln(TVL):

  `band = 0.25 − (0.25 − 0.0333) · ln(v / 100) / ln(grad / 100)`.

  Each doubling of TVL takes the same bite out of the band. The endpoint moves with the live target, which is 12% of the smoothed reference TVL. The dollar examples below use the old static example, graduation at $86,520 (12% of a $721k reference). On that target the log midpoint (~$2,941) is about ±14.2%, and $10k is about ±10.2%. The effective USDG book is `TVL / band`. A $100 pool is about a $400 book. At the $86,520 example, graduation is `TVL / 3.33%`, about $2.60M of virtual USDG. A swap walks toward that book by at most the clip's USDG notional divided by the current band. One buy cannot jump the launch virtuals to the target and sell the difference back. Sells quote the book the last buy already traded. Enough flow settles on the band. Direct `deepen` still applies the whole step. Unknown graduation (no reference TVL yet) does not deepen: the band stays ±25%.
- Tail: extra cost `base · (TAIL_K / WAD) · f^31 / 31`, with `f = amount / side` and `TAIL_K = 8`. Same 1e36 power style as `CurveMath`. Negligible until a trade is most of a side, then sharp. Buys round cost up, sells round proceeds down.
- Audit G-7: sell proceeds are clamped so buying the same coins back costs at least one wei more.

TVL for fees, the band, the boost, Dutch size, and graduation is `coin · anchor + USDG`, and the USDG figure includes assets sitting in Morpho. Never the pool's own spot.

## Fees

Both sides pay the same bps in USDG. Direction does not change the fee. There is no discount for a gap-closing trade and no extra charge for opening one.

The fee is `BridgeFee.baseFeeBps(poolTvl, liveTarget)`. It is 200 bps (2%) at TVL 0 and slides linearly in TVL to 30 bps (0.3%) as pool TVL reaches the live target. At or above the target the fee is 0.3%. If the target is still 0 (no reference TVL yet) the fee stays at 2%. That is the whole fee.

There is no volume multiplier, no red line, no half-life on a fee accumulator, and no Doppler term that scales the fee with the price gap. The full gap is left to whoever closes it. A stale anchor does not multiply the fee. `decayed` remains, and it is only the 30-minute smoother for reference TVL.

`bridgeQuote.suggestedFeeBps` is that progress fee, the same number in both directions. It is not a subsidy.

| | |
| --- | --- |
| Fee | 2% at TVL 0, linear in pool TVL to 0.3% at the live graduation target. This is the fee, not a ceiling. |
| Unknown target | 2% until a reference TVL has been read |
| At the target | 0.3% |
| Gap | Does not change the fee |
| Volume | Does not change the fee |
| Stale | Does not change the fee. Cross-chain staleness pays the keeper tip. |
| Keeper tip | Cross-chain only. 10% of each fee, budget capped at $10, paid $1 only when a read was stale |
| Creator | 10% of the fee, only while graduated status is on. The only fee cut besides the keeper tip |

There is no protocol fee and no builder fee. In same-chain mode the keeper tip is zero, so until graduated status turns on the whole fee compounds into the book.

The keeper calls `updatePrice()` and pays the native lzRead fee. The hook builds the read calldata. The sender never supplies a price. A fresh quote reverts, so the tip cannot be farmed. The first read is allowed with a zero tip if nobody seeded the budget; an optional `tipSeed` on create (or `fundTip`) covers that. Tip seed is not part of the $77. `updatePrice` and `fundTip` revert on a same-chain pool (`SameChain`).

What remains after the tip and the creator cut compounds into the book. Redeems pay the same progress fee. That fee stays with the protocol and the remaining LPs as principal. It is not run back through the boost.

## Dutch auction

Both sides share one clock, `dutchAt`. A successful fill sets it to the current timestamp (stored as 1 if the timestamp is 0). Create sets it the same way, so a pool does not start already drifted. A quote does not move the clock.

The gap is `drift × (now − dutchAt)`, in WAD, as a fraction of the anchor. There is no maximum. Drift is a per-pool parameter fixed at creation. Passing 0 selects the default, `uint256(0.01e18) / 1 hours`, about 1% of the anchor per hour. The division truncates, so one hour of the default is 2800 wei under 0.01e18. The allowed range is about 0.1% to 10% of the anchor per hour. Out of range reverts `BadCreate`.

From the anchor:

- the bid (USDG the pool pays for coin) is `anchor × (1 + gap)` and rises;
- the ask (coin sold for USDG) is `anchor × (1 − min(gap, 0.99))` and falls. The ask price stops at 1% of the anchor so it stays positive. The size still uses the raw, uncapped gap, so a later quote is a smaller slice.

Size, in USDG, is `min(edge / gap, cap)` with `edge = 0.25e18` and `cap = min($50, max(TVL / 20, $1))`. One taker cannot drain the pool. A wider gap offers less, not more.

Gap 0 does not override the curve. A same-timestamp trade still pays the launch discount (0.67×) if that is where the book is resting. When the gap is positive, the drifted price is used for the capped slice only if it is a better price than the resting spot (a buy only if the ask is below the spot, a sell only if the bid is above it). The book is then retargeted back to the pre-trade spot and any remainder walks the curve. If the Dutch slice is capped by the seed guard or the floor, or it does not clear, the whole trade walks the curve. An ask that has only fallen to 0.93× does not replace a book still sitting at 0.67×.

`dutchQuote(poolId)` returns the gap, the bid, the ask, both USDG sizes, and the progress fee. `dutchState(poolId)` returns the drift and `dutchAt`. `quoteExactIn` calls the same `engine.trade` the swap uses, including the current gap, so a quoted size is the size a swap would fill. `arbQuote` goes through that path too. At gap 0 it is the unchanged `BridgeArb` search. The search ceiling is `FEE_TINY_BPS`, the highest progress fee.

## Anchor source

Chosen once, in `createPool`, and never changed. `engine.anchorOk` checks the addresses. A mismatched combination reverts `BadCreate`.

| Kind | Value | Where the 30-minute price comes from |
| --- | --- | --- |
| `ANCHOR_LZ` | 0 | lzRead calls `IEthAnchor.latest` on `remoteOracle`. Returns `(priceWad, tvlWad)`. |
| `ANCHOR_V3` | 1 | Same-chain `observe` on `v3Pool`. No spot fallback. Reverts if the pool has less than 30 minutes of history. |
| `ANCHOR_V4_ORACLE` | 2 | Same-chain `consult(refPoolId, 30 minutes)` on `refHook`. The hook owns the units. |
| `ANCHOR_V4_SAMPLE` | 3 | Same-chain ring. This hook reads `StateLibrary.getSlot0` / `getLiquidity` on its own PoolManager, at most once per block. |
| `ANCHOR_LZ_V4_ORACLE` | 4 | lzRead calls `consult(refPoolId, 30 minutes)` on the remote hook. Same `(uint256, uint256)` decode as `latest`. |
| `ANCHOR_LZ_V4_SLOT` | 5 | lzRead calls `V4SlotReader.read(refPoolId)` on the remote chain. The local ring records the tick. |

`updatePrice` calldata is `IEthAnchor.latest` for kind 0, `IV4OracleHook.consult(refPoolId, 30 minutes)` for kind 4, and `V4SlotReader.read(refPoolId)` for kind 5. Kinds 1–3 revert `SameChain`. A v4 self-sample is refreshed by `poke`, by swaps, and by the other same-chain reads, not by `updatePrice`.

Same-chain kinds (1, 2, 3) are never stale. Time passing does not pay a tip. A `tipSeed` on those creates is rejected so USDG cannot sit in a budget nobody is paid. Cross-chain kinds may take a tip. A stored quote older than 30 minutes, or an anchor that is still 0, is stale: the pool stays open, the fee does not change, and the next successful update pays the keeper from the tip budget.

**v3.** The reference is a Uniswap v3 pool of this coin and the hook's quote token. Every quote and every state change calls `observe([30 minutes, 0])` and uses the average tick. It does not read `slot0`. A spot print with no duration does not move the anchor. TVL is the reference pool's token balances valued at that TWAP. The pool needs 30 minutes of oracle history already. `observe` reverts when the cardinality does not cover the window, and the hook does not fall back to spot, so swaps revert until the window exists. `increaseObservationCardinalityNext` on the reference pool is a launch prerequisite. A WETH-quoted v3 pool is not priced as dollars. Deploy the hook with the numeraire that pool quotes.

**v4 oracle hook.** `IV4OracleHook.consult(bytes32 poolId, uint32 secondsAgo) returns (uint256 priceWad, uint256 tvlWad)`. `priceWad` is normalized USDG per 1e18 of coin. `tvlWad` is that pool's TVL in normalized USDG. An AI/NVDA pool has to convert NVDA into USDG inside `consult`. Disciple does not interpret the reference pool's currencies on this path. The creator passes `refPoolId` and `refHook`. That is the same trust as picking a v3 pool: the hook believes the address.

**v4 self-sample.** v4 has no `observe`. The hook keeps a ring of 2048 observations, keyed by this hook's own pool id, in the hook's storage (`rings`, `obs`). `BridgeV4Anchor` is a public library, so `StateLibrary` is not copied into the facets. The creator passes `refPoolId` and `refCoinIs0`. A pool id does not carry token addresses, so the hook cannot recover them. The sampled pool is assumed to be this coin paired with the hook's USDG. A different numeraire has to use the oracle-hook path.

The ring packs a `uint32` timestamp and an `int56` tick cumulative into one word. The first observation stores a cumulative of 0. Later observations, at most one per timestamp, advance the cumulative by the tick that was in force during the interval (`lastTick × dt`), which is the tick a Uniswap TWAP uses. A second sample in the same timestamp is ignored. A projection that does not fit in `int56` is skipped and nothing is written. The mean tick is `(cumNow − cumOld) / dt`, rounded toward negative infinity. If the oldest sample is newer than `now − 30 minutes`, the TWAP is not ready: create still succeeds, the anchor stays 0, and swaps revert `NoAnchor`. There is no spot fallback. Price conversion is `TickMath.getSqrtPriceAtTick` and then the same Q64.96 fraction `BridgeV3Anchor` uses. It does not divide by `2^192` first.

TVL on this path is a proxy, not the PoolManager's token balances. It is the quote side of a zero-width in-range position, doubled so both sides are counted in the quote: `amount1 = L × sqrtPriceX96 / 2^96`, `amount0 = L × 2^96 / sqrtPriceX96`. If the coin is token0, raw TVL is `2 × amount1`. If the coin is token1, raw TVL is `2 × amount0`. That raw amount is normalized with the quote token's decimals. Liquidity 0 or `sqrtPriceX96 == 0` (uninitialized) records nothing useful: TVL 0 leaves `gradTvl` at 0, and the band stays wide.

Someone can inflate in-range liquidity, donate into the tick, or print a spot that the next block samples. The price still has to sit in the ring for 30 minutes before it is the anchor, one block cannot overwrite the sample, the TVL reading is then smoothed with a 30-minute half-life, and graduated status waits another 77 minutes on top of that. A one-block donation barely moves the smooth. A sustained manipulation has to outlast the smooth and the status window. It can still move the target if it is held.

**Cross-chain v4 slot.** `V4SlotReader` is a separate contract with an immutable PoolManager. Deploy it on the chain that holds the reference pool. `read(bytes32)` returns `(sqrtPriceX96, tick, liquidity)`. The hook's lzRead callback records the tick into the local ring and does not revert if the TWAP is not warm yet. The anchor stays 0 until 30 minutes of samples exist. The keeper tip can still pay on that read. A second read 30 minutes later is what turns the anchor on.

## Reference TVL

The first reference reading snaps into `smoothedTvl`. Later readings pull the error toward the new reading with a 30-minute half-life (`engine.decayed`, which is `amount × 2^(−dt / 30 minutes)`). A zero `dt` does not move the smooth, so two reads in one second cannot jump it. `ethTvl` stays the last raw reading. The live target, `_gradTvl`, is `smoothedTvl × 12 / 100`, not 12% of the raw reading.

A reference that opens at $725k and is later reported as $10k is still near $725k after half an hour. Six hours is twelve half-lives. The leftover error is about $175, so the smooth sits near $10,175 and the target near $1,221. A sustained false reading has to be held through that smooth before the target follows it, and graduated status then waits another 77 minutes.

## LP shares

`deposit` and a swap `hookData` of `abi.encode(bool mintLp, address recipient)` mint the hook's own shares. `mintLp = true` keeps the swap proceeds as shares instead of paying them out. Empty `hookData`, and an explicit `false`, pay the proceeds out exactly as a normal swap. This is not v4 `modifyLiquidity`. Shares use an ERC-4626-style virtual offset (`1e6`) so the first depositor cannot inflate the rate.

Deposits and redeems settle against the book from the start of the block. The first hook call in a block snapshots spot and LP reserves after the anchor sync and before the action. A same-block deposit is escrowed: redeeming it that block unwinds those tokens (minus the normal redeem fee), not a pro-rata slice of whatever a buy just pushed into the LP pot. Shares already held redeem against the opening reserves, and the redeem retargets to the live spot so the trade's price is not erased. Share mints use the opening NAV, so a buy in the same block does not change how many shares a deposit gets.

Fees work the same way. A swap parks the LP's fee until the next block and then divides it by the shares that existed at the open (same-block mints are not in the denominator). A deposit, buy, and redeem in one transaction, including inside a flash loan, cannot collect the 5× fee weight. The parked fee is visible from `pendingFee` for shares that were already settled. If nobody eligible still holds when the block rolls, that fee moves to protocol inventory.

The 5× → 1.2× boost (linear in TVL, finished at the live target, then stuck at 1.2×) multiplies the LP's weight when a fee is split into the fee index. It is not applied to principal and not applied when a swap re-splits inventory. An early LP whose anchor-value matches the protocol seed has weight 5 against the seed's weight 1, so about 5/6 of the fee, and none of the principal. A depositor who trades against themselves and redeems gets back less than they put in.

While spot is below the anchor, a USDG deposit that would mint virtual coin is rejected (`DiscountDeposit`). Replacing virtual USDG with real USDG is allowed and does not move the quote. A deposit large enough to pin the 0.67× price would let a buyer clear the seed floor without the price climbing, then remove the depth. Coin deposits are always allowed. After the quote has reached the anchor, either side can be deposited and the quote does not jump.

No lock. Redeem any time. A same-block redeem of a fresh deposit returns the escrow, so "redeem any time" includes the block of the deposit. A deposit does not start the graduation timer. The timer starts on the next trade, poke, or price update.

## Dump protection

Sells cannot take real USDG principal below the floor. Default 20% (allowed 1%–50%, set per pool, no zero floor). Normal sells clear. A dump that would break the floor is cut at `quoteExactIn`, which returns the largest size that fits. Passing the uncapped size to v4 reverts (`ExceedsCap`). v4 cannot partial-fill an exact-in swap here: any specified amount the hook does not take is swapped against the empty concentrated-liquidity pool and runs the dummy price to the limit. Exact-out is unsupported for the same reason. The floor binds inside a Dutch sell the same way.

Optional outflow cap, default off. Window must be one block or one hour. The cap is a percentage of principal at the start of the window and applies to sells, not to redeems.

## Graduation and Morpho

Progress is `pool TVL / (12% × smoothed reference TVL)`. It is not distance to a dollar amount frozen at launch. $86,520 is only what that formula is today for a $721,000 reference. The band, the base fee, the LP boost, and Dutch size are all functions of that progress. They move on the next trade, poke, or price update. A reference that grows (the target becomes $120,000 at a $1,000,000 reference) lowers progress, and the curves step back up the same line: a wider band, a higher fee, a higher boost, and a larger Dutch slice. A reference that shrinks raises progress and the curves step down. The 30-minute half-life on reference TVL is what keeps a flash deposit in the reference pool from moving them in one block.

Graduated status is separate, and it latches. `aboveSince` starts the first time a trade, a poke, or a price update observes pool TVL at or above the live target. The first observation never flips status in the same call. Status turns on only when a later call sees the pool still over the line and `block.timestamp` is at least 77 minutes (`GRADUATION_WINDOW`, 4620 seconds) past `aboveSince`. The window is a fixed global constant, not a per-pool parameter. Crossing back under the line before those 77 minutes clears `aboveSince` and the window starts over. Time alone does not write storage. Someone has to call `poke(poolId)`, or trade, or deliver a price update. `poke` is permissionless.

Once that window completes, status stays on. It does not turn off if pool TVL later falls under the target, and it does not turn off if the reference grows and the target moves up through the pool. The reason to latch it: the flag is what turns Morpho and the creator's 10% cut on. Those are a reward for having held the target, not a position that should be unwound because the reference pool got larger. Unwinding the vault on a reference rally would punish this pool for someone else's TVL. The curves already do the job a reversible flag would have been asked to do. When progress falls, the fee, the band, the boost, and the Dutch slice step back up while Morpho and the creator cut stay on, so arbers are paid to catch the new target and the graduated book keeps its yield. A shrinking reference lowers the target under a pool that already cleared a harder line. Leaving status on is the conservative reading of that too.

While status is on, the creator's 10% cut is on, and idle USDG above the floor plus a trading buffer, and only up to the per-pool Morpho cap, is deposited into an ERC-4626 vault. The constructor takes the default vault. On Robinhood Chain the production vault is `0xBeEff033F34C046626B8D0A041844C5d1A5409dd` (Morpho Steakhouse USDG). That address is chain-specific. A testnet that does not have it must pass a different ERC-4626 of the same USDG. The hook checks `asset()` is USDG. Each pool stores its own vault, starting at the constructor default.

The cap is set at creation. `10_000` bps means the floor and the buffer are the only limit. The recommended value is 50% of USDG principal (`MORPHO_CAP_BPS`). The tighter of the cap and `principal − floor − buffer` wins. The buffer is `max($500, 5% of TVL)`. It stays liquid so ordinary sells do not need the vault. A sell calls `withdraw` only for the excess of vault assets over the principal still in the book after the trade, and it burns the shares the vault reports. If the vault reverts, that sell does not revert the pool: the withdraw is best-effort and returns false, and a smaller sell that fits in the liquid balance still works. Yield accrues to protocol inventory, not to the boosted LP index, so a depositor cannot sandwich a harvest. A loss socializes protocol inventory first, then LP principal.

Status does not turn off, so a dip does not redeem the vault. The vault admin can still `pullAllFromVault`, and `pullVaultOnLoss` still redeems when the share price has dropped. A dead vault no longer matters to the graduation poke, because that poke does not redeem. The admin pull still reverts if `redeem` fails. It does not swallow the error.

`pullVaultOnLoss` is permissionless. If `previewRedeem` of the pool's shares is below the accounted assets, it redeems the whole position (so a slashed vault pays what it still has) and freezes new deposits into that vault. A healthy vault reverts, so the call cannot be used to force a round trip. `rebalance` will not deposit again until a new vault is executed. The vault admin can `pullAllFromVault` immediately without a loss and without freezing, and can `proposeVault` a different ERC-4626 of the same USDG. `executeVault` is public once 48 hours have passed, empties the old vault first, and clears the freeze. Replacing a proposal restarts the clock. The admin can renounce. None of these calls move the fee index, the creator accrual, LP shares, or the anchor, and none of them pause swaps.

Pools are not migrated to `AscensionHook`. That contract is a different 1% fee hook. The latch lives entirely in `DiscipleHook`.

## Bridge view

`bridgeQuote(poolId)` returns the anchor, the pool price, the signed gap, the signed coin-versus-USDG imbalance, the progress fee, and stale / graduated flags. A future OFT can read this from `_debitView`. The bridge is not in this contract. The fee in that struct is not a bridge-fee quote. v1 assumes the bridge fee is 0%.

`arbQuote(poolId)` returns the exact-in size and direction that maximizes mark-to-anchor profit after the fee a swap would charge right now, using the same Dutch-or-curve path as `beforeSwap`. `buyCoin` means spend USDG to buy the coin. Amounts are raw token units, so a router can pass `amountIn` straight to `PoolManager.swap`. The size is the profit-maximizing one, not the largest size that is still green, and it is never a capped fill. `profitWad` is normalized USDG. A zero `amountIn` means the fee eats the gap; `buyCoin` still says which side of the anchor the pool is on.

## Defaults

| Knob | Value | Why |
| --- | --- | --- |
| Discount | 33% (0.67×), allowed 10–50% | The agreed launch gap. Explicit at creation. Gap 0 leaves it in place. |
| Seed floor | 50% of the original coin seed | Backstop so a deep book cannot give away the whole seed under the anchor. The natural climb hits the anchor at ~18%, so day-one buys are not stuck. Binds on Dutch fills. |
| USDG floor | 20%, allowed 1–50% | Agreed dump backstop. 0% is not offered. Binds on Dutch sells. |
| Band | ±25% at or below $100 TVL, ±3.33% at the live target | Linear in ln(TVL). On an $86,520 example target the log midpoint (~$2,941) is about ±14.2% and $10k is about ±10.2%. The endpoint moves with the smoothed reference. Unknown graduation does not deepen. |
| Tail | `TAIL_K = 8e18`, exponent 30 | Emptying a side costs about 8/31 ≈ 26% extra on top of constant product. |
| Fee | 200 bps → 30 bps | The whole fee. 2% while tiny, linear in pool TVL to 0.3% at the live target. No volume multiplier. No gap term. No stale multiplier. |
| Dutch drift | ~1% of the anchor per hour | Default when create passes 0. Allowed about 0.1% to 10% per hour. Fixed for the life of the pool. |
| Dutch edge | $0.25 at a 100% gap | Size is edge/gap, then capped. |
| Dutch slice | min($50, max(TVL/20, $1)), then × progress | Safety cap first. Progress scales it from 100% at a new pool to 20% at the live target, and a higher target scales it back up. The ask price stops at 1% of the anchor. The size uses the raw gap. |
| Direction | none | Buys and sells pay the same fee. Closing a gap is not discounted. The gap itself is the incentive. |
| Stale | 30 minutes | Matches the TWAP window. The pool stays open. The fee does not change. Cross-chain only. |
| Tip | $1, 10% of fees, $10 budget | Covers a keeper's gas plus an lzRead fee with a small margin, and stops spam. Not a fee multiplier. |
| Boost | 5× → 1.2× at the live target | Linear in progress. Early LPs earn more of the fee. While pool TVL is at or above the live target the weight stays 1.2×. A higher target puts it back on the line. Principal is excluded. |
| Graduation target | 12% of smoothed reference TVL | Moves with the reference. $86,520 is only the example for a $721k reference, and the seed test still asserts that constant. |
| Graduation window | 77 minutes | Continuous time at or above the live target before status turns on. It then latches. Progress does not wait, and it does not freeze after the latch. |
| Creator | 10% of fees while status is on | Only a redirectable claim. Not principal. Stays on once status latches. |
| Buffer | max($500, 5% TVL) | Ordinary sells survive a vault outage. $500 is the floor because a $77 book has no idle USDG yet. |
| Morpho cap | 50% of USDG principal, allowed 0–100% | Caps how much of the book can sit in one vault. 100% leaves only the floor and the buffer. Set per pool. |
| Vault timelock | 48 hours | A vault replacement is public for two days before anyone can execute it. The pull is immediate. |
| Share offset | 1e6 | Virtual shares/assets against inflation. |
| Outflow | off unless the creator sets a block or hour window | Agreed default. |
| Keeper on the first read | $0 unless a tip was seeded | No fees exist before the first price. Same-chain has no keeper. |
| Anchor | Chosen per pool, six kinds | Same-chain skips the tip. v4 self-sample assumes coin / this hook's USDG. |

## Recommended $77 seed

100% coin, 0 USDG inside the curve. At a $1 anchor that is `77e18` coin units and `0` USDG.

For JESUS at $0.0000000136 that seed is `77e18 / 13_600_000_000` = `5,661,764,705.882353` tokens (`5661764705882352941176470588` in 18-decimal wad, about 5.6618e9 JESUS). The curve still stores `77e18`, because the anchor in the seed test is normalized to $1 and a coin unit is one dollar of JESUS. The address is documentation. The hook does not branch on it.

The 0.67× price is virtual USDG (`vy ≈ 0.67 × anchor × coin`). Putting real USDG in the $77 does not set the discount, and it is the first thing a dump tries to take. A keeper tip, if any, is a separate `tipSeed` and is not inventory.

The constant `GRAD = 86520e18` in `test_recommendedSeedIsAllCoin` is that example target (12% of $721k). The live target in the hook is 12% of the smoothed reference, not this constant.

## Simulator

`test/bridge/DiscipleSim.t.sol` runs the real curve. `SIM_RESULTS_PARTIAL.md` is an earlier moving-anchor campaign. That campaign's recommendation was to ship a volume-based fee and leave the Dutch auction in the simulator. That recommendation is not the product. The hook ships the progress-only fee and the two-sided Dutch auction described above.

`SIM_RESULTS_V2.md` is a later study. The main runs hold the reference at $721,000. One run grows it to $1,000,000 and one shrinks it to $500,000. Rank is days to graduation, then day-365 TVL. Searcher profit is reported in progress buckets (0–10%, 10–30%, 30–60%, 60–100% of the live target), and it has to stay positive in every bucket the pool occupies before status latches. The volume fee in that file is a study input. Its ceiling is the progress slide, and its red line is the searched value at 100% progress and a quarter of that at 0%, so a larger reference both raises the ceiling and tightens the line. The hook charges the progress slide. `test_simV2` runs only when `SIM_V2=1`. It is outside the contract tests.

## Deviations from the wording of the spec

These are called out here rather than quietly "fixed."

1. OpenZeppelin's single-pool hook bases are not used. Same accounting pattern, multi-pool, on the pinned v4-core.
2. The full LayerZero OAppRead stack is not vendored. The hook talks to a narrow `ILzRead`. Production wiring is an adapter over lzRead. Tests use `MockLzRead`, and the callback is async.
3. A v4 swap cannot be partial-filled without moving `slot0`. Oversized exact-in reverts. `quoteExactIn` returns the capped size so a router can cut the dump short. Exact-out reverts.
4. USDG deposits that would freeze the launch discount revert until spot reaches the anchor. Smaller USDG deposits that only replace virtual USDG are accepted. This blocks "deposit depth, buy the seed at a stuck 0.67×, withdraw the depth."
5. The redeem fee is not fed back through the boost index. It stays as principal of the protocol and remaining LPs.
6. Morpho yield is credited to protocol inventory, not to the LP fee index.
7. Graduated status latches after 77 continuous minutes at or above the live target. It does not turn off. The band, the fee, the boost, and Dutch size keep following live progress, so a larger reference reopens those incentives without unwinding Morpho. A pool is not moved to `AscensionHook`.
8. Depth only grows, and only once spot is at or above the anchor.
9. There is no max-deviation clamp on an anchor update. A clamp would freeze the pool on a real crash. A bad read can set any price. See risks.
10. The g^30 tail is ~0 until a trade is most of a side. On USDG, the 20% floor binds first.
11. Same-block LP protection does not roll the live spot back. A dust deposit must not erase a trade. Fresh liquidity is escrowed for the block; the trade's price stays.
12. The Dutch auction is in the contract. An earlier simulation left it out and shipped a volume fee instead. The volume fee is not in the contract.
13. v4 self-sample TVL is a zero-width liquidity proxy, not token balances. The price is still a 30-minute TWAP with no spot fallback.

## Open risks

- Oracle and DVN trust. `onLzRead` accepts whatever the endpoint delivers. There is no admin circuit breaker, on purpose.
- The lzRead callback sits in the mempool. Someone can sandwich it. The 30-minute TWAP limits how far one update moves, and the anchor update keeps the spot/anchor ratio instead of snapping the pool to the new price. It does not remove the sandwich.
- `slot0` of a Disciple pool is meaningless. Integrators that price off the pool's sqrt price will be wrong. The self-sample path does read `slot0` of a different, reference v4 pool.
- No token rescue. Tokens sent to the hook by mistake stay there.
- Fee-on-transfer tokens break claim settlement. The hook assumes a standard ERC-20 and uses a balance diff on seed and deposit.
- The reference pool is fixed at creation and is trusted for its reading. A v3 pool with a short cardinality pauses trading rather than falling back to spot. Balance-based v3 TVL can be inflated by donating tokens to the reference pool. Self-sampled v4 TVL can be inflated with in-range liquidity. Either raises or lowers the graduation target. Neither replaces the 30-minute TWAP with a spot print. The creator's choice of reference is the trust assumption, the same as picking a v3 pool.
- The vault is called during a swap. A reverting `withdraw` fails that pull and not the swap: a smaller sell that fits in the liquid balance still works. The vault admin can replace the vault after 48 hours or pull it now. Until that timelock passes, a malicious vault is the one the pool was created with, or the one already executed. `pullVaultOnLoss` is the permissionless exit when the share price drops, and it needs `redeem` to succeed.
- Graduation does not redeem. A vault that reverts on `redeem` no longer interacts with the status flag: the flag stays on, and the shares stay. Trading continues. The admin pull still reverts on the same failure.
- A loss freezes new deposits into that vault. It does not pause trading. Funds already socialized stay socialized. Yield that arrived before the pull belongs to protocol inventory.
- The first keeper earns nothing until a tip exists.
- Redeem and the fee index round down in favor of the pool. A sell-then-buy of the same coins loses at least one wei before fees, and the fees make the round trip strictly worse.
- Same-block fee credit is paid on the next block, to shares that were already held. `pendingFee` shows it early. Redeeming in the fee's own block forfeits that block's fee.
- The hook, the engine, and the three facets share one storage layout. A facet adds no state of its own. Their addresses are fixed at construction, so a bug in one of them cannot be patched. Direct calls to a facet revert; only the hook's `delegatecall` runs the code.
- A Dutch quote can sit far from the anchor. The slice cap, the tail, the seed floor, and the USDG floor are what stop one taker from emptying the book. They do not stop a sequence of takers from walking it if each one waits for a new gap.

## Not in this version

The following were asked about and are deliberately not built:

- A price-jump circuit breaker.
- A lower fee for small trades.
- On-chain progress or milestone tracking.
- Gap events.
- A bridge-fee control, and an arb bot. The bridge fee is assumed to be 0%.
- A migration from this hook to `AscensionHook`.
- Overshoot / relist, a LEVAMM value-mix quote, and a fee-funded drip. Those exist only in the simulator.

The Dutch bid and ask are in the hook. The volume-based fee is not.
