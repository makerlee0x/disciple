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
- The 7% wallet cap applies to `recipient`.

The post-grad paths are on `DiscipleRouter`:

- `buyExactIn(token, quoteIn, minTokensOut, recipient, deadline)` and `sellExactIn(token, tokensIn, minQuoteOut, recipient, deadline)`
- `buyExactInWithPermit(...)` / `sellExactInWithPermit(...)` use the same arguments plus `v, r, s`. The permit deadline is the trade deadline.
- `poolKeyOf(token)` reverts `NotGraduated()` before graduation.
- Approve the router once per asset.

## Creator buy preview

`Launchpad.quoteCreatorBuy(quote, creatorBuyQuoteIn)` (tax 0) and `quoteCreatorBuy(quote, creatorBuyQuoteIn, creatorTaxBps)` are `view` functions. They return `(tokensOut, fee, snipeFee, quotePriceUsd, exceedsCap)`.

- `quote = 0` means `defaultQuote`.
- `snipeFee` is always **0**: the creator launch buy is anti-snipe exempt and pays only the 1% protocol fee plus its own creator tax.
- `exceedsCap = true` means the launch would revert with `CreatorBuyTooLarge`, because 0.77% of supply is the maximum.
- Set `creatorBuyMinTokensOut` to `tokensOut` less your slippage. The output is exact if the quote/USDG pool price does not move before the tx lands.

## Quotes / views

On the curve (all `view`):

- `quoteBuy(quoteIn)` returns `BuyQuote{tokensOut, fee, snipeFee, quoteToCurve, priceAfterX18, impactBps, mcapAfterUsd, graduates}`. It is exact for the current block, including the anti-snipe fee. Pass `minTokensOut = tokensOut * (1 - slippage)`.
- `quoteSell(tokensIn)` returns `SellQuote{quoteOut, fee, grossQuote, priceAfterX18, impactBps, mcapAfterUsd}`.
- `priceNow()` (= `spotPriceWad`), `mcapNow()` (= `marketCapUsd`), `progressBps()` (tokensSold / 72% supply, 10000 once graduated), `currentSnipeFeeBps()`, `tokensSold()`, `graduated()`, `quotePriceUsd()`, `creatorTaxBps()`, `balanceOnCurve(addr)`.

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

These are single-sided concentrated v4 LP ranges in the coin's DISCIPLE pool. "Price" here means quote per token.

| | Side | Placement rule | When it is "filled" |
|---|---|---|---|
| **Tramp** (support) | quote only | range strictly **below** current price | price falls through the bottom, so all quote has converted to token |
| **Wall** (resistance) | token only | range strictly **above** current price | price rises through the top, so all token has converted to quote |

Ticks must be multiples of `tickSpacing` (60). Placement reverts with `NotSingleSided` if the range touches the current price. Converting ticks: with `(tick, sqrtPriceX96, tickSpacing, tokenIsCurrency0) = poolState(token)`, price(quote/token) = 1.0001^tick when the token is currency0, and 1.0001^-tick otherwise. So with token = c0, a tramp uses ticks below `tick`. With token = c1, a tramp uses ticks above `tick`.

Writes: approve the manager once per asset. Positions are held by the manager and tracked per user by id.
- `placeTramp(token, tickLower, tickUpper, quoteAmt, minLiquidity, deadline) → (id, liquidity)`
- `placeWall(token, tickLower, tickUpper, tokenAmt, minLiquidity, deadline) → (id, liquidity)`
- `cancel(id) → (quoteOut, tokenOut)` (owner only). Returns the remaining principal of both assets plus accrued fees.
- `claimFees(id) → (quoteFees, tokenFees)` (owner only)
- `pull(id) → (quoteOut, tokenOut)`. Permissionless keeper call that only works once `isFilled(id)` is true; everything goes to the owner, and v0 pays no tip.

Views:
- `poolState(token)`, `poolKeyOf(token)`
- `positions(id) → (owner, token, tickLower, tickUpper, liquidity, kind (0 tramp / 1 wall), active)`
- `positionsOf(owner) → uint256[]`
- `pendingFees(id) → (quoteFees, tokenFees)`, `isFilled(id)`, `nextId()`

Events (every one carries tick ranges for chart lines):
- `TrampPlaced(uint256 indexed id, address indexed owner, address indexed token, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 quoteAmt)`
- `WallPlaced(uint256 indexed id, address indexed owner, address indexed token, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 tokenAmt)`
- `Filled(uint256 indexed id, address indexed owner, address indexed token, int24 tickLower, int24 tickUpper, uint256 quoteOut, uint256 tokenOut, address keeper)`
- `Cancelled(uint256 indexed id, address indexed owner, address indexed token, int24 tickLower, int24 tickUpper, uint256 quoteOut, uint256 tokenOut, uint256 quoteFees, uint256 tokenFees)`
- `FeesClaimed(uint256 indexed id, address indexed owner, address indexed token, uint256 quoteFees, uint256 tokenFees)`

Errors: `NotGraduated`, `Expired`, `BadRange`, `NotSingleSided`, `LiquidityTooLow(uint128)`, `NotOwner`, `Inactive`, `NotFilled`, `ZeroAmount`.

**Earnings.** On every post-grad swap, `DiscipleHook` donates `donationOf(fee)` (11% of the 1% fee, which is 1/3 of the 33% LP share) to in-range liquidity, and emits `LPDonation(token, currency, amount)`. The remaining 2/3 of the LP share still goes to LockedLP, and creator, treasury and referral shares are unchanged. The full-range LockedLP position is always in range, so it receives its pro-rata part of every donation. Tramps and walls earn only while the price is inside their range. Exact-in buys donate in the launch token; sells donate in quote.

Other contract changes: `Launchpad.curveDeployer()` / `CurveDeployer` deploys curves, which keeps Launchpad under the size limit. `FeeRouter.routeHookFee` was added for the hook.
