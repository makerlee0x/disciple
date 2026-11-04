# Disciple hook: what a launch UI needs from the contracts

For the standalone hook site (landing page plus "Launch a pool"). Covers same-chain pools, the v0 launch case.
Source: `src/disciple/Disciple.sol`. Function names and argument orders below match the code at the time of writing.

## Deployments

There is one Disciple hook per chain. maker decided on 2026-11-04 to use one combined hook for same-chain and cross-chain pools.
The quote token is **USDG** (6 decimals) on every chain:

| Chain | USDG | v4 PoolManager | Same-chain sources allowed |
|---|---|---|---|
| Ethereum (1) | `0xe343167631d89B6Ffc58B88d6b7fB0228795491D` | `0x000000000004444c5dc75cB358380D2e3dE08A90` | Uniswap v2, v3, v4 |
| Robinhood (4663) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | Uniswap v4 (v2/v3 only if a factory is configured) |

Hook addresses: TBD (nothing deployed). Read `hook.quote()`, `hook.v2Factory()` and `hook.v3Factory()` instead of hard-coding them.
A factory address of `0` means that source kind is off on that deployment.

**Consequence for the UI:** a source must be a real Uniswap pool of exactly **COIN/USDG**. COIN/ETH and COIN/WETH
pools are refused. Only offer source pools that pair the coin with USDG.

## Launch a pool: `createPool`

```solidity
struct Source {
    uint8 kind;        // 1 = v2, 2 = v3, 3 = v4
    bool coinIs0;      // the coin is token0 / currency0 OF THE SOURCE
    uint24 v2Fee;      // v2 only, pips (3000 for Uniswap v2)
    uint32 remoteEid;  // 0 for same chain
    address target;    // v2 pair / v3 pool; for v4 the PoolManager
    bytes32 v4Id;      // v4 only: the source PoolId
    address lens;      // 0 (cross chain only)
    int8 decShift;     // 0 (cross chain only)
    bool push;         // false (cross chain only)
}

struct CreateParams {
    address coin;
    uint24 fee;        // Disciple fee in pips (1 = 0.0001%); 1..100_000 (max 10%)
    Source src;
    uint256 coinIn;    // max coin to seed (raw units)
    uint256 quoteIn;   // max USDG to seed (raw, 6 decimals)
    PoolKey srcKey;    // v4 source only: its full PoolKey (must hash to v4Id); zeroes otherwise
}

function createPool(CreateParams calldata) external payable returns (PoolKey memory key, PoolId id);
```

- **Approvals first:** the creator approves the **hook** (not the PoolManager) for both the coin and USDG.
- **Send no ETH.** A same-chain create with `msg.value != 0` reverts with `SameChain()`.
- **Seed is trimmed to 50/50 by value** at the source's spot in that block. The hook takes all of one side and only
  as much of the other as matches. The rest never leaves the wallet, so a preview should show what will be used:
  `y = coinIn * spot`. If `y > quoteIn`, use all of `quoteIn` and `quoteIn / spot` coin instead.
  Spot comes from the source: v2 is `reserveQuote / reserveCoin`; v3/v4 is `sqrtPriceX96²` in the right orientation.
- **Reverts with `BadParams()`** for: a source that is not the factory's pool for coin/USDG, a wrong `coinIs0`,
  a v4 key that doesn't hash to `v4Id`, a v4 source that is one of this hook's own pools, a fee of 0 or above 10%,
  or a zero amount. `NoAnchor()` means the source is empty or uninitialised.
- **Several pools per coin are allowed.** Pool *n* of a coin gets `tickSpacing = n`, so nobody can squat a coin.
  The UI should show every pool of a coin and rank them (by reserves or source).

Fee default for the UI: a suggestion, not decided. Sims put a busy same-chain pool's best plain fee near 1%
(`fee = 10_000`), beside a 0.3% source. All sim figures are simulated.

## Finding pools

- `poolsOf(coin)` is how many Disciple pools the coin has. Pool *n*'s key is:
  `{currency0: min(coin, USDG), currency1: max(coin, USDG), fee: 0, tickSpacing: n, hooks: hook}`,
  and its id is `keccak256(abi.encode(key))`. This enumerates every pool of a coin with no indexer.
- Events (all indexed by `PoolId id`):
  `Created(id, coin, creator, remoteEid, fee)`, `Swapped(id, sender, buy, coinAmt, quoteAmt)`,
  `Deposited(id, owner, lot, shares, x, y)`, `Withdrawn(id, owner, lot, x, y)`, `Restaked(id, owner, fromLot, newLot)`,
  `Claimed(id, to, x, y)`, `CreatorSet(id, creator, compounds)`.
  An LP's lots are found from `Deposited` and `Restaked` by `owner`. There is no on-chain per-owner list.
  Note: the Alchemy free tier caps `eth_getLogs` at 10 blocks, so a real site needs a paid RPC or an indexer.

## Reading a pool

- `poolState(id)` returns `live, local, graduated, coinReserve, quoteReserve, anchorX128, ageOrBlock, tank, srcTvl,
  principal, compounded, lots`.
  - Price in USDG per coin: `anchorX128 / 2^128 * 10^(coinDecimals - 6)`. The anchor is the source price
    latched in an earlier block, not the live quote.
  - `graduated`: the pool reached about 12% of the source's TVL. After that, fees are paid out (12% to the creator,
    88% to LPs); before it, everything compounds. `srcTvl` is a proxy: on v3/v4 it counts in-range liquidity as
    full-range, so it reads high and graduation comes later than "12% of real TVL".
  - `tank`, `local`, `ageOrBlock` as a timestamp: cross-chain only. On a same-chain pool `ageOrBlock` is the last
    settled block.
- `lotState(id, lot)` returns `owner, principal, compounded, claimX, claimY`. It is **not a view**, because it
  checkpoints the lot first. Call it with `eth_call`, never in a transaction.

## Trading

Swaps are normal Uniswap v4 swaps on the Disciple pool key, through the Universal Router or any v4 router.
Quotes come from the v4 Quoter. The hook prices everything in `beforeSwap`, and a quote is never better than the
live source's own price (it stays within 1 bp of the source's ask or bid). For the first 30 s after the source moves
0.25%, a premium of up to 4% applies and fades. Adding v4 liquidity to a Disciple pool directly is disabled.

## LP actions (approve the hook for both tokens first)

| Call | What it does |
|---|---|
| `deposit(id, maxX, maxY)` returns `(lot, shares)` | Adds both tokens at the current reserve ratio. Unused tokens stay in the wallet. The lot joins the back of the boost line (7x at the front sliding to 1.2x at the back). |
| `withdraw(id, lot, s, bal)` returns `(x, y)` | Burns `s` principal shares and `bal` of the compounded balance, paid in both tokens pro rata. |
| `restake(id, lot)` returns `newLot` | Moves the lot's compounded balance into a new principal lot at the back of the line. |
| `claim(id, lot)` returns `(x, y)` | Collects escrowed payouts (after graduation). |
| `setCreator(id, wallet, compounds)` | Creator only: hand off the role, or choose to compound the 12% cut. The only mutable setting. |
| `claimCreator(id)` returns `(x, y)` | Pays the creator's cut to the current creator wallet. |

## Not needed for same-chain pools

The ETH tank, TJAR, keepers, LayerZero and `updatePrice` are cross-chain only. A same-chain pool never pays for
price updates.
