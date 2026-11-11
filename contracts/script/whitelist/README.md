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

SPACEHOOD's second hop is the first hooked, dynamic-fee pool in this list
(`fee = 0x800000`, hook `0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544`). Pass
that PoolKey through as-is. The router does not strip the hook or the fee
flag; afterSwap deltas are already in the `swap()` BalanceDelta, and min-out
is checked on that real output.

The dollar floor is per-side depth, not fee. A dynamic-fee pool is treated
the same as a static-fee pool of the same reserves.
