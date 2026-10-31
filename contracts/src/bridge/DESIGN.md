# Disciple

Disciple is a Uniswap v4 hook that bootstraps a new liquidity pool from a tiny seed through incentivized arbitrage. It uses an onchain bonding curve anchored to an existing pool's price. Before graduation every fee compounds into the pool. While graduated, each fee is 3,333 bps to the pool creator, 3,333 bps permanent locked liquidity, and the remainder (3,334 bps) to LPs. There is no builder share.

`DiscipleHook` is the only contract the PoolManager calls. It holds every pool's storage and every token. Four linked libraries do the rest, and their addresses are baked into the hook bytecode:

| Contract | Role | Holds state or funds |
| --- | --- | --- |
| `DiscipleHook` | Custody, storage root, hook callbacks, thin entry points | Yes. The only place tokens sit |
| `DiscipleBook` | Create, swap, poke, seed, shared accounting | No. Writes land in the hook via `delegatecall` |
| `DiscipleLp` | Deposit, redeem, creator claim, quotes | No. Same `delegatecall` |
| `DiscipleMath` | Curve, Dutch, arb search, fee split, graduation step, decay | No. Pure |
| `DiscipleAnchor` | v2, v3, and v4 reads. The hook writes the sample ring | No. View or pure |

Nothing in that set can be swapped. There is no setter, no proxy, no diamond, and no address that changes after deploy. A linked library is fixed code. Calling a library directly would write the library's own empty storage and would move no hook funds, because `address(this)` would be the library. Users call the hook.

The curve pieces that are not deployed on their own (`BridgeCurve`, `BridgeFee`, `BridgeArb`, `BridgeV2Anchor`, `BridgeV3Anchor`, `BridgeV4Anchor`) are internal and inlined into `DiscipleMath` or `DiscipleAnchor`. `BridgeStorage` is the layout at slot 0 of the hook. The hook declares no storage variables of its own, so that slot is the whole layout. `AscensionHook` is a separate post-graduation 1% fee hook used by the bonding-curve product. A Disciple pool stays on `DiscipleHook` for its whole life.

One immutable hook. Many coin/USDG pools. Creation is permissionless, including more than one pool per coin. The hook does not special-case any coin address. JESUS (`0x777A8DD86f0E29A28DAcf548Aebf42BB484daBBa` on Robinhood Chain) is the reference seed in the docs and in `test_recommendedSeedIsAllCoin` only.

Nothing here is deployed. The deploy script is `script/bridge/DeployDisciple.s.sol`. It has not been run. v1 does not set a bridge fee and does not run an arb bot. `suggestedFeeBps` is the pool's own progress fee, not a subsidy for bridging coin in. The hook accepts no ETH.

## What it does

A coin that already trades somewhere gets a new fee-earning book. The anchor is that other pool's 30-minute TWAP. The source is chosen once, per pool, at creation: a same-chain Uniswap v2 pair, a same-chain Uniswap v3 `observe`, or a 30-minute ring this hook samples from a same-chain v4 pool. See Anchor source.

The curve starts 33% below the anchor (0.67×) and climbs toward it as buyers add USDG. A fill at or above $1 of USDG resets only that side's Dutch clock. The other side keeps drifting. Until a side fills, the bid (USDG the pool pays for the coin) rises above the anchor and the ask (coin sold for USDG) falls below it. There is no cap on that gap. One taker can only lift a shrinking slice. The seed guard, the tail, the USDG floor, and the same-block LP rules bind on that slice too.

The fee is only the progress slide: 2% while the pool is tiny, 0.3% once pool TVL reaches the live graduation target. It does not rise with the gap, with volume, or because the anchor is stale. The gap is the incentive. A stale anchor refuses the swap until someone calls `poke`.

Graduation status turns on after protocol inventory has stayed at or above the live target for 77 continuous minutes, and it turns off after that inventory has stayed strictly below that same target for 77 continuous minutes. Inventory is protocol coin marked at the anchor, protocol USDG, locked USDG, and the fee pot. LP deposits are not inventory, so a deposit, a wait, and a withdraw cannot flip status. Every write (swap, deposit, redeem, poke) steps the clock, and seeing the other side clears it. A zero or unknown target counts as below once status is already on. The window is one fixed constant. It is not set per pool, and there is no percent band. A band under 100% would leave a stretch where status stayed on and nothing was pulling the pool back up to the line. The target is 12% of the reference pool's smoothed TVL, read on the same path as the anchor and smoothed with a 30-minute half-life. One step applies at most 10 minutes of that half-life, so a reading after idle time, or one donation, cannot jump the stored TVL the rest of the way. The first reading still snaps. It moves. It is not frozen at $86,520. The depth band, the fee, the LP boost, and Dutch size use spot pool TVL against that live target on the next trade or poke, the moment progress drops under 100%. They do not wait for the status window. Only the status flag waits. While it is on, each fee is 3,333 bps creator, 3,333 bps permanent locked liquidity, and the remainder to LPs. While it is off, the whole fee compounds for LPs. Fees already accrued stay claimable. Locked liquidity already in the book stays locked. Idle USDG stays in the pool.

There is no admin, owner, builder, delegate, allowlist, setter, or rescue. Per-pool settings (floor, launch discount, creator wallet, outflow cap, Dutch drift, anchor source) are fixed at creation. The creator wallet cannot be rotated. Nobody can pause trading.

## Why the OpenZeppelin hook bases are not inherited

`BaseCustomCurve` / `BaseCustomAccounting` (OpenZeppelin Uniswap Hooks) are the right idea: quote in `beforeSwap`, return a delta, and keep the hook's own liquidity as ERC-6909 claims. They do not fit this repo:

- Current OZ imports `SwapParams` from `PoolOperation.sol`. This repo pins Uniswap v4-core v4.0.0 (`e50237c4`), which is before that refactor. The matching OZ tag (v1.0.0) is single-pool.
- This hook serves many pools from one deployment. A singular `poolKey` cannot do that.

The curve, the Dutch fill, and the arb search live in `DiscipleMath`. Price reads live in `DiscipleAnchor`. Create, swap, and LP live in `DiscipleBook` and `DiscipleLp`. The mined hook holds the storage and answers the simple views itself. Library calls are `delegatecall`, so the pool manager and the tokens still see the hook. That split is what keeps every deployed contract under the 24kb limit. One contract could not: the single-contract build was about 45kb. Internal library functions are inlined into the one caller that uses them, which is why the curve is only called from `DiscipleMath` and the v2/v3/v4 readers are only called from `DiscipleAnchor`.

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

TVL for fees, the band, the boost, Dutch size, and graduation is `coin · anchor + USDG`. The USDG figure is that pool's own book. Never the pool's own spot. Each pool also tracks `usdgHeld`, the normalized USDG it may draw from the hook's ERC-6909 claims. A buy or a USDG deposit credits that pool. A sell, a redeem, and a creator claim debit it, and the debit reverts if it would exceed what that pool holds. The claims are one fungible balance, so this counter is what stops a redeem or a swap in one pool from spending another pool's USDG. Fees that stay in the book remain inside `usdgHeld` until they are paid out. Locked liquidity stays inside the curve's USDG. `reserveOk` requires `usdgHeld` to cover the curve's USDG and the creator accrual.

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
| Stale | Does not change the fee. A stale anchor reverts the swap. Quotes still return. `poke` refreshes a same-chain read. |
| Creator | 3,333 bps of the fee, only while graduated. Claimable by the wallet stored at creation. That wallet cannot be changed |
| LPs | 100% before graduation. While graduated, the remainder after creator and locked (3,334 bps), auto-compounded |
| Locked liquidity | 3,333 bps of a graduated fee. Stays in the book, raises depth, and cannot be sold or redeemed. Nobody holds a share of it |

Before graduation, and again after status turns off, the whole fee compounds into the book.

Rounding uses floor division on the creator and locked shares. The LP share is whatever is left, so dust stays with LPs. A redeem pays the same progress fee. Its USDG portion uses this split. Its coin portion stays in protocol coin inventory. The LP portion of a redeem fee is what enters the fee index. Locked liquidity from a redeem is added to `lockedY` and is not folded into principal when the last LP exits.

## Dutch auction

Each side has its own clock, `dutchBidAt` and `dutchAskAt`. A coin-in fill of at least `DUTCH_MIN_SLICE` ($1) resets the bid. A USDG-in fill of that size resets the ask. A smaller fill resets nothing. Create sets both clocks, so a pool does not start already drifted. A quote does not move a clock.

The gap on a side is `drift × (now − that side's clock)`, in WAD, as a fraction of the anchor. There is no maximum. Drift is a per-pool parameter fixed at creation. Passing 0 selects the default, `uint256(0.01e18) / 1 hours`, about 1% of the anchor per hour. The division truncates, so one hour of the default is 2800 wei under 0.01e18. The allowed range is about 0.1% to 10% of the anchor per hour. Out of range reverts `BadCreate`.

From the anchor:

- the bid (USDG the pool pays for coin) is `anchor × (1 + gap)` and rises;
- the ask (coin sold for USDG) is `anchor × (1 − min(gap, 0.99))` and falls. The ask price stops at 1% of the anchor so it stays positive. The size still uses the raw, uncapped gap, so a later quote is a smaller slice.

Size, in USDG, is `min(edge / gap, cap)` with `edge = 0.25e18` and `cap = min($50, max(TVL / 20, $1))`. One taker cannot drain the pool. A wider gap offers less, not more.

Gap 0 does not override the curve. A same-timestamp trade still pays the launch discount (0.67×) if that is where the book is resting. When the gap is positive, the drifted price is used for the capped slice only if it is a better price than the resting spot (a buy only if the ask is below the spot, a sell only if the bid is above it). The book is then retargeted back to the pre-trade spot and any remainder walks the curve. If the Dutch slice is capped by the seed guard or the floor, or it does not clear, the whole trade walks the curve. An ask that has only fallen to 0.93× does not replace a book still sitting at 0.67×.

`dutchQuote(poolId)` returns the ask gap, the bid, the ask, both USDG sizes, and the progress fee. `dutchState(poolId)` returns the drift and both clocks. `quoteExactIn` calls the same `DiscipleMath.trade` the swap uses, including the current gap, so a quoted size is the size a swap would fill. `arbQuote` goes through that path too. At gap 0 it is the unchanged `BridgeArb` search. The search ceiling is `FEE_TINY_BPS`, the highest progress fee.

## Anchor source

Chosen once, in `createPool`, and never changed. A kind above 2, or a reference that fails the check for its kind, reverts `BadCreate`.

| Kind | Value | Where the 30-minute price comes from |
| --- | --- | --- |
| `ANCHOR_V2` | 0 | Same-chain pair. `factory.getPair(coin, USDG)` must be `refPool`, and the pair's tokens must be that coin and USDG. The reserve ratio becomes a tick and is sampled into the ring. There is no v2 `observe`, so the ring has to warm (`MIN_SAMPLES` of 3, oldest at least 30 minutes) before the anchor is trusted. |
| `ANCHOR_V3` | 1 | Same-chain pool. `factory.getPool(coin, USDG, refFee)` must be `refPool`, the tokens must be that pair, and `slot0` cardinality must be at least 2. Price is `observe([30 minutes, 0])`. A failed `observe` does not revert create. The anchor stays 0 and swaps revert `NoAnchor` until a poke can read the window. |
| `ANCHOR_V4` | 2 | Same-chain pool. The creator passes the full reference `PoolKey`: coin, USDG, `refFee`, `refTickSpacing`, `refHooks`, and `refPoolId`. Create and every sample require `PoolKey.toId() == refPoolId`. The hook reads `slot0` on its own PoolManager and samples that tick into the ring. |

There is no cross-chain kind and no external oracle-hook kind. The hook never takes a price from the caller.

A swap reverts `Stale` when the stored quote is 30 minutes old or older. The check happens before the swap refreshes the read, so the swap cannot poke itself through. `quoteExactIn` and `bridgeQuote` still return, and the fee does not change. Redeems are not gated by that check and do not read the oracle: a reverting or zero reference cannot freeze a withdrawal. Deposits still require a live anchor.

Pool creation is permissionless, multiple pools per coin. Anyone can create a pool for any coin. The `creator` argument is the fee wallet stored on that pool. Any non-zero address is accepted, it is not compared to the caller, and there is no creator allowlist. `tickSpacing` of 0 is 60. Any other spacing in range is a different pool for the same coin. Every create still goes through the reference checks above.

Swap hookData may name the recipient of a swap-to-LP mint. `address(0)` means the swap initiator. That initiator pays the input, so the recipient is a gift of their own proceeds. Someone else's swap cannot be redirected. The hook has no `receive`. Sending ETH reverts. There is no rescue.

**v2.** The reserve ratio `sqrt(reserve1 / reserve0) * 2^96` is clamped into a tick and written into the same ring the v4 path uses. TVL is the pair's token balances valued at the ring price, so a donation moves TVL and not the tick. A cold ring leaves the anchor at 0.

**v3.** The reference is a Uniswap v3 pool of this coin and the hook's quote token. A quote and a successful persist call `observe([30 minutes, 0])` and use the average tick. They do not read `slot0` for the price. `slot0` is only the cardinality check. A spot print with no duration does not move the anchor. TVL is the reference pool's token balances valued at that TWAP. `observe` failing is a soft miss: create can succeed, and swaps revert `NoAnchor` until the window exists. A WETH-quoted v3 pool is not priced as dollars. Deploy the hook with the numeraire that pool quotes.

**v4.** v4 has no `observe`. The hook keeps a ring of 2048 observations, keyed by this hook's own pool id, in the hook's storage (`rings`, `obs`). The sampling math is inlined into `DiscipleAnchor`. The hook writes the ring. The creator does not pass a bare pool id. The hook rebuilds the `PoolKey` from the coin, USDG, fee, tick spacing, and hooks, and requires `toId()` to match. Which side is the coin is `coin < USDG`, stored once.

The ring packs a `uint32` timestamp and an `int56` tick cumulative into one word. The first sample is only a candidate. It is not accrued. A later block starts the ring at the tick it sees then, so a pushed first tick never enters the mean. After the ring is live, a new block accrues the tick observed in the prior block for the elapsed time, with no equality check, and then stores the current tick as the next candidate. A trend moves the TWAP. A second sample in the same block only replaces the candidate, so a push, poke, and push-back in one transaction does not weight the TWAP. A quote runs that accrual in memory, so it matches the sample a swap would write. The mean is not ready until three samples exist and the oldest is at least 30 minutes old. Create still succeeds before that, the anchor stays 0, and swaps revert `NoAnchor`. There is no spot fallback. Price conversion is `TickMath.getSqrtPriceAtTick` and then the same Q64.96 fraction `BridgeV3Anchor` uses. It does not divide by `2^192` first.

TVL on the v4 path is a proxy, not the PoolManager's token balances. It is the quote side of a zero-width in-range position, doubled so both sides are counted in the quote: `amount1 = L × sqrtPriceX96 / 2^96`, `amount0 = L × 2^96 / sqrtPriceX96`. If the coin is token0, raw TVL is `2 × amount1`. If the coin is token1, raw TVL is `2 × amount0`. That raw amount is normalized with the quote token's decimals. Liquidity 0 or `sqrtPriceX96 == 0` (uninitialized) records nothing useful: TVL 0 leaves `gradTvl` at 0, and the band stays wide.

Someone can inflate in-range liquidity, donate into the tick, or print a spot that persists into the next block. The price still has to sit in the ring for 30 minutes, across at least three samples, before it is the anchor. A same-transaction push does not enter the cumulative. The TVL reading is then smoothed with a 30-minute half-life, at most 10 minutes of it per step, and graduated status then waits out the 77-minute window. A one-block donation cannot close the smooth. A sustained manipulation has to outlast the smooth and the status window. It can still move the target if it is held.

### Add-on extension point

`IDisciplePriceAddon.refresh(bytes32 poolId)` is the extension point for a price source this hook does not read. The hook does not store the add-on's address, does not call it, and does not read a return value from it. An add-on that wants the hook to use a price puts that price into a same-chain v2, v3, or v4 pool, then calls `poke`. The hook only accepts the three reads above.

## Reference TVL

The first reference reading snaps into `smoothedTvl`. Later readings pull the error toward the new reading with a 30-minute half-life (`DiscipleMath.decayed`, which is `amount × 2^(−dt / 30 minutes)`). A zero `dt` does not move the smooth, so two reads in one second cannot jump it. `ethTvl` stays the last raw reading. The live target, `_gradTvl`, is `smoothedTvl × 12 / 100`, not 12% of the raw reading.

A reference that opens at $725k and is later reported as $10k is still near $725k after half an hour. Six hours is twelve half-lives. The leftover error is about $175, so the smooth sits near $10,175 and the target near $1,221. A sustained false reading has to be held through that smooth before the target follows it, and graduated status then waits out the 77-minute window.

## LP shares

`deposit` and a swap `hookData` of `abi.encode(bool mintLp, address recipient)` mint the hook's own shares. `mintLp = true` keeps the swap proceeds as shares instead of paying them out. Empty `hookData`, and an explicit `false`, pay the proceeds out exactly as a normal swap. This is not v4 `modifyLiquidity`. Shares use an ERC-4626-style virtual offset (`1e6`) so the first depositor cannot inflate the rate.

Deposits and redeems settle against the book from the start of the block. The first hook call in a block snapshots spot and LP reserves after the anchor sync and before the action. A same-block deposit is escrowed: redeeming it that block unwinds those tokens (minus the normal redeem fee), not a pro-rata slice of whatever a buy just pushed into the LP pot. Shares already held redeem against the opening reserves, and the redeem retargets to the live spot so the trade's price is not erased. Share mints use the opening NAV, so a buy in the same block does not change how many shares a deposit gets.

Fees work the same way. A swap parks the LP's fee until the next block and then divides it by the shares that existed at the open (same-block mints are not in the denominator). A deposit, buy, and redeem in one transaction, including inside a flash loan, cannot collect the 5× fee weight. The parked fee is visible from `pendingFee` for shares that were already settled. If nobody eligible still holds when the block rolls, that fee moves to protocol inventory.

The 5× → 1.2× boost (linear in TVL, finished at the live target, then stuck at 1.2×) multiplies the LP's weight when a fee is split into the fee index. It is not applied to principal and not applied when a swap re-splits inventory. An early LP whose anchor-value matches the protocol seed has weight 5 against the seed's weight 1, so about 5/6 of the fee, and none of the principal. A depositor who trades against themselves and redeems gets back less than they put in.

While spot is below the anchor, a USDG deposit that would mint virtual coin is rejected (`DiscountDeposit`). Replacing virtual USDG with real USDG is allowed and does not move the quote. A deposit large enough to pin the 0.67× price would let a buyer clear the seed floor without the price climbing, then remove the depth. Coin deposits are always allowed. After the quote has reached the anchor, either side can be deposited and the quote does not jump.

No lock. Redeem any time. A same-block redeem of a fresh deposit returns the escrow, so "redeem any time" includes the block of the deposit. A deposit does not start the graduation timer. The timer starts on the next trade, poke, or price update.

## Dump protection

Sells and redeems cannot take real USDG principal below 20% of a persistent baseline. The floor is pinned at 20%. Creators do not pass a range. The baseline is a principal high-water mark. It snaps up when principal rises and decays toward principal with a one-day half-life. A zero time delta does not decay, so several sells in one transaction share one floor. A redeem that would cross it reverts `ExceedsCap`. A dump that would break the floor is cut at `quoteExactIn`, which returns the largest size that fits. Passing the uncapped size to v4 reverts. v4 cannot partial-fill an exact-in swap here: any specified amount the hook does not take is swapped against the empty concentrated-liquidity pool and runs the dummy price to the limit. Exact-out is unsupported for the same reason. The floor binds inside a Dutch sell the same way. The first leg of a two-part Dutch sell reduces the room the second leg sees.

The outflow cap is on unless the creator passes an explicit window. Passing zeros selects 20% of principal per hour. A window is one block or one hour. It cannot be turned off. It applies to sells. A buy or a deposit during an open window raises that window's principal baseline, so the first trade into an empty book does not freeze the cap at zero. Outflows do not lower the baseline until the window rolls.

## Graduation

Progress is `pool TVL / (12% × smoothed reference TVL)`. It is not distance to a dollar amount frozen at launch. $86,520 is only what that formula is today for a $721,000 reference. The band, the base fee, the LP boost, and Dutch size are all functions of that progress. They move on the next trade, poke, or price update. A reference that grows (the target becomes $120,000 at a $1,000,000 reference) lowers progress, and the curves step back up the same line: a wider band, a higher fee, a higher boost, and a larger Dutch slice. A reference that shrinks raises progress and the curves step down. The 30-minute half-life on reference TVL is what keeps a flash deposit in the reference pool from moving them in one block.

Graduated status is reversible, and the only buffer is time. The line is 100% of the live target in both directions. There is no percent band. `aboveSince` starts the first time a swap, a deposit, a redeem, a poke, or a price update observes protocol inventory at or above that target. The first observation never flips status in the same call. Status turns on only when a later call sees the pool still at or above the target and `block.timestamp` is at least 77 minutes past `aboveSince`. Crossing back under the target before those 77 minutes elapse clears `aboveSince` and the window starts over.

`belowSince` starts the first time a graduated pool's spot TVL is strictly under that same target, whether the pool shrank or the reference grew. One dollar under the line is enough. The first under-reading does not flip. Status turns off only when a later call is still under the target and 77 minutes have passed. Crossing back to the target or above clears `belowSince`. The window is `GRADUATION_WINDOW`, 77 minutes, the same in both directions, and it is not a per-pool parameter. Seventy-seven minutes is longer than a flash loan or a same-block round trip. The depth band, the fee, the LP boost, and Dutch size do not wait on it. Time alone does not write storage. Someone has to call `poke(poolId)`, or trade, or deliver a price update. `poke` is permissionless, and any such call finalizes the flip once the window has elapsed.

While status is on, each fee splits 3,333 bps to the pool creator, 3,333 bps into permanent locked liquidity, and the remainder to LPs. Turning status off sends new fees entirely to LPs. Accrued creator fees stay claimable. There is no clawback. Locked liquidity already in the book stays locked. Turning status back on resumes the split. Idle USDG stays in the pool. The hook does not lend it out.

Toggling the flag is not a profitable trade. The depth band, the fee, the boost, and Dutch size follow spot progress and ignore the flag, so flipping status does not change the quote. The flag moves only after 77 continuous minutes, so a one-block deposit or a one-block withdrawal starts a clock and does not flip it. Pulling that liquidity back before the window ends clears the clock. The caller of `poke` receives nothing. The creator share is paid to the wallet stored at creation, and the locked share cannot be withdrawn, so pausing the split does not pay the toggler.

Disciple pools are not migrated onto `AscensionHook`. That contract is the 1% fee hook of the bonding-curve product. `Migration.sol` creates a v4 pool for that product, and `Migration.t.sol`'s `test_graduation_creates_v4_pool` covers that path. Disciple never calls it. Reversible status lives entirely in `DiscipleHook`, and there is no hook address to move back.

## Bridge view

`bridgeQuote(poolId)` returns the anchor, the pool price, the signed gap, the signed coin-versus-USDG imbalance, the progress fee, and stale / graduated flags. A future OFT can read this from `_debitView`. The bridge is not in this contract. The fee in that struct is not a bridge-fee quote. v1 assumes the bridge fee is 0%.

`arbQuote(poolId)` returns the exact-in size and direction that maximizes mark-to-anchor profit after the fee a swap would charge right now, using the same Dutch-or-curve path as `beforeSwap`. `buyCoin` means spend USDG to buy the coin. Amounts are raw token units, so a router can pass `amountIn` straight to `PoolManager.swap`. The size is the profit-maximizing one, not the largest size that is still green, and it is never a capped fill. `profitWad` is normalized USDG. A zero `amountIn` means the fee eats the gap; `buyCoin` still says which side of the anchor the pool is on.

## Defaults

| Knob | Value | Why |
| --- | --- | --- |
| Discount | 33% (0.67×), allowed 10–50% | The agreed launch gap. Explicit at creation. Gap 0 leaves it in place. |
| Seed floor | 50% of the original coin seed | Backstop so a deep book cannot give away the whole seed under the anchor. The natural climb hits the anchor at ~18%, so day-one buys are not stuck. Binds on Dutch fills. |
| USDG floor | 20% of the principal baseline, pinned | High-water mark, one-day decay. Same-second sells share it. Redeems stop at it. |
| Band | ±25% at or below $100 TVL, ±3.33% at the live target | Linear in ln(TVL). On an $86,520 example target the log midpoint (~$2,941) is about ±14.2% and $10k is about ±10.2%. The endpoint moves with the smoothed reference. Unknown graduation does not deepen. |
| Tail | `TAIL_K = 8e18`, exponent 30 | Emptying a side costs about 8/31 ≈ 26% extra on top of constant product. |
| Fee | 200 bps → 30 bps | The whole fee. 2% while tiny, linear in pool TVL to 0.3% at the live target. No volume multiplier. No gap term. No stale multiplier. |
| Dutch drift | ~1% of the anchor per hour | Default when create passes 0. Allowed about 0.1% to 10% per hour. Fixed for the life of the pool. |
| Dutch edge | $0.25 at a 100% gap | Size is edge/gap, then capped. |
| Dutch slice | min($50, max(TVL/20, $1)), then × progress | Safety cap first. Progress scales it from 100% at a new pool to 20% at the live target, and a higher target scales it back up. The ask price stops at 1% of the anchor. The size uses the raw gap. |
| Direction | none | Buys and sells pay the same fee. Closing a gap is not discounted. The gap itself is the incentive. |
| Stale | 30 minutes | Matches the TWAP window. Quotes still return. Every kind's curve trade reverts until a poke lands. Redeems do not. The fee does not change. |
| Boost | 5× → 1.2× at the live target | Linear in progress. Early LPs earn more of the fee. While pool TVL is at or above the live target the weight stays 1.2×. A higher target puts it back on the line. Principal is excluded. |
| Graduation target | 12% of smoothed reference TVL | Moves with the reference. $86,520 is only the example for a $721k reference, and the seed test still asserts that constant. |
| Graduation window | 77 minutes, fixed | Continuous time on one side of the live target before status flips. At or above turns it on. Strictly below turns it off. The same wait either way. One threshold, 100%. Not set per pool. Progress curves do not wait on it. |
| Creator | 3,333 bps of fees while status is on | Fixed wallet from creation. Not principal. Pauses when status turns off. Accrued fees stay claimable. |
| Locked liquidity | 3,333 bps of fees while status is on | Inside the book. Raises spot and TVL. Not a share. A sell cannot spend it and a redeem cannot take it. It does not unlock when status turns off. |
| Share offset | 1e6 | Virtual shares/assets against inflation. |
| Outflow | 20% per hour when the creator passes zeros | A window is one block or one hour. The cap cannot be turned off. |
| Anchor | Chosen per pool: v2, v3, or v4 | Same chain only. Factories and the full v4 `PoolKey` are checked on every read. |

## Recommended $77 seed

100% coin, 0 USDG inside the curve. At a $1 anchor that is `77e18` coin units and `0` USDG.

For JESUS at $0.0000000136 that seed is `77e18 / 13_600_000_000` = `5,661,764,705.882353` tokens (`5661764705882352941176470588` in 18-decimal wad, about 5.6618e9 JESUS). The curve still stores `77e18`, because the anchor in the seed test is normalized to $1 and a coin unit is one dollar of JESUS. The address is documentation. The hook does not branch on it.

The 0.67× price is virtual USDG (`vy ≈ 0.67 × anchor × coin`). Putting real USDG in the $77 does not set the discount, and it is the first thing a dump tries to take.

The constant `GRAD = 86520e18` in `test_recommendedSeedIsAllCoin` is that example target (12% of $721k). The live target in the hook is 12% of the smoothed reference, not this constant.

## Simulator

`test/bridge/DiscipleSim.t.sol` runs the real curve. `SIM_RESULTS_PARTIAL.md` is an earlier moving-anchor campaign. That campaign's recommendation was to ship a volume-based fee and leave the Dutch auction in the simulator. That recommendation is not the product. The hook ships the progress-only fee and the two-sided Dutch auction described above.

`SIM_RESULTS_V2.md` is the earlier study. It was not re-run after the window became a fixed 77 minutes, after idle-USDG lending was removed, or after the graduated fee became thirds with no builder share. The file's numbers, including any yield it credits, are that older run. Rank in that file is the first day status turns on, then day-365 TVL. The volume fee in that file is a study input. The hook charges the progress slide, and the curve has no quote-fee override. `test_simV2` runs only when `SIM_V2=1`. It is outside the contract tests.

## Deviations from the wording of the spec

These are called out here rather than quietly "fixed."

1. OpenZeppelin's single-pool hook bases are not used. Same accounting pattern, multi-pool, on the pinned v4-core.
2. There is no LayerZero read. The anchor is a same-chain v2 pair, a same-chain v3 `observe`, or a v4 pool this hook samples itself. An external price source implements `IDisciplePriceAddon` and writes into one of those pools. The hook does not call the add-on.
3. A v4 swap cannot be partial-filled without moving `slot0`. Oversized exact-in reverts. `quoteExactIn` returns the capped size so a router can cut the dump short. Exact-out reverts.
4. USDG deposits that would freeze the launch discount revert until spot reaches the anchor. Smaller USDG deposits that only replace virtual USDG are accepted. This blocks "deposit depth, buy the seed at a stuck 0.67×, withdraw the depth."
5. A redeem's USDG fee uses the same split as a swap. Before graduation the whole USDG fee goes to the LP fee pot. While graduated it is 3,333 bps creator, 3,333 bps locked, and the remainder to LPs. Dust stays in the LP share. The LP share is the part that enters the fee index. The coin portion of a redeem fee stays in protocol coin inventory. Locked USDG from the redeem is not folded into principal when the last LP leaves.
6. Graduated status is reversible on a fixed 77-minute window, the same in both directions, and not set per pool. The line is 100% of the live target both ways. There is no percent band, because a band under 100% would leave a stretch with status still on and no arb pull back to the line. Spot TVL drives the depth band, the fee, the boost, and Dutch size immediately on either side of the flag. The window gates the fee split: thirds to the creator and to locked liquidity, remainder to LPs, while status is on, and 100% to LPs while it is off. A Disciple pool stays on `DiscipleHook`. `test_graduation_creates_v4_pool` belongs to the bonding-curve migration onto `AscensionHook` and is not a Disciple path.
7. Depth only grows, and only once spot is at or above the anchor.
8. A same-chain read is applied as read. There is no 20% band and no keeper. A stale quote blocks the swap until `poke`. A v3 `observe` that fails, or a ring that is not warm yet, leaves the stored anchor alone.
9. The g^30 tail is ~0 until a trade is most of a side. On USDG, the 20% floor binds first.
10. Same-block LP protection does not roll the live spot back. A dust deposit must not erase a trade. Fresh liquidity is escrowed for the block; the trade's price stays.
11. The Dutch auction is in the contract. An earlier simulation left it out and shipped a volume fee instead. The volume fee is not in the contract.
12. v4 self-sample TVL is a zero-width liquidity proxy, not token balances. The price is a 30-minute TWAP of a tick carried from a previous block, with no spot fallback. A same-transaction push does not enter it.

## Open risks

- Reference-pool trust. The hook believes the v2 factory, the v3 factory, and the v4 PoolManager it was deployed with. A pool that passes `getPair`, `getPool`, or `toId` is the price. There is no admin circuit breaker, on purpose. The 30-minute window is what limits a one-block print.
- `slot0` of a Disciple pool is meaningless. Integrators that price off the pool's sqrt price will be wrong. The self-sample path does read `slot0` of a different, reference v4 pool.
- No token rescue. Tokens sent to the hook by mistake stay there.
- Fee-on-transfer tokens break claim settlement. The hook assumes a standard ERC-20 and uses a balance diff on seed and deposit.
- The reference pool is fixed at creation and is trusted for its reading. A v3 pool with a short cardinality pauses trading rather than falling back to spot. Balance-based v3 TVL can be inflated by donating tokens to the reference pool. Self-sampled v4 TVL can be inflated with in-range liquidity. Either raises or lowers the graduation target. Neither replaces the 30-minute TWAP with a spot print. The creator's choice of reference is the trust assumption, the same as picking a v3 pool.
- The hook's ERC-6909 USDG claims are one balance. `usdgHeld` is per pool, and a debit that exceeds that pool's own USDG reverts. A bug that skipped the check could spend another pool's USDG.
- Redeem and the fee index round down in favor of the pool. A sell-then-buy of the same coins loses at least one wei before fees, and the fees make the round trip strictly worse.
- Same-block fee credit is paid on the next block, to shares that were already held. `pendingFee` shows it early. Redeeming in the fee's own block forfeits that block's fee.
- The hook and the four libraries share one storage layout, and it lives in the hook. The libraries add no state of their own. Their addresses are fixed in the bytecode, so a bug in one of them cannot be patched. A direct call runs the code against the library's own empty storage and moves no hook tokens.
- A Dutch quote can sit far from the anchor. The slice cap, the tail, the seed floor, and the USDG floor are what stop one taker from emptying the book. They do not stop a sequence of takers from walking it if each one waits for a new gap.

## Not in this version

The following were asked about and are deliberately not built:

- An admin pause. A stale anchor reverts the swap. That is the only stop.
- A lower fee for small trades.
- On-chain progress or milestone tracking.
- Gap events.
- A bridge-fee control, and an arb bot. The bridge fee is assumed to be 0%.
- A migration from this hook to `AscensionHook`. Disciple pools are not moved there on graduation, and turning status off does not need a migration to reverse.
- Lending idle USDG. The hook bootstraps the LP. Idle USDG stays in the pool.
- Overshoot / relist, a LEVAMM value-mix quote, and a fee-funded drip. Those exist only in the simulator.

The Dutch bid and ask are in the hook. The volume-based fee is not.
