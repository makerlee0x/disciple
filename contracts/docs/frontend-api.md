# DISCIPLE contracts — frontend API (v0)

Read this alongside `web/docs/wire-protocol.md`. Events are final for v0: **`Launched`** on the Launchpad, **`GraduatedToV4`** on each curve, and **`Trade`**, emitted by both curve and hook.

## Events

| Emitter | Event | Notes |
|---|---|---|
| Launchpad | `Launched(address indexed token, address indexed curve, address indexed creator, address quote, string name, string ticker, uint256 creatorTaxBps)` | one per launch |
| Launchpad | `QuotePriced(address indexed token, address indexed quote, uint256 quotePriceUsd)` | the USD price baked into the curve |
| Launchpad | `LaunchTierContext(address indexed token, uint256 startMcapUsd, uint256 graduationMcapUsd, uint256 totalSupply, uint8 decimals_)` | for tier tracking |
| Launchpad | `MetadataUpdated`, `CreatorTransferred`, `DefaultQuoteUpdated`, `QuoteProbeUpdated`, `PricerUpdated` | admin / metadata |
| BondingCurve | `Trade(...)` (below) | every pre-grad buy/sell |
| BondingCurve | `GraduatedToV4(address indexed token, bytes32 poolId, uint256 tokenLiq, uint256 quoteLiq)` | same tx as the graduating buy |
| DiscipleHook | `Trade(...)` (same signature) | every post-grad v4 swap, whatever router is used |

```solidity
event Trade(
    address indexed token, address indexed trader, bool isBuy,
    uint256 quoteAmt, uint256 tokenAmt, uint256 fee, uint256 snipeFee,
    uint256 priceBeforeX18, uint256 priceAfterX18, uint256 impactBps, uint256 mcapAfterUsd
);
```

- `trader`: on the curve, a buy's token recipient or a sell's `msg.sender`. On the hook: if the swap `sender` is on the hook's owner-managed allowlist (`isTrustedRouter`, which includes DiscipleRouter and, optionally, UniversalRouter) **and** hookData is exactly `abi.encode(address trader)`, that trader is used. Otherwise it is the swap `sender`. Referral credit follows the same rule, so it only applies to trusted-router hookData or a direct (sender = trader) swap. Any caller of a trusted router can put any address in hookData; they still pay the fee themselves, so spoofing can only redirect the referral share of their own fee.
- `quoteAmt` on a buy is the gross quote paid, including fees. On a sell it is the net quote received. `tokenAmt` is net tokens received (buy) or tokens sold (sell).
- `fee` is the protocol 1% plus creator tax, in quote raw units. On the hook, an exact-in buy charges its fee in the launch token; that fee is converted to quote at `priceAfterX18`. `snipeFee` is the anti-snipe part, always 0 after graduation.
- Prices are `quote raw * 1e18 / token raw`. `impactBps` is an **unsigned absolute** value. Its direction comes from `isBuy`: buys push the price up and sells push it down, so negate it client-side for sells if you want a signed value. It is computed on-chain at full precision from reserves or sqrtPrice, so use it rather than recomputing from the X18 prices. For 6-decimal quotes the X18 prices are coarse.
- `mcapAfterUsd` is in USD WAD and uses the quote/USD price fixed at launch.

## Trading paths (no custody: the Privy embedded wallet signs its own txs)

The pre-grad paths are on the `BondingCurve`, at `Launchpad.curveOf(token)`:

- `buy(quoteIn, minTokensOut, deadline)` / `buy(quoteIn, minTokensOut, deadline, recipient)`
- `sell(tokensIn, minQuoteOut, deadline)` / `sell(tokensIn, minQuoteOut, deadline, recipient)`
- `buyWithPermit(quoteIn, minTokensOut, deadline, recipient, permitDeadline, v, r, s)`: one tx using an EIP-2612 permit on the quote. STRATEGY and USDG both expose `DOMAIN_SEPARATOR`/`nonces` on RH mainnet.
- `sellWithPermit(tokensIn, minQuoteOut, deadline, recipient, permitDeadline, v, r, s)`: every DISCIPLE token is ERC20Permit.
- Permit calls sit in try/catch, so a front-run permit doesn't brick the tx. Without permit, approve the curve once (max) and every later trade is a single tx.
- The per-wallet curve cap applies to `recipient` (reverts `WalletCap()`). It is per coin: read `curve.walletCapBps()` (or `Launchpad.walletCapBpsOf(token)`); **0 = no cap**, otherwise max holding = `walletCapBps * 7e27 / 10000` tokens measured by `curve.balanceOnCurve(recipient)`. The value for new launches is `Launchpad.walletCapBps()` (default 0; owner-only `setWalletCapBps`, event `WalletCapSet(bps)`).
- Compatibility: curves from the live v1–v3 stacks have a hard-coded 7% cap and **no** `walletCapBps()` getter. If the call reverts, fall back to 700 bps (7%). Show the cap only when it is non-zero.

The post-grad paths are on `DiscipleRouter`:

- `buyExactIn(token, quoteIn, minTokensOut, recipient, deadline)` and `sellExactIn(token, tokensIn, minQuoteOut, recipient, deadline)`
- `buyExactInWithPermit(...)` / `sellExactInWithPermit(...)` use the same arguments plus `v, r, s`. The permit deadline is the trade deadline.
- `poolKeyOf(token)` reverts `NotGraduated()` before graduation.
- Approve the router once per asset.

## Creator buy preview

`Launchpad.quoteCreatorBuy(quote, creatorBuyQuoteIn)` (tax 0) and `quoteCreatorBuy(quote, creatorBuyQuoteIn, creatorTaxBps)` are `view` functions. They return `(tokensOut, fee, snipeFee, quotePriceUsd, exceedsCap)`.

- `quote = 0` means `defaultQuote`.
- `snipeFee` is always **0**: the creator launch buy is anti-snipe exempt and pays only the 1% protocol fee plus its own creator tax.
- `exceedsCap = true` means the launch would revert with `CreatorBuyTooLarge`. The cap is `Launchpad.creatorBuyMaxBps()` bps of supply (default 77 = 0.77%, ceiling 700 = 7%, protocol owner only, event `CreatorBuyMaxSet(bps)`). Read it live for the UI limit; each coin's cap at launch is `creatorBuyMaxBpsOf(token)`. AnonLauncher launches use the same cap.
- Set `creatorBuyMinTokensOut` to `tokensOut` less your slippage. The output is exact if the quote/USDG pool price does not move before the tx lands.

## Quotes / views

On the curve (all `view`):

- `quoteBuy(quoteIn)` returns `BuyQuote{tokensOut, fee, snipeFee, quoteToCurve, priceAfterX18, impactBps, mcapAfterUsd, graduates}`. It is exact for the current block, including the anti-snipe fee. Pass `minTokensOut = tokensOut * (1 - slippage)`.
- `quoteSell(tokensIn)` returns `SellQuote{quoteOut, fee, grossQuote, priceAfterX18, impactBps, mcapAfterUsd}`.
- `priceNow()` (= `spotPriceWad`), `mcapNow()` (= `marketCapUsd`; after graduation these read the v4 pool slot0 × live `QuotePricer` — curves deployed before this fix return the frozen curve-end value, use `MarketLens.market(token)` for those), `progressBps()` (tokensSold / 72% supply, 10000 once graduated), `currentSnipeFeeBps()`, `tokensSold()`, `graduated()`, `quotePriceUsd()`, `creatorTaxBps()`, `balanceOnCurve(addr)`.

After graduation:

- `DiscipleRouter.quoteExactIn(token, isBuy, amountIn)` returns `(amountOut, impactBps, mcapAfterUsd)`, using the same semantics as `Trade`. It simulates and reverts, so call it with `eth_call` / viem `simulateContract`. The result is exact and includes the hook's 1%.
- Or use the official Uniswap **V4Quoter** with `poolKeyOf(token)` and empty hookData. I checked bytecode on both RH mainnet (4663) and testnet (46630) on 2026-10-15; the addresses are identical on both chains:
  - PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951`
  - V4Quoter `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` (`poolManager()` returns the PoolManager above)
  - StateView `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b`
  - UniversalRouter `0x8876789976decbfcbbbe364623c63652db8c0904`
  - Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`

## Launch pricing (`QuotePricer`)

`LaunchParams.quotePriceUsd` has been **removed**. At launch, `Launchpad` calls `pricer.quotePriceUsd(quote)` once and the result is fixed in that curve.

- USDG is $1. The value is "USD WAD per 1e18 raw units", so 6-decimal USDG gives `1e30`.
- Any other quote is priced from the spot `sqrtPriceX96` of an **owner-registered quote/USDG v4 pool** (`setPricePool`), which must have in-range liquidity of at least `minLiquidity`. With no pool registered, the launch reverts `NoPricePool(quote)`. With no pricer set, it reverts `PricerUnset()`. A value of 0 is never treated as $1.
- STRATEGY (the default quote) uses the STRATEGY/USDG v4 pool. Uniswap v4 has two STRATEGY/USDG pools:
  - fee 36900 / tickSpacing 369 / no hooks, id `0x816b…245b`. This pool has more liquidity and is the default in `Deploy.s.sol`.
  - fee 9000 / tickSpacing 90, id `0x9a0a…d105`.

Trust assumptions:

1. USDG is assumed to hold its peg.
2. The price is a single-block spot price, not a TWAP. Someone who moves the pool in the launch tx only mis-scales the USD targets of that one curve. No user funds can be taken, and the curve stays internally consistent in quote terms. `minLiquidity` makes manipulation more expensive.
3. The owner (multisig) picks the canonical pool.
4. Post-grad `mcapAfterUsd` uses the launch-time price, so it drifts as quote/USD moves.

## Deploy

`forge script script/Deploy.s.sol --tc Deploy --rpc-url $RPC --broadcast` (see the env vars documented in the script header). The hook salt is mined against the CREATE2 factory `0x4e59b44847b379578588920cA78FbF26c0B4956C`, and the hook flags are `BEFORE_SWAP | AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA`. The script also sets `pricer`, `quoteProbe` and `defaultQuote`, and allowlists DiscipleRouter (plus `UNIVERSAL_ROUTER` if set) via `hook.setTrustedRouter`.

- Local, with no env set: it deploys PoolManager, dev USDG and dev STRATEGY, plus a STRATEGY/USDG pool seeded at $0.0018.
- RH mainnet:

```
POOL_MANAGER=0x8366a39cc670b4001a1121b8f6a443a643e40951 USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 \
DEFAULT_QUOTE=0x168661C52E5922288dFb2b3f323b6Cf90eb21e18 DEFAULT_QUOTE_POOL_FEE=36900 DEFAULT_QUOTE_POOL_TICK_SPACING=369
```

## Tramps & walls (`TrampWallManager`, graduated coins only)

These are single-sided concentrated v4 LP ranges in the coin's DISCIPLE pool, and they behave like **limit orders**. "Price" here means quote per token. A tramp is a floor: it buys the dip. A wall is a sell wall: it sells into pumps. Placement is always one-sided: a two-sided or straddling range reverts.

| | Side | Placement rule | When it is "filled" |
|---|---|---|---|
| **Tramp** (support) | quote only | range strictly **below** current price | price falls through the bottom, so all quote has converted to token |
| **Wall** (resistance) | token only | range strictly **above** current price | price rises through the top, so all token has converted to quote |

Ticks must be multiples of `tickSpacing` (60). Placement reverts with `NotSingleSided` if the range touches the current price. Converting ticks: with `(tick, sqrtPriceX96, tickSpacing, tokenIsCurrency0) = poolState(token)`, price(quote/token) = 1.0001^tick when the token is currency0, and 1.0001^-tick otherwise. So with token = c0, a tramp uses ticks below `tick`. With token = c1, a tramp uses ticks above `tick`.

Writes: approve the manager once per asset. Positions are held by the manager and tracked per user by id.
- `placeTramp(token, tickLower, tickUpper, quoteAmt, minLiquidity, deadline) → (id, liquidity)`
- `placeWall(token, tickLower, tickUpper, tokenAmt, minLiquidity, deadline) → (id, liquidity)`
- `cancel(id) → (quoteOut, tokenOut)` (owner only, any time, no hold). Returns the remaining assets of the range (unfilled principal + any filled proceeds). There is no yield.
- `pull(id) → (quoteOut, tokenOut)`: **auto-close of a filled order.** It is permissionless and works as soon as `isFilled(id)` is true (no hold).
  - The owner receives proceeds minus the keeper tip; the return values and `Filled` amounts are the owner's net.
  - The caller receives `keeperTipBps` (default 10 = 0.1%, owner-settable, max 100 = 1%) of each asset paid out, reported in `KeeperTipPaid`.
  - Bots watch `isFilled` and close filled orders. The UI can also offer a "close now" button; when the owner calls it, they pay the tip to themselves.

Views:
- `poolState(token)`, `poolKeyOf(token)`
- `positions(id) → (owner, token, tickLower, tickUpper, liquidity, kind (0 tramp / 1 wall), active)`
- `positionsOf(owner) → uint256[]`
- `isFilled(id)`, `nextId()`
- `keeperTipBps()`, `MAX_KEEPER_TIP_BPS()`, `owner()`

Events (every one carries tick ranges for chart lines):
- `TrampPlaced(uint256 indexed id, address indexed owner, address indexed token, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 quoteAmt)`
- `WallPlaced(uint256 indexed id, address indexed owner, address indexed token, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 tokenAmt)`
- `Filled(uint256 indexed id, address indexed owner, address indexed token, int24 tickLower, int24 tickUpper, uint256 quoteOut, uint256 tokenOut, address keeper)`
- `Cancelled(uint256 indexed id, address indexed owner, address indexed token, int24 tickLower, int24 tickUpper, uint256 quoteOut, uint256 tokenOut, uint256 quoteFees, uint256 tokenFees)`. `quoteFees`/`tokenFees` are **always 0** (kept for ABI stability).
- `KeeperTipPaid(uint256 indexed id, address indexed keeper, uint256 quoteTip, uint256 tokenTip)` (emitted by `pull`, before `Filled`)
- `KeeperTipSet(uint16)`, `OwnerTransferred(address indexed)`

Errors: `NotGraduated`, `Expired`, `BadRange`, `NotSingleSided`, `LiquidityTooLow(uint128)`, `NotOwner`, `Inactive`, `NotFilled`, `ZeroAmount`, `OnlyOwner`, `BadParam`.

LP adds to DISCIPLE pools from anything other than LockedLP or TrampWallManager are rejected by the hook (`OnlyLiquidityManager`).

## Altitude events (spot)
After every `Trade`, BondingCurve (pre-grad) and DiscipleHook (post-grad) emit:
- `AltitudeUpdate(address indexed token, uint256 mcapUsd, uint8 tier)`. `mcapUsd` equals `Trade.mcapAfterUsd`, which is the spot price after the trade.
- `TierBreak(address indexed token, uint8 fromTier, uint8 toTier, uint256 mcapUsd)`, emitted only when the tier changes (either direction).
- `tier` is the index into the 18-tier `TIERS` ladder (0 = LAUNCH PAD … 17 = SEVENTH HEAVEN).
- At graduation the hook emits one `AltitudeUpdate` at the curve-end mcap, and the hook's stream takes over.
- Getters: `BondingCurve.altitudeTier()` and `DiscipleHook.altitudeTierOf(poolId)`.

## QuotePricer
`quotePriceUsd(quote)` is a truncated TWAP (default 30 min window, ±2000 ticks per poke). It is used to bake the curve's USD targets at launch, and it is also the live mcap quote price. Use `spotPriceUsd(quote)` for display. `poke(quote)` is permissionless.

**No yield (2026-10-16).** Tramps and walls are pure limit orders: the pool LP fee is 0 and the hook no longer donates to in-range liquidity. **`LPDonation` and `donationOf` have been removed** from DiscipleHook; `TrampWallManager.claimFees`, `pendingFees` and `FeesClaimed` are gone too. The full 33% LP share of the 1% hook fee goes to LockedLP (`TradeFeeRouted.lpShare` = 33%). Indexers should drop any `LPDonation` handlers.

Other contract changes: `Launchpad.curveDeployer()` / `CurveDeployer` deploys curves, which keeps Launchpad under the size limit. `FeeRouter.routeHookFee(token, feeToken, trader, creator, feeAmount)` is called by the hook (the `donated` argument has been removed).

## Anti-snipe tax routing (LOCKED #9 rev. 2026-10-15)
- `snipeFee` in `Trade` / `quoteBuy` is split by `FeeRouter.routeSnipeFee`: `toRewards = snipeFee * 7000 / 10000` → `FeeRouter.rewardsVault()` (community `RewardsVault`), `snipeFee - toRewards` → treasury.
- Event: `FeeRouter.SnipeFeeRouted(token indexed, quote indexed, toRewards, toTreasury)` (replaces `SnipeFeeRoutedToLP`). `RewardsVault.RewardAccrued(token indexed, asset indexed, amount)`; `RewardsVault.totalAccrued(asset)` = lifetime total; payouts emit `Distributed(asset, to, amount)`.
- Anti-snipe tax is no longer added to LockedLP, so `LockedLP.positions(token).escrow` grows only by the LP share of the 1% fee.
- Post-graduation there is no anti-snipe (`snipeFee` is always 0 on hook `Trade` events).
