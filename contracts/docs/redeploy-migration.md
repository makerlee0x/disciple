# Combined testnet redeploy — migration note (RH testnet 46630)

**Status:** prepared, NOT broadcast. The live site still runs on the v2 stack in `deployments/rh-testnet-46630.json`.

## Contents
- Core changes: FeeRouter (anti-snipe 70% RewardsVault / 30% treasury), Launchpad (`creatorBuyMaxBps`), BondingCurve and CurveDeployer (post-grad `mcapNow` reads the v4 pool and the live QuotePricer), and DiscipleHook (`setPricer`, so Trade-event mcap uses the live pricer).
- New contracts: RewardsVault, AnonLauncher, MarketLens.
- Everything else is redeployed because FeeRouter and Launchpad addresses are immutable in hook, curves, Launchpad, AntiSnipe and Migration.
- Reused: v4 PoolManager / Quoter / StateView / UniversalRouter / Permit2, mUSDG, test STRATEGY, and the STRATEGY/mUSDG reference pool (3000/60/no hook).

## One command
```bash
cd contracts
./script/redeploy/redeploy.sh               # fork dry run against the public RPC (default)
BROADCAST=1 ./script/redeploy/redeploy.sh   # real deploy
```
- Non-secret parameters are in `script/redeploy/env.testnet`. `PRIVATE_KEY` comes from `SECRETS_FILE` (default `/workspace/anypair/.secrets/testnet-deployer.env`).
- On-chain post-steps run inside `Deploy.s.sol`:
  - pricer pool `setPricePool(STRATEGY, ref pool)`, plus a sanity check that the price is > 0
  - `hook.setTrustedRouter(DiscipleRouter)` and `hook.setTrustedRouter(UniversalRouter)`
  - RewardsVault deploy, `vault.setFeeRouter`, `feeRouter.setRewardsVault`
  - `hook.setPricer(QuotePricer)`
  - AnonLauncher (0.25 USDG fee, ERC-5564 announcer) and MarketLens
- Off-chain post-steps (`postprocess.mjs`):
  - On broadcast, it writes `deployments/rh-testnet-46630.json`, moving the current stack under `previous` and setting `startBlock`. On a dry run it writes `rh-testnet-46630.dry-run.json` instead.
  - It also writes `deployments/web-bundle/{addresses.json,index.ts,abi/*.json}` for the site and game agents. The TS file exports `ADDRESSES`, `PREVIOUS_ADDRESSES`, `START_BLOCK` and all ABIs.

## Gas estimate (fork dry run, 2026-10-15)
- 25,989,493 gas total (forge, which includes its 1.3× buffer).
- At 0.01 gwei base this is about **0.00026 ETH**. Forge's max-fee bound is **0.00052 ETH**.
- Cross-check: node `eth_estimateGas` for the Launchpad create (L2 + L1 data) is 3.15M, against forge's 4.09M, so forge's figure is conservative on Arbitrum-style gas.
- Keep **≥ 0.001 ETH** on the deployer for the broadcast plus smoke.

## Note
**Dry-run addresses are not final:** they depend on the deployer nonce. Re-run postprocess after broadcast; the script does this automatically.

## Site / game migration checklist
1. Run the broadcast, then copy `deployments/web-bundle/index.ts` into `web/lib/abi` / `chains.ts`, or import it from there. Set `NEXT_PUBLIC_RHT_FROM_BLOCK` to the new `startBlock`.
2. ABI and event changes:
   - FeeRouter: `SnipeFeeRoutedToLP` is replaced by `SnipeFeeRouted(token, quote, toRewards, toTreasury)`; adds `rewardsVault()` and `setRewardsVault`.
   - Launchpad: adds `creatorBuyMaxBps()`, `creatorBuyMaxBpsOf(token)`, `CreatorBuyMaxSet`.
   - Hook: adds `pricer()` and `setPricer`.
   - New ABIs: RewardsVault, AnonLauncher, MarketLens.
3. Old coins (TRMP, etc.) stay on the old contracts and keep trading there. Index both stacks: the indexer in `/indexer` does this. Use `MarketLens` (old: `0x1d5f…59e9`) for old graduated coins' mcap.
4. Re-run the smoke tests: a launch with STRATEGY, a snipe-window buy (check 70/30 to vault and treasury), graduation, a router buy/sell, tramp/wall, and an anon launch plus batch claim.
5. Do not repoint old-stack Launchpad / FeeRouter owners; they keep serving old coins.

---

# JIT / TWAP / altitude redeploy (PR "flow/jit-twap", batched with #35 wallet cap) — 2026-10-16

**Status:** code + tests only. NOT deployed. Supersedes #35's "partial redeploy" note: the hook's permission bits change, so the v4 side must be redeployed too.

## Why the scope grows
- `DiscipleHook` now needs `BEFORE_ADD_LIQUIDITY_FLAG` (SEC-02 gate). Hook permissions are encoded in the hook **address**, so a new salt must be mined and the hook redeployed. Every contract that stores the hook immutably follows.
- `LockedLP` cannot be shared between the old and new stacks: it has a single `migration` slot, so re-pointing it at the new Migration would make every **pre-grad v3 coin's graduation revert** (`Unauthorized` on `addLockedLiquidity`). Deploy a fresh one.

## Redeploy list
| Contract | Redeploy? | Reason |
|---|---|---|
| DiscipleHook | **yes** (re-mine salt: `BEFORE_ADD_LIQUIDITY | BEFORE_SWAP | AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA`) | flags, TWAP oracle, altitude events, LP gate |
| Migration | **yes** | immutable `hook` |
| LockedLP | **yes** | see above (single migration slot); new hook's pools |
| TrampWallManager | **yes** | immutable `hook`/`lockedLP`; hold + fee vesting; now has an `owner` |
| DiscipleRouter | **yes** | immutable `hook`/`lockedLP` |
| QuotePricer | **yes** | TWAP + `poke` (state layout change) |
| Launchpad, CurveDeployer (→ BondingCurve) | **yes** | #35 wallet cap + `altitudeWindow` + pricer poke; curve oracle/altitude |
| AntiSnipe, AnonLauncher, MarketLens | **yes** | immutable `launchpad` (MarketLens also new `twapMcapUsd`) |
| FeeRouter | yes (recommended) | owner-settable, but `setLaunchpad` is single-valued (old coins' creator lookup); simplest is the full `Deploy.s.sol` stack. If reused: `setLaunchpad(new)`, `setLockedLP(new)`, `setAuthorized(newHook,true)` |
| RewardsVault, ReferralRegistry | optional reuse | owner-settable wiring (`vault.setFeeRouter`) |
| PoolManager / Quoter / StateView / UR / Permit2 / mUSDG / STRATEGY / ref pool | reuse | — |

`script/Deploy.s.sol` already does all of it (it now also calls `hook.setLiquidityManager(lockedLP)` and `hook.setLiquidityManager(trampWall)`). **New post-deploy checks:** `hook.isLiquidityManager(lockedLP) && hook.isLiquidityManager(twm)` (if LockedLP is missing, graduation reverts); `QuotePricer.setPricePool` initializes the quote oracle; run a keeper that calls `QuotePricer.poke(STRATEGY)` every ~60 s (anyone can; Launchpad also pokes on each launch); add TrampWallManager to the Safe ownership transfer list.

Sizes (runtime): Hook 12,645 B · BondingCurve 15,734 · CurveDeployer 17,990 · Launchpad 14,566 · TrampWallManager 12,817 · QuotePricer 7,542 · MarketLens 3,141 — all < 24,576.

## New owner/admin parameters (defaults)
| Where | Setter | Default | Meaning |
|---|---|---|---|
| DiscipleHook (admin) | `setAltitudeWindow(uint32)` 1..86400 | 300 s | TWAP window for post-grad tiers |
| DiscipleHook | `setMaxTickDelta(int24)` | 9116 | truncation per observation (~×2.49/block) |
| DiscipleHook | `setLiquidityManager(addr,bool)` | — | LP add allowlist |
| Launchpad (owner) | `setAltitudeWindow(uint32)` 1..86400 | 300 s | TWAP window for curve-phase tiers (read live by all new curves) |
| Launchpad | `setWalletCapBps` (#35) | 0 | per-wallet curve cap |
| QuotePricer (owner) | `setTwapParams(window, maxTickDelta)` | 1800 s, 2000 | quote/USD TWAP |
| TrampWallManager (owner) | `setJitParams(minHold, vest)` ≤ 7 d | 300 s, 3600 s | hold before cancel/pull; linear fee vesting |

## ABI / event changes for SITE / GAME
**Trade event: unchanged** (same signature, same fields; `mcapAfterUsd` is still SPOT). All existing events keep their shapes.

New interface `IAltitudeEvents`, emitted by **BondingCurve (pre-grad)** and **DiscipleHook (post-grad)** right after each `Trade`:
```solidity
event AltitudeUpdate(address indexed token, uint256 twapMcapUsd, uint256 spotMcapUsd, uint8 tier, uint32 window);
event TierBreak(address indexed token, uint8 fromTier, uint8 toTier, uint256 twapMcapUsd);
```
- `tier` is the 0..17 index of `web/lib/config.ts` `TIERS` (same breakpoints, `Altitude.tierOf`).
- **GAME:** drive tier breaks / altitude rewards / achievements from `TierBreak` (or `AltitudeUpdate.tier`), **not** from `Trade.mcapAfterUsd`. The rocket's visual height can keep following spot; "breaks" must follow TWAP.
- `window` = seconds actually covered (shorter while a coin/pool is young; 0 at the first observation).
- At graduation the hook emits one `AltitudeUpdate` (window 0) at the seeded curve-end mcap (normally tier 4, PEARLY GATES) without a `TierBreak`; from then on the hook's stream supersedes the curve's for that token. The curve's stream may still be at a lower tier at that point because its TWAP lags.
- Old (v3) coins don't emit these; SITE/GAME keep the spot fallback for them.

Function additions:
- DiscipleHook: `twapTick(PoolId,uint32)`, `twapPriceX18(PoolId,uint32)`, `twapMcapUsd(PoolId,uint32)`, `oracleState(PoolId)`, `altitudeTierOf(PoolId)`, `altitudeWindow()`, `maxTickDelta()`, `isLiquidityManager(address)`, setters above; events `LiquidityManagerSet`, `AltitudeWindowSet`, `MaxTickDeltaSet`; errors `OnlyLiquidityManager`, `BadParam`.
- BondingCurve: `twapMcapUsd(uint32)`, `altitudeWindow()`, `altitudeTier()`, `MAX_TICK_DELTA()`.
- Launchpad: `altitudeWindow()`, `setAltitudeWindow`, event `AltitudeWindowSet`, error `AltitudeWindowInvalid` (+ #35's `walletCapBps`, `walletCapBpsOf`, `setWalletCapBps`, `WalletCapSet`, `WalletCapTooHigh`).
- QuotePricer: `poke(address)`, `twapTick(address)`, `spotPriceUsd(address)`, `twapWindow()`, `maxTickDelta()`, `setTwapParams`; events `TwapParamsSet`, `Poked`; error `BadParam`. **Behaviour change:** `quotePriceUsd` is now the TWAP (display spot via `spotPriceUsd`).
- MarketLens: `twapMcapUsd(address token, uint32 window)` (falls back to spot with window 0 on old coins). `market`/`mcapNow` stay spot (display).
- TrampWallManager: `owner()`, `transferOwnership`, `setJitParams`, `minHoldSeconds()`, `feeVestSeconds()`, `MAX_HOLD()`, `placedAt(id)`, `unlockAt(id)`, `vestedBps(id)`, `claimableFees(id)`; events `JitParamsSet`, `OwnerTransferred`, `FeesForfeited(id, to, quoteFees, tokenFees)`; errors `OnlyOwner`, `BadParam`, `HoldActive(unlockAt)`. `positions(id)` tuple is **unchanged**.
  - **Semantics change:** `cancel`/`pull` revert `HoldActive` for `minHoldSeconds` after placement (UI: show a countdown from `unlockAt`). `claimFees`/`cancel`/`pull` pay only the vested share of fees; the rest goes to the treasury (`FeesForfeited`). `Cancelled.quoteFees/tokenFees` now report the **paid (vested)** fees. `pendingFees` stays gross; show `claimableFees` in the UI, and warn that claiming early forfeits the unvested part permanently.
  - Raw v4 LP adds to DISCIPLE pools (any router other than LockedLP/TrampWallManager) now revert.

Web bundle ABIs regenerated: DiscipleHook, BondingCurve, Launchpad, QuotePricer, TrampWallManager, MarketLens (`deployments/web-bundle/abi/*.json` + `index.ts`). Addresses unchanged until broadcast.
