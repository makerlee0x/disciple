# Disciple hook: what a launch UI needs from the contracts

For the standalone hook site (landing page plus "Launch a pool"). Covers same-chain pools, the v0 launch case.
Source: `src/disciple/Disciple.sol`. Function names and argument orders below match the code at the time of writing.

## Deployments

One Disciple hook per chain serves every pool, same-chain and cross-chain (maker, 2026-11-04). The quote token is
chosen **per pool** and can be any ERC20 (fully permissionless). The site features three choices: **mirror** the main
pool's pair, **USDG**, or **ETH (WETH)**.

| Chain | v4 PoolManager | WETH (native ETH in a source counts as this) | Same-chain source kinds |
|---|---|---|---|
| Ethereum (1) | `0x000000000004444c5dc75cB358380D2e3dE08A90` | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | Uniswap v2, v3, v4 |
| Robinhood (4663) | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | Uniswap v4 (v2/v3 only if a factory is configured) |

USDG: Robinhood `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, Ethereum `0xe343167631d89B6Ffc58B88d6b7fB0228795491D` (6 decimals).
Hook addresses: TBD (nothing deployed). Read `hook.v2Factory()`, `hook.v3Factory()` and `hook.weth()`. A factory of `0`
means that source kind is off.

## Pricing: mirror or two-hop

- **Mirror:** the source is one real pool of exactly the coin and the chosen quote (COIN/ETH beside a COIN/ETH main
  pool, COIN/USDG beside COIN/USDG). Cheapest gas, competes for all flow in that pair.
- **Two-hop:** the source is two real pools that share a token X: leg 1 holds COIN and X, leg 2 holds X and the quote.
  Price = leg 1 x leg 2. Examples: a USDG pool beside an ETH main pool (COIN/WETH x WETH/USDG); a cross pair like
  STRATEGY/AI (STRATEGY/USDG and AI/USDG). Same chain only. About one extra pool read per swap.
- In both cases a fill is never better than the real route: the boundary uses every leg's fee.

## Launch a pool: `createPool`

```solidity
struct Source {
    uint8 kind;        // leg 1: 1 = v2, 2 = v3, 3 = v4
    bool coinIs0;      // the coin is token0 / currency0 of leg 1
    uint32 remoteEid;  // 0 for same chain
    address target;    // leg 1: v2 pair / v3 pool; for v4 the PoolManager
    bytes32 v4Id;      // leg 1 v4 PoolId
    int8 decShift;     // cross chain: price * 10^decShift = local raw quote-per-coin; 0 on the same chain
    int8 tvlShift;     // cross chain: TVL * 10^tvlShift = local raw quote; 0 on the same chain (|shift| <= 36)
    bool push;         // false (cross chain only)
    uint8 kind2;       // leg 2 kind, 0 = mirror (no leg 2)
    bool xIs0;         // X is token0 / currency0 of leg 2
    address target2;   // leg 2 v2 pair / v3 pool
    bytes32 v4Id2;     // leg 2 v4 PoolId
}

struct CreateParams {
    address coin;
    address quote;     // any ERC20 other than the coin
    uint24 fee;        // Disciple fee in pips (1 = 0.0001%); 1..100_000 (max 10%)
    Source src;
    uint256 coinIn;    // max coin to seed (raw units)
    uint256 quoteIn;   // max quote to seed (raw units)
    PoolKey srcKey;    // v4 leg 1: its full PoolKey (must hash to v4Id); zeroes otherwise
    PoolKey srcKey2;   // v4 leg 2: same, for v4Id2
}

function createPool(CreateParams calldata) external payable returns (PoolKey memory key, PoolId id);
```

- **Approvals first:** the creator approves the **hook** (not the PoolManager) for both the coin and the quote.
- **Send no ETH** for a same-chain pool (`SameChain()` otherwise).
- **Seed is trimmed to 50/50 by value** at the source's spot in that block; the rest never leaves the wallet. Preview:
  `y = coinIn * spot`; if `y > quoteIn`, use all of `quoteIn` and `quoteIn / spot` coin.
- **Reverts with `BadParams()`** for: a leg that is not the factory's pool (v2/v3) or whose key doesn't hash to its id
  (v4), a v4 leg that is one of this hook's own pools, legs that don't share X, a coin or quote that doesn't match,
  a wrong orientation flag, a remote pool with two legs, a fee of 0 or above 10%, or a zero amount. `NoAnchor()`
  means a source pool is empty or uninitialised.
- **Several pools per pair are allowed.** Pool *n* of a pair gets `tickSpacing = n`; the counter is shared whichever
  side is the coin. The UI should show every pool of a pair and rank them.
- Odd quote tokens (fee-on-transfer, rebasing, blacklisting) are the creator's and depositors' risk, as for coins.

Fee default for the UI: a suggestion, not decided. Sims put a busy same-chain pool's best plain fee near 1%
(`fee = 10_000`), beside a 0.3% source. All sim figures are simulated.

## Cross-chain launch: start the source count (automatic step)

For a cross-chain pool whose home source is a **v4** pool, the launch flow also calls, on the **home chain**,
`DisciplePushSender.track(poolManager, sourceKey)` (anyone may call it; it is a no-op if already tracked). It counts
the source's real TVL so graduation and the creator fee use the real number. It is a separate transaction on the
home chain (the wallet switches network), so do it right after `createPool`. Until it runs, that source reports the
in-range estimate, which reads high. v2 and v3 home sources need nothing.

## Finding pools

- `poolsOf(currency0, currency1)` (sorted addresses) is how many Disciple pools the pair has. Pool *n*'s key is:
  `{currency0, currency1, fee: 0, tickSpacing: n, hooks: hook}`,
  and its id is `keccak256(abi.encode(key))`. This enumerates every pool of a coin with no indexer.
- Events (all indexed by `PoolId id`):
  `Created(id, coin, quote, creator, remoteEid, fee)`, `Swapped(id, sender, buy, coinAmt, quoteAmt)`,
  `Deposited(id, owner, lot, shares, x, y)`, `Withdrawn(id, owner, lot, x, y)`, `Restaked(id, owner, fromLot, newLot)`,
  `Claimed(id, to, x, y)`, `CreatorSet(id, creator, compounds)`.
  An LP's lots are found from `Deposited` and `Restaked` by `owner`. There is no on-chain per-owner list.
  Note: the Alchemy free tier caps `eth_getLogs` at 10 blocks, so a real site needs a paid RPC or an indexer.

## Reading a pool

- `poolState(id)` returns `coin, quote, live, local, graduated, creatorOn, coinReserve, quoteReserve, anchorX128,
  ageOrBlock, tank, srcTvl, principal, compounded, lots`.
  - Price in quote per coin: `anchorX128 / 2^128 * 10^(coinDecimals - quoteDecimals)`. The anchor is the source price
    latched in an earlier block, not the live quote.
  - `graduated`: the pool has reached 12% of the source's TVL at least once. From then on LP fees are paid out
    (claimable); before it, everything compounds. This one does not switch back.
  - `creatorOn`: the creator's 12% cut applies right now. It is judged when each interval is paid, against the
    larger of the last two source TVL readings, so a source drained for a single reading earns the creator nothing.
  - `srcTvl`: the source's real TVL in quote units, the number Uniswap shows. v2: reserves. v3: the pool's token
    balances. v4: the hook counts the pool's liquidity ranges itself, 4 storage reads on the first trade of each
    block, and refreshes when a pass finishes (about 20 to 40 busy blocks for tick spacing 60 or 200; 0 means the
    first pass is not done yet). Two-hop: leg 1's TVL, converted at leg 2. Cross-chain: the home sender sends the real TVL;
    the pool's `tvlShift` converts it to local quote units (separate from the price's `decShift`).
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
