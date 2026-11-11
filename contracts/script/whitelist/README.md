# Launch whitelist — owner wiring (do not broadcast from this folder)

This is the local / testnet config for the 12 launch-whitelist quote tokens. Owner
setters (`setAllowedQuote`, `setPriceRoute`, `setUsdgRoute`) are a documented
manual owner step. Nothing in this folder is a broadcast script, and nothing
here is sent on mainnet from CI or the web app.

Lee removed BUN on Nov 10, 2026 and replaced it the same day with SPACEHOOD
(stock-pool route via SPCX). Native-ETH settlement was not built; the router
still accepts a mid token of `address(0)` in `setUsdgRoute` so a native-ETH
route can be added later without a redeploy.

## What the owner does (testnet or a later mainnet deploy, only when lee says)

1. Deploy the new DiscipleRouter, QuotePricer, and QuoteProbe (Launchpad,
   BondingCurve, and LockedLP are unchanged).
2. Point Launchpad at the new pricer and probe, and re-trust the new router
   (`setTrustedRouter`, FeeRouter `setClaimRouter`, hook `setTrustedRouter`).
3. `setUsdgRouting(usdg, launchpad)` on the router.
4. For each row in `routes.json`:
   - `pricer.setAllowedQuote(quote, true)`
   - `pricer.setPriceRoute(quote, keys)` — same PoolKeys, USDG-first
   - `router.setUsdgRoute(quote, keys)` — same PoolKeys
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

Depths below are official virtual per-side figures from StateView (same
formula as QuotePricer), measured on Robinhood mainnet around block
111,298,000 on November 10, 2026 (America/Chicago). They will move.

## Route table

Stock-pool coins stay on their long.xyz stock pair for the second hop,
regardless of speed. Leg 1 is the deepest Uniswap v4 USDG / stock-token pool.

| Quote | Route | Leg 1 (USDG / stock) | Leg 2 (stock pair) | Per-side depth |
| --- | --- | --- | --- | --- |
| STRATEGY | USDG → MSTR → STRATEGY | id `0x319bac87…`, fee 2500 (0.25%), tickSpacing 25, no hook | id `0xa6975f47…`, fee `0x800000`, tickSpacing 8, long.xyz hook `0x4e346895…` | leg 1 ~$5,817,096; leg 2 ~$201,368 |
| AI | USDG → NVDA → AI | id `0x3bb34a44…`, fee 3000 (0.3%), tickSpacing 60, no hook (a deeper NVDA/USDG 0.05% pool is Uniswap v3 only and is not used) | id `0xcbdfea90…`, fee `0x800000`, tickSpacing 8, long.xyz hook `0x4e346895…` | leg 1 ~$734,945; leg 2 ~$745,020 |
| SCHIFFY | USDG → GLD → SCHIFFY | id `0xfe281bbf…`, fee `0x800000`, tickSpacing 10, hook `0xB608a787…` (not DISCIPLE) | id `0xc749412e…`, fee `0x800000`, tickSpacing 8, long.xyz hook `0x4e346895…` | leg 1 ~$12,808,598; leg 2 ~$194,597 |
| BONER | USDG → HIMS → BONER | id `0x68d4f28f…`, fee 9000 (0.9%), tickSpacing 90, no hook | id `0x9c89b043…`, fee `0x800000`, tickSpacing 8, long.xyz hook `0x4e346895…` | leg 1 ~$1,137,707; leg 2 ~$280,788 |
| MEME | USDG → AMC → MEME | id `0x7499938c…`, fee 1000 (0.1%), tickSpacing 10, no hook | id `0x27ccf0a6…`, fee `0x800000`, tickSpacing 8, long.xyz hook `0x4e346895…` | leg 1 ~$1,107,808; leg 2 ~$415,097 |
| MOO | USDG → MU → MOO | id `0x6fa3ee00…`, fee 10000 (1%), tickSpacing 200, no hook | id `0xc3cc877a…`, fee `0x800000`, tickSpacing 8, long.xyz hook `0x4e346895…` | leg 1 ~$1,148,112; leg 2 ~$110,039 |
| SPACEHOOD | USDG → SPCX → SPACEHOOD | id `0x1f5bf0b4…`, fee `0x800000`, tickSpacing 60, SessionFeeHook `0xC15b155a…` | id `0x225cc98f…`, fee `0x800000`, tickSpacing 8, long.xyz hook `0x4e346895…` | leg 1 ~$533,978; leg 2 ~$86,736 |

Single-swap coins use one Uniswap v4 USDG pool:

| Quote | Pool | Fee / spacing / hook | Per-side depth |
| --- | --- | --- | --- |
| PONS | id `0x486435a1…` (deepest USDG v4, dynamic fee) | fee `0x800000`, tickSpacing 60, hook `0x08E52564…` (not DISCIPLE) | ~$1,158,627. An unhooked 0.3% USDG pool (`0x4be9657e…`, ~$316,928 / side) is the documented fallback if this hooked pool fails a fork, floor, or probe. |
| ORBIO | id `0xea9f200e…` | fee 8000 (0.8%), tickSpacing 80, no hook | ~$703,912 |
| HOOKR | id `0x0b362d89…` (the 1% USDG pool) | fee 10000, tickSpacing 100, no hook | ~$102,666. The 5.5% pool (`0x9d30491d…`, ~$43,278 / side) is also above the floor but thinner on official virtual depth. The 3.04% pool (`0xe9e93bd1…`) is not used. |
| CASHCAT | id `0xa92a3df2…` | fee 2690 (0.269%), tickSpacing 54, no hook | ~$323,007 |
| PRIORS | id `0xff7b3bd2…` | fee 0, tickSpacing 200, hook `0xE5e70264…` (not DISCIPLE) | ~$124,816. This is a Uniswap v4 pool on the official PoolManager (Initialize confirmed). Some indexers label it as a PONS v2 pool. |

The long.xyz hook on every stock second hop (and SPACEHOOD) is
`0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544`.
