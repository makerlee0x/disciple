# Launch whitelist — owner wiring (do not broadcast from this folder)

This is the config for the 12 launch-pair quote tokens plus the optional ETH and
USDG pairs. Owner setters (`setAllowedQuote`, `setPriceRoute`, `setUsdgRoute`)
are a manual owner step. `WireWhitelistRoutes.s.sol` sends them, but only when
someone adds `--broadcast`; without it, it only simulates. Nothing here is sent
from CI or the web app.

Lee removed BUN on Nov 10, 2026 and replaced it the same day with SPACEHOOD.
On Nov 16, 2026 he dropped SPACEHOOD and added PENGU. He added HMM too, then
swapped it back out for MOO the same morning ("just do moo instead of hmm"). HOOKR and
PENGU trade against native ETH, so their routes go USDG → ETH → coin. The router
already accepts a mid token of `address(0)` in `setUsdgRoute`, and the hops net
out inside one PoolManager unlock, so no router change was needed. The fork test
buys through both ETH routes and checks the router holds no ETH afterwards.

## What the owner does (testnet or a later mainnet deploy, only when lee says)

1. Deploy the new DiscipleRouter, QuotePricer, and QuoteProbe (Launchpad,
   BondingCurve, and LockedLP are unchanged).
2. Point Launchpad at the new pricer and probe, and re-trust the new router
   (`setTrustedRouter`, FeeRouter `setClaimRouter`, hook `setTrustedRouter`).
3. `setUsdgRouting(usdg, launchpad)` on the router.
4. For each row in `routes.json` `quotes` (or run `WireWhitelistRoutes.s.sol`):
   - `pricer.setAllowedQuote(quote, true)`
   - `pricer.setPriceRoute(quote, keys)` — same PoolKeys, USDG-first
   - `router.setUsdgRoute(quote, keys)` — same PoolKeys

   For `optionalQuotes` ETH (WETH), the script sends only `setPriceRoute` and
   `setUsdgRoute`, so the route is ready but the pair stays off. USDG needs no
   route (see below).
5. Confirm `quotePriceUsd(quote)` returns a live price (no warmup) and that
   `usdgRouteOf(quote)` matches the table.

Every PoolKey in `routes.json` was confirmed from an Initialize event on the
Uniswap v4 PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951` and by
hashing the key to the pool id. The dollar floor is per-side virtual depth,
not fee. A dynamic-fee pool (`fee = 0x800000`) is treated the same as a
static-fee pool of the same reserves. The router rejects only the DISCIPLE
hook; every other hook below is passed through as-is. After-swap deltas are
already in the `swap()` BalanceDelta, and min-out is checked on that real
output.

Depths and quotes below are from StateView and the v4 Quoter
`0x8dc178efb8111bb0973dd9d722ebeff267c98f94` on Robinhood mainnet at block
115,888,826 (November 16, 2026, America/Chicago). Depth is official virtual
per-side depth (same formula as QuotePricer). Impact is the $100 / $1,000 quote
against a $1 quote, so it leaves out pool fees. They will move.

## Route table

Stock-pool coins stay on their long.xyz stock pair for the second hop.
Leg 1 is the deepest Uniswap v4 USDG / stock-token pool.

| Quote | Route | Leg 1 (USDG / stock) | Leg 2 (stock pair) | Per-side depth | Impact $100 / $1k |
| --- | --- | --- | --- | --- | --- |
| STRATEGY | USDG → MSTR → STRATEGY | id `0x319bac87…`, fee 2500 (0.25%), tickSpacing 25, no hook | id `0xa6975f47…`, fee `0x800000`, tickSpacing 8, long.xyz hook `0x4e346895…` | leg 1 ~$2,795,774; leg 2 ~$181,946 | 5.8 / 57.9 bps |
| AI | USDG → NVDA → AI | id `0x3bb34a44…`, fee 3000 (0.3%), tickSpacing 60, no hook (a deeper NVDA/USDG 0.05% pool is Uniswap v3 only and is not used) | id `0xcbdfea90…`, fee `0x800000`, tickSpacing 8, long.xyz hook `0x4e346895…` | leg 1 ~$1,154,764; leg 2 ~$673,162 | 2.3 / 23.3 bps |
| SCHIFFY | USDG → GLD → SCHIFFY | id `0xfe281bbf…`, fee `0x800000`, tickSpacing 10, hook `0xB608a787…` (not DISCIPLE) | id `0xc749412e…`, fee `0x800000`, tickSpacing 8, long.xyz hook `0x4e346895…` | leg 1 ~$4,052,642; leg 2 ~$160,189 | 6.4 / 64.3 bps |
| BONER | USDG → HIMS → BONER | id `0x68d4f28f…`, fee 9000 (0.9%), tickSpacing 90, no hook | id `0x9c89b043…`, fee `0x800000`, tickSpacing 8, long.xyz hook `0x4e346895…` | leg 1 ~$1,377,826; leg 2 ~$223,459 | 5.1 / 51.1 bps |
| MEME | USDG → AMC → MEME | id `0x7499938c…`, fee 1000 (0.1%), tickSpacing 10, no hook | id `0x27ccf0a6…`, fee `0x800000`, tickSpacing 8, long.xyz hook `0x4e346895…` | leg 1 ~$2,132,903; leg 2 ~$347,893 | 3.3 / 33.2 bps |
| MOO `0xD9dB30BB…1e18` | USDG → MU → MOO | id `0x6fa3ee00…`, fee 10000 (1%), tickSpacing 200, no hook | id `0xc3cc877a…` (the pool maker gave), fee `0x800000`, tickSpacing 8, long.xyz hook `0x4e346895…` | leg 1 ~$1,355,099; leg 2 ~$105,795 | 9.9 / 99.0 bps |

MOO's direct v4 USDG / MOO pools are much thinner: `0x50b29d33…` (3.94%, ~$6,249 per side,
impact 149.7 / 1330.0 bps) and `0x85a3cd05…` (2%, ~$3,357 per side,
impact 280.6 / 2268.6 bps). They are not used.

Native-ETH coins use the deepest unhooked v4 USDG / native ETH pool for leg 1
(id `0x387bf619…`, fee 500 (0.05%), tickSpacing 10, no hook, ~$5,089,869 per
side). A hooked dynamic-fee USDG / ETH pool (`0xa791e516…`, hook `0x987E330F…`)
quoted about 0.1% better at $1,000 but is not used because its hook can change
the fee.

| Quote | Route | Leg 2 | Per-side depth (leg 2) | Impact $100 / $1k |
| --- | --- | --- | --- | --- |
| HOOKR | USDG → ETH → HOOKR | id `0x590dcb6a…`, native ETH / HOOKR, fee 2500 (0.25%), tickSpacing 25, no hook | ~$328,305 | 3.2 / 32.2 bps |
| PENGU `0x74BE72AF…625f` | USDG → ETH → PENGU | id `0x38cbd4b1…`, native ETH / PENGU, fee 10000 (1%), tickSpacing 100, no hook (the only PENGU / ETH v4 pool) | ~$188,376 | 5.4 / 54.1 bps |

HOOKR used to be one swap on the 1% USDG pool (`0x0b362d89…`, ~$48,513 per side).
On the same block that pool's impact was 20.1 / 198.7 bps, so the ETH route is
both what maker asked for and deeper.

Single-swap coins use one Uniswap v4 USDG pool:

| Quote | Pool | Fee / spacing / hook | Per-side depth | Impact $100 / $1k |
| --- | --- | --- | --- | --- |
| PONS | id `0x486435a1…` (deepest USDG v4, dynamic fee) | fee `0x800000`, tickSpacing 60, hook `0x08E52564…` (not DISCIPLE) | ~$561,171. An unhooked 0.3% USDG pool (`0x4be9657e…`) is the documented fallback if this hooked pool fails a fork, floor, or probe. | 1.8 / 17.7 bps |
| ORBIO | id `0xea9f200e…` | fee 8000 (0.8%), tickSpacing 80, no hook | ~$396,681 | 2.5 / 24.9 bps |
| CASHCAT | id `0xa92a3df2…` | fee 2690 (0.269%), tickSpacing 54, no hook | ~$493,211 | 2.0 / 20.2 bps |
| PRIORS | id `0xff7b3bd2…` | fee 0, tickSpacing 200, hook `0xE5e70264…` (not DISCIPLE) | ~$101,764. A Uniswap v4 pool on the official PoolManager (Initialize confirmed). Some indexers label it as a PONS v2 pool. | 9.7 / 97.2 bps |

The long.xyz hook on every stock second hop is
`0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544`.

## Optional pairs (off at launch)

Maker's rule (Nov 16, 2026): USDG and ETH are off at launch and can be turned on later.

| Pair | On-chain | Web switch |
| --- | --- | --- |
| ETH (as WETH `0x0Bd7D308…AD73`) | Route is wired but not listed: USDG → ETH (`0x387bf619…`) → WETH (`0x207783b4…`, native ETH / WETH, fee 500, tickSpacing 1, no hook, ~$176,661,678 per side). Impact 0.2 / 2.0 bps. To turn on: owner `pricer.setAllowedQuote(WETH, true)`. Until then, a WETH launch reverts `QuoteNotListed`. | `NEXT_PUBLIC_PAIR_ETH=1` |
| USDG | Nothing to wire. USDG is the launchpad's $1 reference, and `setUsdgRoute` and `setAllowedQuote` both reject it. | `NEXT_PUBLIC_PAIR_USDG=1` |

The direct v4 WETH / USDG pool (`0x84bd4e2d…`, 0.02%, ~$114,405 per side) is
not used: its impact was 8.6 / 83.9 bps.

SPACEHOOD and HMM are not wired. Their keys stay under `dropped` in
`routes.json` for reference. HMM's only usable v4 pool (`0xbe59bf5d…`, v4 HMM /
USDG, 3.4267%) had ~$15,990 per side and impact 59.4 / 595.1 bps.

## Wiring script and checks

- `WhitelistRoutes.sol` has the same rows as `routes.json`, in Solidity.
- `WireWhitelistRoutes.s.sol` sends the owner calls in README order. It needs
  `ROUTER` and `PRICER` and refuses any chain other than 4663:

  ```
  ROUTER=0x… PRICER=0x… forge script script/whitelist/WireWhitelistRoutes.s.sol \
    --rpc-url https://rpc.mainnet.chain.robinhood.com --sender <owner>
  ```

  Without `--broadcast` it only simulates. Sending needs lee's yes.
- `test/fork/WhitelistRoutes.t.sol` makes the same calls on a mainnet fork. For
  every row it checks the key hashes to the pool id and the pool is initialized,
  then checks the price floor and `QuoteProbe`. It also buys $100 and $1,000 with
  min-out and checks for router dust (including native ETH). A second test checks
  that `routes.json` and `WhitelistRoutes.sol` match.
- `owner-txs.mainnet.json` lists the 38 calls (function, args, calldata) from
  that dry run. Calldata does not depend on the router or pricer address.
