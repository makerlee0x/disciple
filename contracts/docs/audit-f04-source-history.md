# F-04: source history, not sampled spot

`QuotePricer.poke` no longer writes price observations. A registered non-USDG
reference pool must have a compatible swap-written oracle hook. The provided
`QuoteSourceOracle` records every swap's pre-swap tick, authenticated by the
immutable PoolManager, and integrates it over the actual elapsed interval.
Its live tail uses the pool's current tick: move → poke → restore in one timestamp
has zero duration and cannot become an 1,800-second observation. Matching two
permissionless spot samples would NOT prove this and is intentionally not used.

The complete `twapWindow` must be available (not a shortened startup window).
Ring-buffer exhaustion before a full window also fails closed. Source-pool swaps
pay the history SSTORE; no waits or extra rounds are added to trade taps.

## Owner / rollout decision

Existing hookless v4 pools cannot acquire a hook in place and cannot be used for
safety pricing after this change. Permissionless discovery remains available,
but a discovered hookless pool fails closed even after `autoWarmup`. The owner
must select and seed a compatible source pool, wait for REAL source history,
and register that pool. Verify its hook implementation and immutable manager;
owner registration is the trust boundary, not proof a third-party hook is safe.
No pool has been created, no liquidity moved, and no deployment performed here.
The existing deployment script assumes hookless reference-pool pricing and needs
an explicit source-pool rollout plan before it can succeed unchanged.

`maxTickDelta` / `setTwapParams(window,maxDelta)` remain ABI-compatible legacy
settings; exact source history is not truncated by poke. `window` remains active.
`Poked` is retained in the ABI, but pokes no longer emit sampled tick records.
USDG's existing $1 assumption and near-TWAP (<=2 bp) spot precision fallback are
unchanged. A real TWAP is still economically manipulable by holding a changed
source price over time; this fix removes the fabricated persistence, not that risk.
Launchpad/BondingCurve production source is untouched. No paymaster/web edits.
