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

The curve starts 33% below the anchor (0.67×) and climbs toward it as buyers add USDG. The discount is the same for every pool. `CreateParams.discountBps` is ignored. Both Dutch gaps accrue at one fixed linear rate and are capped at 77% of the anchor, so the ask stays positive. A buy consumes the ask gap in proportion to its USDG size and restarts the bid at zero. A sell consumes the bid and restarts the ask. There is no slice cap and no per-block cap. The seed guard, the tail, and the same-block LP rules still bind. There is no USDG price floor and no outflow cap.

The progress fee slides from 2% at TVL 0 to 0.30% at the live graduation target. It does not rise with the gap, with volume, or because the anchor is stale. Before graduation every trade also pays an arb fee: 77% of any price improvement versus the anchor, on the part of the fill that beats the source, measured after the sliding fee. The arb fee is in addition to the sliding fee. The rule that the fee cannot exceed the improvement applies to the arb portion alone. The two together can be larger than the improvement, for example a 2% sliding fee plus a 0.77% arb fee on a 1% improvement. A trade that does not beat the anchor pays no arb fee and still pays the sliding fee. Before graduation both fees compound into the pool for LPs. There is no creator or locked split on either of them. While the pool is graduated, the arb fee is off and only the 0.30% base fee applies, split 3,333 / 3,333 / 3,334. If the pool later drops out of graduation, the arb fee comes back on in that same call.

Graduation flips in the call that crosses the line, in either direction. There is no 77-minute window. Pool TVL for that check is every coin and every USDG in the book, LP deposits included (`anchor * x + y`). The target is 12% of the smoothed reference TVL. A target of 0 is below the line, so a graduated pool drops out. The fee, the LP boost, and the arb fee all follow that status and the live progress on the same call.

A swap refreshes the anchor and then checks staleness. A healthy source proceeds. `Stale` is only for a refresh that did not write `updatedAt`, which is a broken source or one under the $12,000 in-range minimum. Redeems do not read the oracle.

There is no admin, owner, builder, delegate, allowlist, setter, or rescue. Floor, outflow, and Dutch drift on `CreateParams` are ignored. The current creator recipient can call `transferCreator` at any time and pass the fee wallet to a non-zero address. Nobody else can. Nobody can pause trading.

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
- Seed note: the seed guard uses `seedFloor`, `initialSeed`, and `maxCoinOut`. It does not read a principal peak. The peak was removed with the USDG floor.
- There is no price band and no `deepen`. Virtual reserves move only to hold a quote: a deposit, a redeem, or putting a Dutch fill back on the resting spot. The removed band was linear in ln(TVL):

  `band = 0.25 − (0.25 − 0.0333) · ln(v / 100) / ln(grad / 100)`.

  Each doubling of TVL takes the same bite out of the band. The endpoint moves with the live target, which is 12% of the smoothed reference TVL. The dollar examples below use the old static example, graduation at $86,520 (12% of a $721k reference). On that target the log midpoint (~$2,941) is about ±14.2%, and $10k is about ±10.2%. The effective USDG book is `TVL / band`. A $100 pool is about a $400 book. At the $86,520 example, graduation is `TVL / 3.33%`, about $2.60M of virtual USDG. A swap walks toward that book by at most the clip's USDG notional divided by the current band. One buy cannot jump the launch virtuals to the target and sell the difference back. Sells quote the book the last buy already traded. Enough flow settles on the band. Direct `deepen` still applies the whole step. Unknown graduation (no reference TVL yet) does not deepen: the band stays ±25%.
- Tail: extra cost `base · (TAIL_K / WAD) · f^31 / 31`, with `f = amount / side` and `TAIL_K = 8`. Same 1e36 power style as `CurveMath`. Negligible until a trade is most of a side, then sharp. Buys round cost up, sells round proceeds down.
- Audit G-7: sell proceeds are clamped so buying the same coins back costs at least one wei more.

TVL for fees, the boost, Dutch depth, and graduation is `coin · anchor + USDG`. The USDG figure is that pool's own book. Never the pool's own spot. Each pool also tracks `usdgHeld`, the normalized USDG it may draw from the hook's ERC-6909 claims. A buy or a USDG deposit credits that pool. A sell, a redeem, and a creator claim debit it, and the debit reverts if it would exceed what that pool holds. The claims are one fungible balance, so this counter is what stops a redeem or a swap in one pool from spending another pool's USDG. Fees that stay in the book remain inside `usdgHeld` until they are paid out. Locked liquidity stays inside the curve's USDG. `reserveOk` requires `usdgHeld` to cover the curve's USDG and the creator accrual.

## Fees

Both sides pay the same bps in USDG. Direction does not change the fee. There is no discount for a gap-closing trade and no extra charge for opening one.

The sliding fee is `BridgeFee.baseFeeBps(poolTvl, liveTarget)`. It is 200 bps (2%) at TVL 0 and slides linearly in TVL to 30 bps (0.30%) as pool TVL reaches the live target. At or above the target the fee is 0.30%. If the target is still 0 (no reference TVL yet) the fee stays at 2%. Before graduation an arb fee is added on top. It is not a replacement for the slide.

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
| Creator | 3,333 bps of the graduated base fee. Claimable by the current recipient. `transferCreator` moves that wallet. Before graduation the creator share is zero |
| LPs | 100% before graduation. While graduated, the remainder after creator and locked (3,334 bps), auto-compounded |
| Locked liquidity | 3,333 bps of a graduated fee. Stays in the book, raises depth, and cannot be sold or redeemed. Nobody holds a share of it |

Before graduation, and again after status turns off, the whole fee compounds into the book.

Rounding uses floor division on the creator and locked shares. The LP share is whatever is left, so dust stays with LPs. A redeem pays the same progress fee. Its USDG portion uses this split. Its coin portion stays in protocol coin inventory. The LP portion of a redeem fee is what enters the fee index. Locked liquidity from a redeem is added to `lockedY` and is not folded into principal when the last LP exits.

## Dutch auction

Each pool stores a remaining `bidGap` and `askGap`, both in WAD, and one `dutchAt` timestamp. Create starts both gaps at zero. A quote does not write them. A USDG deposit of size X calls `moveDutch` before `addLiquidity`, with the pre-deposit TVL, and moves both gaps exactly as a buy of X USDG. No coin moves through a swap. A coin-only deposit does not move the gaps. A mixed deposit uses the USDG portion. A redeem does not touch the gaps.

Both gaps accrue from `dutchAt` at `DUTCH_RATE = uint256(0.77e18) / 12 hours`, then cap at `DUTCH_GAP_CAP` (0.77e18). Integer division means exactly 12 hours lands a few wei under 77% before the cap. `CreateParams.dutchDrift` is ignored. There is one rate for every pool and both sides.

From the anchor:

- the bid (USDG the pool pays for coin) is `anchor * (1 + gap)`;
- the ask (coin sold for USDG) is `anchor * (1 - gap)`. The 77% cap keeps the ask positive.

A fill consumes the taken side against pool depth `D = anchor * x + y`. For a clip `q < D`, the gap ends at `gap * (D - q) / D` and the fill is quoted at the average of the start and the end. If `q >= D`, the gap ends at zero and the average is `gap * D / (2 * q)`. A buy's `q` is the USDG in. A sell's `q` is `coinIn * anchor / WAD`. The other side is reset to zero. A dust fill consumes its share and still resets the other side. Splitting a clip cannot repeat the full gap. There is no per-block cap and no minimum slice.

The whole clip is retargeted to that average Dutch price when the Dutch price is better than the resting spot, filled, then retargeted back to the resting spot. That second retarget wipes the resting-spot impact of a Dutch fill. If the Dutch price is not better, or the seed guard caps the fill, the trade walks the curve and the gap is still consumed.

`dutchQuote(poolId)` returns the accrued ask gap, both prices, both depths, and the progress fee. The depth is the TVL that would consume the gap, not a slice cap. `dutchState(poolId)` returns the accrued bid gap, the accrued ask gap, and `dutchAt`. `quoteExactIn` accrues the stored gaps inside `advanceDutch`, the same way the swap does, so it does not accrue twice. `arbQuote` uses the accrued gaps.

## Arb fee

`ARB_FEE_BPS` is 7,700. It applies only while the pool is not graduated, and it comes back the moment status turns off. The improvement is measured after the sliding fee.

- Buy: if `coinOut * anchor / WAD > usdgIn`, the improvement is the difference. The arb fee is 77% of it, taken by returning fewer coins. Those coins are split into `lpX` and `protoX` with the same boost weights as a pre-graduation fee.
- Sell: if `usdgOut > coinIn * anchor / WAD`, the improvement is the difference. The arb fee is subtracted from `usdgOut` and compounded into the pool on that same path. None of it is creator or locked.

`f.fee` stays the sliding fee. `f.arb` is separate. 7,700 bps cannot exceed the improvement. The sliding fee is not subtracted from that budget, so the combined charge can exceed the improvement. That edge is intentional.

## Anchor source

Chosen once, in `createPool`, and never changed. A kind above 2, or a reference that fails the check for its kind, reverts `BadCreate`.

| Kind | Value | Where the 30-minute price comes from |
| --- | --- | --- |
| `ANCHOR_V2` | 0 | Same-chain pair. `factory.getPair(coin, USDG)` must be `refPool`. The pair must be witnessed for 7 days and show at least $12,000 of token balances. The trading price is a TWAP of cumulative prices from completed intervals. Reserves are the create-time size gate only, not the anchor. A cold ring leaves the anchor at 0. |
| `ANCHOR_V3` | 1 | Same-chain pool. `factory.getPool(coin, USDG, refFee)` must be `refPool`. `fee == 0` fails that lookup. That is not a fee cap. Create calls `increaseObservationCardinalityNext(1800)` and requires `observe(7 days)` and `observe(30 minutes)` to succeed. The trading read is `observe([30 minutes, 1])` divided by 1799 seconds. TVL is in-range `liquidity()` at the TWAP sqrt. |
| `ANCHOR_V4` | 2 | Same-chain pool. The creator passes the full reference `PoolKey`. Create and every sample require `PoolKey.toId() == refPoolId`. The hook must be absent or must lack `BEFORE_SWAP_RETURNS_DELTA` (`1 << 3`). An afterSwap fee hook is allowed. There is no fee cap, including fee 0. The source must be witnessed for 7 days and show at least $12,000 of in-range liquidity. The price is this hook's ring of past-block ticks. There is no per-sample move cap. |

There is no cross-chain kind and no external oracle-hook kind. The hook never takes a price from the caller.

A swap calls `_persist` and then reverts `Stale` only if `updatedAt` is still missing or 30 minutes old. A healthy source refreshes and the swap proceeds. A source under $12,000 does not refresh, so it goes stale. `quoteExactIn` and `bridgeQuote` still return, and the fee does not change. Redeems are not gated by that check and do not read the oracle: a reverting or zero reference cannot freeze a withdrawal. Deposits still require a live anchor.

Pool creation is permissionless, multiple pools per coin. Anyone can create a pool for any coin. The `creator` argument is the fee wallet stored on that pool. Any non-zero address is accepted, it is not compared to the caller, and there is no creator allowlist. `tickSpacing` of 0 is 60. Any other spacing in range is a different pool for the same coin. Every create still goes through the reference checks above.

Swap hookData may name the recipient of a swap-to-LP mint. `address(0)` means the swap initiator. That initiator pays the input, so the recipient is a gift of their own proceeds. Someone else's swap cannot be redirected. The hook has no `receive`. Sending ETH reverts. There is no rescue.

**v2.** Completed intervals of `price0CumulativeLast` / `price1CumulativeLast` become ticks in the same ring the v4 path uses. If `blockTimestampLast == block.timestamp`, the pair already accrued the pre-swap reserves and the current reserves are not added. One sample per timestamp. TVL is the pair's token balances valued at the ring price. The reserve spot is used only to decide whether create clears $12,000. A cold ring leaves the anchor at 0. Age is `witnessSource`: the first call records `seenAt`, and create requires 7 days after that. An attacker can only start the clock earlier.

**v3.** The reference is a Uniswap v3 pool of this coin and the hook's quote token. Trading calls `observe([30 minutes, 1])` and divides by 1799. `secondsAgo = 0` is not used, so the current block is not in the average. TVL is in-range liquidity at the TWAP sqrt, not token balances and not `slot0`. A donation of tokens does not move it. Create grows cardinality to 1800 and reverts unless `observe(7 days)` and `observe(30 minutes)` both succeed. A WETH-quoted v3 pool is not priced as dollars. Deploy the hook with the numeraire that pool quotes.

**v4.** v4 has no `observe`. The hook keeps a ring of 2048 observations, keyed by this hook's own pool id, in the hook's storage (`rings`, `obs`). The sampling math is inlined into `DiscipleAnchor`. The hook writes the ring. The creator does not pass a bare pool id. The hook rebuilds the `PoolKey` from the coin, USDG, fee, tick spacing, and hooks, and requires `toId()` to match. Which side is the coin is `coin < USDG`, stored once.

The ring packs a `uint32` timestamp and an `int56` tick cumulative into one word. The current `slot0` tick is pending only. Consult projects `lastTick`, a tick installed from a previous block, and never the pending tick. The first sample in a block wins. A later sample in the same block does not replace it, so a push, poke, and push-back cannot change the price returned in that transaction. A later block accrues the previous `lastTick` over the elapsed time, then installs the old pending tick for future intervals and stores the new `slot0` as pending. There is no per-sample move cap. The poisoned pending tick can color the interval after the confirming sample until the sample after that. That residual is accepted. The mean is not ready until three samples exist and the oldest is at least 30 minutes old. Create still succeeds before that, the anchor stays 0, and swaps revert `NoAnchor`. At create, before any past sample exists, the current sqrt price is a size gate only. There is no spot fallback for trading. Price conversion is `TickMath.getSqrtPriceAtTick` and then the same Q64.96 fraction `BridgeV3Anchor` uses.

TVL on the v4 path is a proxy, not the PoolManager's token balances. It is the quote side of a zero-width in-range position, doubled so both sides are counted in the quote: `amount1 = L × sqrtPriceX96 / 2^96`, `amount0 = L × 2^96 / sqrtPriceX96`. If the coin is token0, raw TVL is `2 × amount1`. If the coin is token1, raw TVL is `2 × amount0`. That raw amount is normalized with the quote token's decimals. Liquidity 0 or `sqrtPriceX96 == 0` (uninitialized) records nothing useful: TVL 0 leaves `gradTvl` at 0, and the band stays wide.

Someone can inflate in-range liquidity. The $12,000 check at create can be passed with a flash loan and then removed. Later persists refuse to refresh below $12,000, so the anchor goes stale after 30 minutes. That window is the residual. A same-transaction push does not enter the cumulative. The TVL reading is smoothed with a 30-minute half-life, at most 10 minutes of it per step. Graduation itself flips as soon as full-book TVL crosses 12% of that smooth. A two-step v4 attack can still paint the interval after a confirming sample, because there is no move cap.

### Add-on extension point

`IDisciplePriceAddon.refresh(bytes32 poolId)` is the extension point for a price source this hook does not read. The hook does not store the add-on's address, does not call it, and does not read a return value from it. An add-on that wants the hook to use a price puts that price into a same-chain v2, v3, or v4 pool, then calls `poke`. The hook only accepts the three reads above.

## Reference TVL

The first reference reading snaps into `smoothedTvl`. Later readings pull the error toward the new reading with a 30-minute half-life (`DiscipleMath.decayed`, which is `amount × 2^(−dt / 30 minutes)`). A zero `dt` does not move the smooth, so two reads in one second cannot jump it. `ethTvl` stays the last raw reading. The live target, `_gradTvl`, is `smoothedTvl × 12 / 100`, not 12% of the raw reading.

A reference that opens at $725k and is later reported as $20k is still near $725k after one capped step. Six hours is twelve half-lives. A sustained false reading has to be held through that smooth before the target follows it. Graduation then flips in the same call that full-book TVL is on the other side of the new target. A reference under $12,000 does not refresh the anchor.

## LP shares

`deposit` and a swap `hookData` of `abi.encode(bool mintLp, address recipient)` mint the hook's own shares. `mintLp = true` keeps the swap proceeds as shares instead of paying them out. Empty `hookData`, and an explicit `false`, pay the proceeds out exactly as a normal swap. This is not v4 `modifyLiquidity`. Shares use an ERC-4626-style virtual offset (`1e6`) so the first depositor cannot inflate the rate.

Deposits and redeems settle against the book from the start of the block. The first hook call in a block snapshots spot and LP reserves after the anchor sync and before the action. A same-block deposit is escrowed: redeeming it that block unwinds those tokens (minus the normal redeem fee), not a pro-rata slice of whatever a buy just pushed into the LP pot. Shares already held redeem against the opening reserves, and the redeem retargets to the live spot so the trade's price is not erased. Share mints use the opening NAV, so a buy in the same block does not change how many shares a deposit gets.

Fees work the same way. A swap parks the LP's fee until the next block and then divides it by the shares that existed at the open (same-block mints are not in the denominator). A deposit, buy, and redeem in one transaction, including inside a flash loan, cannot collect the 7x fee weight. The parked fee is visible from `pendingFee` for shares that were already settled. If nobody eligible still holds when the block rolls, that fee moves to protocol inventory.

The 7x to 1.2x boost (linear in TVL, finished at the live target, then stuck at 1.2x) multiplies the LP's weight when a fee is split into the fee index. It is not applied to principal. An early LP whose anchor-value matches the protocol seed has weight 7 against the seed's weight 1, so about 7/8 of the fee, and none of the principal. Before graduation the arb fee uses the same weights. A depositor who trades against themselves and redeems gets back less than they put in.

A deposit is never rejected for size. `addLiquidity` retargets so the quote does not jump. A USDG deposit also moves the Dutch gaps the way a buy of that USDG would, before the liquidity is added. Coin deposits do not move the gaps.

No lock. Redeem any time. A same-block redeem of a fresh deposit returns the escrow. A redeem pays a pro-rata share of both assets and is not blocked by a floor. LP deposits count toward graduation TVL, and status flips in the deposit or redeem that crosses the line.

## Inventory

There is no USDG floor and no outflow cap. A sell can spend principal (`protoY + lpY`) down. `feePot` and `lockedY` are not principal, so a sell cannot spend them. An exact-in larger than that inventory is capped. Passing the uncapped size to v4 reverts, because v4 cannot partial-fill an exact-in swap here. Exact-out is unsupported. A redeem is a pro-rata share of both assets and does not revert for a floor. The seed guard is separate: it still stops a buy from taking the last half of the original seed while spot is below the anchor.

## Graduation

Progress is pool TVL divided by 12% of smoothed reference TVL. Pool TVL is `anchor * x + y`, LP deposits included. The fee and the LP boost follow that progress on the next trade, deposit, redeem, or poke. There is no price band and no Dutch slice, so a higher target raises the fee and the boost. It does not open a larger Dutch clip.

Status flips in the call that crosses 100% of the live target, in either direction. There is no `aboveSince`, no `belowSince`, and no 77-minute window. A target of 0 is below the line. While status is on, the arb fee is off and the 0.30% base fee splits 3,333 bps to the current creator recipient, 3,333 bps into permanent locked liquidity, and the remainder to LPs. While status is off, the sliding fee and the arb fee both compound for LPs. Accrued creator fees stay claimable. Locked liquidity already in the book stays locked. `poke` pays the caller nothing.

Disciple pools are not migrated onto `AscensionHook`. That contract is the 1% fee hook of the bonding-curve product. Reversible status lives entirely in `DiscipleHook`.

## Bridge view

`bridgeQuote(poolId)` returns the anchor, the pool price, the signed gap, the signed coin-versus-USDG imbalance, the progress fee, and stale / graduated flags. A future OFT can read this from `_debitView`. The bridge is not in this contract. The fee in that struct is not a bridge-fee quote. v1 assumes the bridge fee is 0%.

`arbQuote(poolId)` returns the exact-in size and direction that maximizes mark-to-anchor profit after the fee a swap would charge right now, using the same Dutch-or-curve path as `beforeSwap`. `buyCoin` means spend USDG to buy the coin. Amounts are raw token units, so a router can pass `amountIn` straight to `PoolManager.swap`. The size is the profit-maximizing one, not the largest size that is still green, and it is never a capped fill. `profitWad` is normalized USDG. A zero `amountIn` means the fee eats the gap; `buyCoin` still says which side of the anchor the pool is on.

## Defaults

| Knob | Value | Why |
| --- | --- | --- |
| Discount | 33% (0.67x), fixed | Every pool. `CreateParams.discountBps` is ignored. |
| Seed floor | 50% of the original coin seed | Backstop so a deep book cannot give away the whole seed under the anchor. The natural climb hits the anchor at ~18%, so day-one buys are not stuck. Binds on Dutch fills. |
| USDG floor | none | Removed. Sells and redeems are not blocked by a price floor. |
| Band | none | Removed. The book is constant product plus the tail. |
| Tail | `TAIL_K = 8e18`, exponent 30 | Emptying a side costs about 8/31 ≈ 26% extra on top of constant product. |
| Fee | 200 bps to 30 bps, plus 77% of improvement before graduation | The slide is always charged. The arb fee is extra, only while not graduated, and comes back if status turns off. Both compound for LPs before graduation. |
| Dutch rate | 77% of the anchor in 12 hours, both sides | Fixed. Capped at 77% so the ask stays positive. Exactly 12 hours is a few wei short of the cap. |
| Dutch edge | none | Removed with the slice cap. |
| Dutch consumption | proportional to size / pool TVL | Every fill, including dust. A buy consumes the ask and resets the bid. A sell consumes the bid and resets the ask. A USDG deposit does the buy's clock update only. |
| Direction | none | Buys and sells pay the same fee. Closing a gap is not discounted. The gap itself is the incentive. |
| Stale | 30 minutes | The swap refreshes first. `Stale` means the refresh did not write `updatedAt`. Redeems do not read the oracle. |
| Boost | 7x to 1.2x at the live target | Linear in progress. Fee weight only, including the pre-graduation arb fee. Principal is excluded. |
| Graduation target | 12% of smoothed reference TVL | Moves with the reference. $86,520 is only the example for a $721k reference, and the seed test still asserts that constant. |
| Graduation | immediate, both directions | Full-book TVL, LP deposits included. Target 0 is below the line. |
| Creator | 3,333 bps of the graduated base fee | `transferCreator` by the current recipient only. Not principal. Pauses when status turns off. |
| Locked liquidity | 3,333 bps of fees while status is on | Inside the book. Raises spot and TVL. Not a share. A sell cannot spend it and a redeem cannot take it. It does not unlock when status turns off. |
| Share offset | 1e6 | Virtual shares/assets against inflation. |
| Outflow | none | Removed. |
| Anchor | v2, v3, or v4, past blocks only | $12,000 in range, 7 days old. No per-sample move cap. v4 hook must not return a beforeSwap delta. |

## Recommended $77 seed

100% coin, 0 USDG inside the curve. At a $1 anchor that is `77e18` coin units and `0` USDG.

For JESUS at $0.0000000136 that seed is `77e18 / 13_600_000_000` = `5,661,764,705.882353` tokens (`5661764705882352941176470588` in 18-decimal wad, about 5.6618e9 JESUS). The curve still stores `77e18`, because the anchor in the seed test is normalized to $1 and a coin unit is one dollar of JESUS. The address is documentation. The hook does not branch on it.

The 0.67× price is virtual USDG (`vy ≈ 0.67 × anchor × coin`). Putting real USDG in the $77 does not set the discount, and it is the first thing a dump tries to take.

The constant `GRAD = 86520e18` in `test_recommendedSeedIsAllCoin` is that example target (12% of $721k). The live target in the hook is 12% of the smoothed reference, not this constant.

## Simulator

`test/bridge/DiscipleSim.t.sol` runs the real curve. `SIM_RESULTS_PARTIAL.md` is an earlier moving-anchor campaign. That campaign's recommendation was to ship a volume-based fee and leave the Dutch auction in the simulator. That recommendation is not the product. The hook ships the progress-only fee and the two-sided Dutch auction described above.

`SIM_RESULTS_V2.md` is the earlier study. It was not re-run after graduation became immediate, after the Dutch slice cap was removed, or after the graduated fee became thirds with no builder share. The file's numbers, including any yield it credits, are that older run. The simulator's Dutch offer size is a local copy of the removed slice cap so the year-long model still runs. The hook does not use that cap. `test_simV2` runs only when `SIM_V2=1`.

## Deviations from the wording of the spec

These are called out here rather than quietly "fixed."

1. OpenZeppelin's single-pool hook bases are not used. Same accounting pattern, multi-pool, on the pinned v4-core.
2. There is no LayerZero read. The anchor is a same-chain v2 pair, a same-chain v3 `observe`, or a v4 pool this hook samples itself. An external price source implements `IDisciplePriceAddon` and writes into one of those pools. The hook does not call the add-on.
3. A v4 swap cannot be partial-filled without moving `slot0`. Oversized exact-in reverts. `quoteExactIn` returns the capped size so a router can cut the dump short. Exact-out reverts.
4. A USDG deposit is not rejected for size. It retargets so spot does not jump, and it moves the Dutch gaps as a buy of that USDG would.
5. A redeem's USDG fee uses the same split as a swap. Before graduation the whole USDG fee goes to the LP fee pot. While graduated it is 3,333 bps creator, 3,333 bps locked, and the remainder to LPs. Dust stays in the LP share. The LP share is the part that enters the fee index. The coin portion of a redeem fee stays in protocol coin inventory. Locked USDG from the redeem is not folded into principal when the last LP leaves.
6. Graduated status flips in the crossing call. Full-book TVL, both directions, no time window. While on, the arb fee is off and the base fee is thirds. While off, the sliding fee and the arb fee compound for LPs. A Disciple pool stays on `DiscipleHook`.
7. The price band and `deepen` are gone.
8. A swap refreshes the anchor before the stale check. The price is a past-block price only. There is no per-sample move cap.
9. The g^30 tail is about 0 until a trade is most of a side. There is no USDG floor in front of it. Inventory still caps a sell at principal.
10. Same-block LP protection does not roll the live spot back. A dust deposit must not erase a trade. Fresh liquidity is escrowed for the block; the trade's price stays.
11. The Dutch auction is in the contract. An earlier simulation left it out and shipped a volume fee instead. The volume fee is not in the contract.
12. v4 self-sample TVL is a zero-width liquidity proxy, not token balances. The price is a 30-minute TWAP of past-block ticks. The first tick in a block wins. There is no move cap, so a poisoned pending tick can color the next interval.

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
- A Dutch quote can sit 77% from the anchor. Gap consumption, the tail, and the seed guard limit one fill. They do not stop a sequence of takers. The whole-trade retarget back onto the resting spot removes that fill's price impact. The sliding fee plus the arb fee can exceed the improvement. A v4 push can color the interval after the confirming sample. A flash $12,000 at create is caught only by the later stale window. v2 and v4 age is a witness clock, which an attacker can only start early.

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
