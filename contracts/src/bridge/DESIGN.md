# Disciple

Disciple is a Uniswap v4 hook that bootstraps a new liquidity pool from a tiny seed through incentivized arbitrage. It uses an onchain bonding curve anchored to an existing pool's price, compounds every fee back into the pool, and earns Morpho yield on idle USDG once the pool graduates.

The contract is `DiscipleHook`. Its engine is `DiscipleEngine`. Writes go through `DiscipleSwapFacet`, `DiscipleLpFacet`, and `DiscipleAdminFacet`, which share `DiscipleFacetBase`. The curve, fee, arb search, and storage libraries keep the `Bridge*` names (`BridgeCurve`, `BridgeFee`, `BridgeConstants`, `BridgeArb`, `BridgeV3Anchor`, `BridgeStorage`). `AscensionHook` is the post-graduation 1% fee hook. That name is a pure rename of the contract that used to be called `DiscipleHook`. The rename does not change its logic.

One immutable hook. Many coin/USDG pools. The first coin is JESUS
(`0x777A8DD86f0E29A28DAcf548Aebf42BB484daBBa` on Robinhood Chain). The hook does not
special-case that address.

Nothing here is deployed. Tests use mocks for LayerZero, the Ethereum pool, a Uniswap v3 pool, and Morpho.

## What it does

A coin that already trades somewhere gets a new fee-earning book. On Robinhood Chain that
coin is one that bridged in (JESUS is the first). The same hook also launches a book on the
chain where the coin already trades, anchored to a Uniswap v3 pool there, with no cross-chain
read. The team seeds about $77 of inventory. The hook quotes every trade. The quote starts
33% below the reference 30-minute TWAP and climbs to that anchor as buyers add USDG. When the
pool is large enough, the book flattens. The full-pool band starts at about ±25% and reaches
about ±1.2% only at graduation (12% of the reference pool's TVL, about $86.5k for JESUS).
A separate per-trade tail makes emptying either side expensive at every size.

There is no upgrade and no key that can move user funds, fees, or the price. Per-pool
settings (floor, launch discount, creator wallet, outflow cap, Morpho cap) are fixed at
creation except two narrow keys. The creator can point their fee wallet at a new address.
That only redirects their fee. A vault admin, set at creation and able to renounce itself,
can only pull the ERC-4626 position back into the pool, or replace that vault with another
ERC-4626 of the same USDG after a 48-hour public timelock. It cannot pause trading.

## Why the OpenZeppelin hook bases are not inherited

`BaseCustomCurve` / `BaseCustomAccounting` (OpenZeppelin Uniswap Hooks) are the right idea:
quote in `beforeSwap`, return a delta, and keep the hook's own liquidity as ERC-6909 claims.
They do not fit this repo:

- Current OZ imports `SwapParams` from `PoolOperation.sol`. This repo pins Uniswap v4-core
  v4.0.0 (`e50237c4`), which is before that refactor. The matching OZ tag (v1.0.0) is single-pool.
- This hook serves many pools from one deployment. A singular `poolKey` cannot do that.

The curve and the arb search live in `DiscipleEngine`, a stateless contract with no admin.
Swaps, LP accounting, and the vault admin live in three more contracts (`DiscipleSwapFacet`,
`DiscipleLpFacet`, `DiscipleAdminFacet`). The mined hook holds the storage and answers every
view itself. Anything that writes is a `delegatecall` to a facet, so the pool manager, the
vault, and the tokens still see the hook. Facet addresses are fixed in the hook constructor
and cannot be replaced. That split is what keeps every deployed contract under the 24kb
limit. The engine cannot move tokens. A facet holds none: it only runs as the hook.

So the same pattern is implemented directly on v4-core v4.0.0. v4 concentrated liquidity is
disabled (`beforeAddLiquidity` / `beforeRemoveLiquidity` revert). `slot0` is a dummy set at
tick 0 and is never read. The pool fee flag is dynamic, but the number v4 stores is not the
fee users pay. Real fees are USDG taken inside the quote, because a single v4 pips fee cannot
express a volume-dependent USDG fee that compounds into the book.

External `initialize` reverts. The hook initializes the pool itself; v4 skips
`beforeInitialize` on that self-call.

## Curve

Reserves are 18-decimal normalized. `spot = (y + vy) / (x + vx)`.

- Launch: `vx = 0`, `vy` so spot = anchor × (1 − discount). At 33% off, that is 0.67×.
  Real USDG is not required. The $77 seed is the coin the curve sells.
- The constant-product term reaches the anchor after selling about `1 − √0.67 ≈ 18%` of the
  seed. The price can then go through the anchor, which is what pays sellers to refill the coin.
- Seed floor: the last 50% of the original seed cannot be bought while spot is still below the
  anchor. On the launch virtuals this does not bind (the anchor is hit at ~18%). It binds if
  something makes the book so deep that the price cannot reach the anchor in time.
- Depth: once spot is at or above the anchor, virtual reserves grow with the TVL high-water
  and never shrink. The band is how far trading inventory worth the whole TVL moves the
  price. It is ±25% at or below $100 TVL and ±1.2% at that pool's graduation TVL. In between
  it is linear in ln(TVL): each doubling of TVL takes the same bite out of the band. With
  graduation at $86,520 the log midpoint (~$2,941) is still ±13.1%, and $10k is about ±8.8%,
  not the old ±3.33%. The effective USDG book is `TVL / band`. A $100 pool is about a $400
  book. Graduation is `TVL / 1.2%`, about $7.2M of virtual USDG on an $86.5k pool. A swap
  walks toward that book by at most the clip's USDG notional divided by the current band.
  One buy cannot jump the launch virtuals to the target and sell the difference back. Sells
  quote the book the last buy already traded. Enough flow settles on the band. Direct
  `deepen` still applies the whole step.
- Tail: extra cost `base · (TAIL_K / WAD) · f^31 / 31`, with `f = amount / side` and
  `TAIL_K = 8`. Same 1e36 power style as `CurveMath`. Negligible until a trade is most of a
  side, then sharp. Buys round cost up, sells round proceeds down.
- Audit G-7: sell proceeds are clamped so buying the same coins back costs at least one wei more.

TVL for fees, graduation, and the boost is `coin · anchor + USDG`. Never the pool's own spot.

## Fees

Both sides pay the same bps in USDG. Direction does not change the fee. There is no discount
for a gap-closing trade and no extra charge for opening one.

The growth cap is the old base schedule: 2% at TVL 0, linear in TVL to 0.3% at graduation.
That cap is what a hot pool pays. A quiet pool pays a 0.3% floor at any size. At and after
graduation the cap has met the floor, so the fee is 0.3%. Between the floor and the cap the
fee is linear in recent volume.

Recent volume is an accumulator. Each trade adds its USDG notional, including the trade
being quoted, and the sum decays with a one-hour half-life (`2^(-dt / halfLife)`). The red
line is half of the fee denominator: decayed volume of `0.5 × TVL` pins the fee at the cap.
The denominator is the block-open TVL when that is smaller than the current TVL, so a
same-block deposit cannot inflate TVL and cheapen the clip. The accumulator only grows when
a trade adds notional and only shrinks by time. A wash can raise the fee. It cannot lower
it. A pile-in during a quiet stretch pays more on the later clips of the same burst, because
each clip is already in the sum the next clip reads.

Half-life and red line are fixed at creation. Passing 0 uses the defaults (1 hour, 0.5×).
The resolved half-life must sit in [60 seconds, 7 days]. The red line must sit in [0.01, 10]
in WAD. There is no setter.

The stale multiplier is unchanged and still cross-chain only: 1× for 30 minutes, then linear
to 5× over the next 2 hours, hard cap 20%. The keeper tip and the creator cut are unchanged.
`bridgeQuote.suggestedFeeBps` is the rev fee a dust swap would pay right now, the same number
in both directions. It is not a subsidy for bridging coin in.

| | |
| --- | --- |
| Hot cap | 2% at TVL 0, linear to 0.3% at the graduation TVL. This is the fee when recent volume is at the red line. |
| Quiet floor | 0.3% when recent volume is ~0, and the fee at and after graduation |
| Red line | 0.5× the fee-denominator TVL. At or above it, the fee is the cap. |
| Half-life | 1 hour. A quiet hour forgets half the recent flow. |
| Stale | Cross-chain only. 1× for 30 minutes, linear to 5× over the next 2 hours, hard cap 20% |
| Keeper tip | Cross-chain only. 10% of each fee, budget capped at $10, paid $1 only when a read was stale |
| Creator | 10% of the fee, only after graduation. The only fee cut besides the keeper tip |

There is no protocol fee and no builder fee. In same-chain mode the keeper tip is zero, so
until graduation the whole fee compounds into the book.

The keeper calls `updatePrice()` and pays the native lzRead fee. The hook builds the read
calldata (`IEthAnchor.latest`). The sender never supplies a price. A fresh quote reverts, so
the tip cannot be farmed. The first read is allowed with a zero tip if nobody seeded the
budget; an optional `tipSeed` on create (or `fundTip`) covers that. Tip seed is not part of
the $77. `updatePrice` and `fundTip` revert on a same-chain pool.

What remains after the tip and the creator cut compounds into the book.

## Anchor source

Chosen once, in `createPool`, and never changed.

**Cross-chain (`ANCHOR_LZ`).** Any wallet calls `updatePrice`. The hook asks LayerZero lzRead
to staticcall `IEthAnchor.latest` on the remote pool. The callback stores the 30-minute TWAP
and the remote TVL. The caller does not pass a price. If that stored quote is older than 30
minutes the pool stays open, the fee ramps, and the next successful update pays the keeper
from the tip budget.

**Same-chain (`ANCHOR_V3`).** The reference is a Uniswap v3 pool of this coin and the hook's
quote token. Every quote and every state change calls `observe([30 minutes, 0])` and uses the
average tick. It does not read `slot0`. A spot print with no duration does not move the
anchor. A print has to be held for the window before it becomes the price. TVL is the
reference pool's token balances valued at that TWAP, and graduation is 12% of that TVL, the
same rule as the remote pool.

The reference pool has to be the same pair the hook quotes. Deploy the hook with USDC (or
whatever the existing v3 pool quotes) if that is the numeraire. A WETH-quoted v3 pool is not
priced as dollars. The pool also needs 30 minutes of oracle history already. `observe` reverts
when the cardinality does not cover the window, and the hook does not fall back to spot, so
swaps revert until the window exists. `increaseObservationCardinalityNext` on the reference
pool is a launch prerequisite.

A same-chain pool is never stale. Time passing does not raise the fee. No tip is escrowed.
A `tipSeed` on a same-chain create is rejected so USDG cannot sit in a budget nobody is paid.

## LP shares

`deposit` and a swap `hookData` of `abi.encode(bool mintLp, address recipient)` mint the hook's
own shares. `mintLp = true` keeps the swap proceeds as shares instead of paying them out.
Empty `hookData`, and an explicit `false`, pay the proceeds out exactly as a normal swap.
This is not v4 `modifyLiquidity`. Shares use an ERC-4626-style virtual offset (`1e6`) so the
first depositor cannot inflate the rate.

Deposits and redeems settle against the book from the start of the block. The first hook
call in a block snapshots spot and LP reserves after the anchor sync and before the action.
A same-block deposit is escrowed: redeeming it that block unwinds those tokens (minus the
normal redeem fee), not a pro-rata slice of whatever a buy just pushed into the LP pot.
Shares already held redeem against the opening reserves, and the redeem retargets to the
live spot so the trade's price is not erased. Share mints use the opening NAV, so a buy in
the same block does not change how many shares a deposit gets.

Fees work the same way. A swap parks the LP's fee until the next block and then divides it
by the shares that existed at the open (same-block mints are not in the denominator). A
deposit, buy, and redeem in one transaction, including inside a flash loan, cannot collect
the 5× fee weight. The parked fee is visible from `pendingFee` for shares that were
already settled. If nobody eligible still holds when the block rolls, that fee moves to
protocol inventory.

The 5× → 1.2× boost (linear in TVL, finished at graduation, then stuck at 1.2×) multiplies the LP's
weight when a fee is split into the fee index. It is not applied to principal and not applied
when a swap re-splits inventory. An early LP whose anchor-value matches the protocol seed
has weight 5 against the seed's weight 1, so about 5/6 of the fee, and none of the principal.
Redeeming charges the same rev fee a swap of that size would pay, plus staleness. That fee stays
with the protocol and the remaining LPs as principal. It is not run back through the boost.
A depositor who trades against themselves and redeems gets back less than they put in.

While spot is below the anchor, a USDG deposit that would mint virtual coin is rejected
(`DiscountDeposit`). Replacing virtual USDG with real USDG is allowed and does not move the
quote. A deposit large enough to pin the 0.67× price would let a buyer clear the seed floor
without the price climbing, then remove the depth. Coin deposits are always allowed. After
the quote has reached the anchor, either side can be deposited and the quote does not jump.

No lock. Redeem any time. A same-block redeem of a fresh deposit returns the escrow, so
"redeem any time" includes the block of the deposit.

## Dump protection

Sells cannot take real USDG principal below the floor. Default 20% (allowed 1%–50%, set per
pool, no zero floor). Normal sells clear. A dump that would break the floor is cut at
`quoteExactIn`, which returns the largest size that fits. Passing the uncapped size to v4
reverts (`ExceedsCap`). v4 cannot partial-fill an exact-in swap here: any specified amount
the hook does not take is swapped against the empty concentrated-liquidity pool and runs the
dummy price to the limit. Exact-out is unsupported for the same reason.

Optional outflow cap, default off. Window must be one block or one hour. The cap is a
percentage of principal at the start of the window and applies to sells, not to redeems.

## Graduation and Morpho

When pool TVL reaches 12% of the Ethereum pool's TVL (read in the same lzRead payload),
graduation latches. The creator cut turns on. Idle USDG above the floor plus a trading buffer,
and only up to the per-pool Morpho cap, is deposited into an ERC-4626 vault. The constructor
takes the default vault. Production value: `0xBeEff033F34C046626B8D0A041844C5d1A5409dd`
(Morpho Steakhouse USDG). The hook checks `asset()` is USDG. Each pool stores its own vault,
starting at that default.

The cap is set at creation. `10_000` bps means the floor and the buffer are the only limit.
The recommended value is 50% of USDG principal (`MORPHO_CAP_BPS`). The tighter of the cap and
`principal − floor − buffer` wins. The buffer is `max($500, 5% of TVL)`. It stays liquid so
ordinary sells do not need the vault. A sell calls `withdraw` only for the excess of vault
assets over the principal still in the book after the trade, and it burns the shares the
vault reports. The payout itself is already an ERC-6909 claim; comparing it to post-trade
principal would treat every floor-sized sell as unbacked. If the vault reverts, the sell
reverts and a smaller sell that fits in the liquid balance still works. Yield accrues to
protocol inventory, not to the boosted LP index, so a depositor cannot sandwich a harvest.
A loss socializes protocol inventory first, then LP principal.

`pullVaultOnLoss` is permissionless. If `previewRedeem` of the pool's shares is below the
accounted assets, it redeems the whole position (so a slashed vault pays what it still has)
and freezes new deposits into that vault. A healthy vault reverts, so the call cannot be
used to force a round trip. `rebalance` will not deposit again until a new vault is executed.
The vault admin can `pullAllFromVault` immediately without a loss and without freezing, and
can `proposeVault` a different ERC-4626 of the same USDG. `executeVault` is public once 48
hours have passed, empties the old vault first, and clears the freeze. Replacing a proposal
restarts the clock. The admin can renounce. None of these calls move the fee index, the
creator accrual, LP shares, or the anchor, and none of them pause swaps.

## Bridge view

`bridgeQuote(poolId)` returns the anchor, the pool price, the signed gap, the signed
coin-versus-USDG imbalance, a suggested fee for bridging coin in, and stale / graduated
flags. A future OFT can read this from `_debitView`. The bridge is not in this contract.

`arbQuote(poolId)` returns the exact-in size and direction that maximizes mark-to-anchor
profit after the fee a swap would charge right now, including the staleness multiplier on a
cross-chain pool. `buyCoin` means spend USDG to buy the coin. Amounts are raw token units, so
a router can pass `amountIn` straight to `PoolManager.swap`. The size is the profit-maximizing
one, not the largest size that is still green, and it is never a capped fill. `profitWad` is
normalized USDG. A zero `amountIn` means the fee eats the gap; `buyCoin` still says which side
of the anchor the pool is on.

## Defaults

| Knob | Value | Why |
| --- | --- | --- |
| Discount | 33% (0.67×), allowed 10–50% | The agreed launch gap. Explicit at creation. |
| Seed floor | 50% of the original coin seed | Backstop so a deep book cannot give away the whole seed under the anchor. The natural climb hits the anchor at ~18%, so day-one buys are not stuck. |
| USDG floor | 20%, allowed 1–50% | Agreed dump backstop. 0% is not offered. |
| Band | ±25% at or below $100 TVL, ±1.2% at graduation | Linear in ln(TVL): `0.25 − 0.238 · ln(v / 100) / ln(grad / 100)`. Equal TVL ratios take equal bites, so the band is still wide in the middle (±13.1% near $2,941, about ±8.8% at $10k) and hits ±1.2% only at graduation. Linear in TVL would still be about ±22% at $10k and then drop most of the remaining width near $86k. Linear in ln(band) would already be about ±5.5% at that log midpoint. The old 1/TVL depth was ±3.33% by $10k and then stuck. Unknown graduation does not deepen. |
| Tail | `TAIL_K = 8e18`, exponent 30 | Emptying a side costs about 8/31 ≈ 26% extra on top of constant product. The g^30 shape matches the launchpad curve's steep tail. |
| Hot cap | 200 bps → 30 bps | 2% while tiny and busy, linear in TVL to 0.3% at graduation. This is the ceiling, not the quiet fee. |
| Quiet floor | 30 bps | What a pool pays when recent volume is ~0, at any TVL. Also the fee once the cap has fallen to 0.3%. |
| Red line | 0.5× denominator TVL | Decayed volume at this level pins the fee at the cap. Fixed at creation. Default when the create param is 0. Allowed 0.01×–10×. |
| Half-life | 1 hour | The volume accumulator forgets half its weight per quiet hour. Fixed at creation. Default when 0. Allowed 60 seconds to 7 days. |
| Direction | none | Buys and sells pay the same rev fee. Closing a gap is not discounted. |
| Stale | 30 min, then 2 hours up to 5×, cap 20% | Matches the TWAP window. The pool stays open. The cap stops a dead oracle becoming a 100% fee. Cross-chain only. |
| Tip | $1, 10% of fees, $10 budget | Covers a keeper's gas plus an lzRead fee with a small margin, and stops spam. |
| Boost | 5× → 1.2× at graduation | Linear in TVL. Early LPs earn more of the fee. 1.2× never goes away. Principal is excluded. |
| Graduation | 12% of reference TVL | About $86.5k if the Ethereum JESUS pool is ~$721k (12% × $721k = $86,520). Latched. The band, the base fee, and the boost all finish here. |
| Creator | 10% of fees after graduation | Only a redirectable claim. Not principal. |
| Buffer | max($500, 5% TVL) | Ordinary sells survive a vault outage. $500 is the floor because a $77 book has no idle USDG yet. |
| Morpho cap | 50% of USDG principal, allowed 0–100% | Caps how much of the book can sit in one vault. 100% leaves only the floor and the buffer. Set per pool. |
| Vault timelock | 48 hours | A vault replacement is public for two days before anyone can execute it. The pull is immediate. |
| Share offset | 1e6 | Virtual shares/assets against inflation. |
| Outflow | off unless the creator sets a block or hour window | Agreed default. |
| Keeper on the first read | $0 unless a tip was seeded | No fees exist before the first price. Same-chain has no keeper. |
| Anchor | Chosen per pool: lzRead, or a v3 `observe` | Same-chain skips the tip and the stale ramp. The pair must be coin / the hook's quote token. |

## Recommended $77 seed

100% coin, 0 USDG inside the curve. At a $1 anchor that is `77e18` coin units and `0` USDG.

For JESUS at $0.0000000136 that seed is `77e18 / 13_600_000_000` =
`5,661,764,705.882353` tokens (`5661764705882352941176470588` in 18-decimal wad, about
5.6618e9 JESUS). The curve still stores `77e18`, because the anchor in the sim is normalized
to $1 and a coin unit is one dollar of JESUS.

The 0.67× price is virtual USDG (`vy ≈ 0.67 × anchor × coin`). Putting real USDG in the $77
does not set the discount, and it is the first thing a dump tries to take. A keeper tip, if
any, is a separate `tipSeed` and is not inventory.

## Simulator

`test/bridge/DiscipleSim.t.sol` runs the real curve. The moving-anchor campaign (active coin at 3% a day, dead coin at 0.1% a day, both searchers, every variant, days 7 / 90 / 365) is written out in `SIM_RESULTS_PARTIAL.md`. That run finished. No profile graduated. The tables there are the numbers to use.

The previous static-anchor baseline is not re-run. It is the comparison column: day 7 TVL $310, avg gap 7.53%, arb $830/day, fees $35.34/day. Day 90 TVL $2,435, gap 1.74%, arb $338/day, fees $26.35/day. Day 365 TVL $7,970, gap 0.99%, arb $128/day, fees $21.64/day. Not graduated. Anchor fixed at $1, fee near 2% for the whole year.

Two searchers, separate profiles, same retail stream and the same oracle path. The outside searcher pays the pool fee plus 0.5%. The other pays the pool fee plus about 0.05%, which is gas. That second searcher is public. The hook does not assume the launching team runs it.

On the moving anchor, the baseline (sliding 2%→0.3% cap, no rev fee) still ends near the old static run: active day 365 TVL about $8,006, arb $140/day, fees $21.90/day, effective fee 192 bps. The anchor itself finished at 0.5834. The dead baseline, with $100–$200/day of retail, ends at about $1,639, effective fee 197 bps, arb still $69/day because the book never got large enough for a 2% fee to shut the gap.

The rev fee keeps that arb alive on purpose. Active, outside searcher, day 365: TVL about $3,140, arb $429/day, fees $8.80/day, effective fee 61 bps, and about $309 of mark transferred to searchers over the year. The gas-only searcher trades even more (about $594/day) and the pool's cumulative mark against searchers is about −$65 (the pool is ahead on mark). Dead coin, outside searcher: TVL about $811 against the baseline's $1,639, arb $131/day, fees $2.06/day, effective fee 73 bps, about $488 of mark transferred. On a dead coin the baseline fee was already letting arb through, because the pool stayed small. The quiet floor makes those gaps cheaper and the book ends smaller.

Overshoot A–D did not push TVL through half the seed on this path. Week-one loop profit on the active coin is on the order of $20/day. By day 365 it is under $1/day. That is not a reason to add them. The same-timestamp round trip is the failure the variants were meant to expose, and this campaign is not a proof that a second wallet, or an atomic loop against a fresh relist, is safe. B's gap is capped under the round-trip fee, so the quoted edge is smaller than the cost of taking it. C only cools the wallet that just traded. D's decay does not run when no time has passed.

LEVAMM is the one that drains. Active, outside searcher, TVL fell through half the seed on day 14 (day 19 for the gas-only searcher) and finished near $30, with the quote about 93% under the anchor. Dead-coin LEV finished near $45, under the $77 seed, without crossing the half-seed line. The cumulative mark column on LEV is not cash removed from a $77 book. The quote sat so far under the oracle that each buy is marked as if the coin were still worth the anchor. TVL is the cash number. An all-coin seed must not use this quote.

Dutch (no max gap, size shrinks as the quote drifts, bid and ask independent) did not drain. Active, outside searcher, day 365 TVL about $3,380, searcher profit about −$1.46/day, pool mark about −$67 (the pool gained). The gas-only searcher shows a larger mark gain for the pool and a negative daily profit, which is the size cap doing its job: a late fill is a small slice, and taking it does not clear the searcher's cost once impact and the fee are counted. Dead Dutch ends near $1,071, ahead of the rev-fee book and behind the baseline, with about $237 of mark transferred over the year. The tail, the seed guard, and the 20% floor still bind on every fill.

The fee drip tracks the rev-fee book. On the dead coin it barely moves the result, because there is little surplus coin above the seed to sell. The subsidy cannot exceed fees already earned.

What goes in the contract: the rev fee (0.3% floor, hot cap sliding from 2% to 0.3%, red line 0.5× TVL, one-hour half-life) and the 5×→1.2× LP boost. No direction discount. No bridge-fee subsidy. Overshoot, LEVAMM, Dutch, and the drip stay in the simulator. That recommendation does not depend on anyone on the launching team running the 0.05% searcher. The outside searcher is enough to see the rev fee keep gaps tradable, and enough to see what that costs the book.

## Deviations from the wording of the spec

These are called out here rather than quietly "fixed."

1. OpenZeppelin's single-pool hook bases are not used. Same accounting pattern, multi-pool, on the pinned v4-core.
2. The full LayerZero OAppRead stack is not vendored. The hook talks to a narrow `ILzRead`. Production wiring is an adapter over lzRead. Tests use `MockLzRead`, and the callback is async.
3. A v4 swap cannot be partial-filled without moving `slot0`. Oversized exact-in reverts. `quoteExactIn` returns the capped size so a router can cut the dump short. Exact-out reverts.
4. USDG deposits that would freeze the launch discount revert until spot reaches the anchor. Smaller USDG deposits that only replace virtual USDG are accepted. This blocks "deposit depth, buy the seed at a stuck 0.67×, withdraw the depth."
5. The redeem fee is not fed back through the boost index. It stays as principal of the protocol and remaining LPs.
6. Morpho yield is credited to protocol inventory, not to the LP fee index.
7. Graduation latches. A later drop in TVL does not turn the creator cut or the vault off.
8. Depth only grows, and only once spot is at or above the anchor.
9. There is no max-deviation clamp on an anchor update. A clamp would freeze the pool on a real crash. A bad read can set any price. See risks.
10. The g^30 tail is ~0 until a trade is most of a side. On USDG, the 20% floor binds first.
11. Same-block LP protection does not roll the live spot back. A dust deposit must not erase a trade. Fresh liquidity is escrowed for the block; the trade's price stays.

## Open risks

- Oracle and DVN trust. `onLzRead` accepts whatever the endpoint delivers. There is no admin circuit breaker, on purpose.
- The lzRead callback sits in the mempool. Someone can sandwich it. The 30-minute TWAP limits how far one update moves, and the anchor update keeps the spot/anchor ratio instead of snapping the pool to the new price. It does not remove the sandwich.
- `slot0` is meaningless. Integrators that price off the pool's sqrt price will be wrong.
- No token rescue. Tokens sent to the hook by mistake stay there.
- Fee-on-transfer tokens break claim settlement. The hook assumes a standard ERC-20 and uses a balance diff on seed and deposit.
- The reference v3 pool is fixed at creation and is trusted for its `observe` result. A pool with a short cardinality pauses trading rather than falling back to spot. Balance-based TVL can be inflated by donating tokens to the reference pool, which raises the graduation threshold. It does not move the TWAP.
- The vault is called during a swap. A reverting vault fails that swap and not the smaller ones. The vault admin can replace it after 48 hours or pull it now. Until that timelock passes, a malicious vault is the one the pool was created with, or the one already executed. `pullVaultOnLoss` is the permissionless exit when the share price drops, and it needs `redeem` to succeed.
- A loss freezes new deposits into that vault. It does not pause trading. Funds already socialized stay socialized. Yield that arrived before the pull belongs to protocol inventory.
- The first keeper earns nothing until a tip exists.
- Redeem and the fee index round down in favor of the pool. A sell-then-buy of the same coins loses at least one wei before fees, and the fees make the round trip strictly worse.
- Same-block fee credit is paid on the next block, to shares that were already held. `pendingFee` shows it early. Redeeming in the fee's own block forfeits that block's fee.
- The hook, the engine, and the three facets share one storage layout. A facet adds no state of its own. Their addresses are fixed at construction, so a bug in one of them cannot be patched. Direct calls to a facet revert; only the hook's `delegatecall` runs the code.

## Not in this version

The following were asked about and are deliberately not built:

- A price-jump circuit breaker.
- A lower fee for small trades.
- On-chain progress or milestone tracking.
- Gap events.
- Overshoot / relist, a LEVAMM value-mix quote, a Dutch bid/ask that drifts off the anchor, and a fee-funded drip. Those were simulated. See the simulator section. They are not in the hook.

Nothing in the quote, the fee schedule, or the events implements those.
