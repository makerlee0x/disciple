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

# JIT guard / QuotePricer TWAP / tramp-wall auto-close / spot altitude (PR #44 `flow/jit-twap`, batched with #35 wallet cap). Revised 2026-10-16.

**Status:** code + tests only. NOT deployed. This supersedes #35's "partial redeploy" note. The hook's permission bits change, so the v4 side must be redeployed too.

**Revision 2 (user decisions):**
- Altitude/tier breaks use **SPOT** mcap; there is no TWAP and no window setter.
- The hook no longer keeps an oracle. The TWAP lives only in QuotePricer, for the launch-time quote price.
- TrampWallManager **fee vesting has been removed** (the 5-min hold was later removed in revision 3).
- Filled tramps/walls are **auto-closed** by keepers for a small tip.
- ~~Donation is unchanged~~ (superseded by revision 3).

**Revision 3 (2026-10-16, no LP yield):**
- The hook's in-range donation is **removed** (`PoolManager.donate`, `LPDonation`, `donationOf` gone). The full 33% LP share is auto-added to LockedLP.
- `FeeRouter.routeHookFee` lost its `donated` argument, so **FeeRouter must be redeployed** (the new hook calls the new ABI).
- TrampWallManager: the min hold is **removed** (cancel anytime, pull immediately) and `claimFees`/`pendingFees` are removed. Keeper tip and hook LP-add gate stay.

## Why the scope grows
- `DiscipleHook` now needs `BEFORE_ADD_LIQUIDITY_FLAG` for the SEC-02 LP-add gate. Hook permissions are encoded in the hook **address**, so a new salt must be mined and the hook redeployed. Every contract that stores the hook immutably follows.
- `LockedLP` cannot be shared between the old and new stacks. It has a single `migration` slot, so re-pointing it would make every **pre-grad v3 coin's graduation revert** (`Unauthorized`). Deploy a fresh one.

## Redeploy list
| Contract | Redeploy? | Reason |
|---|---|---|
| DiscipleHook | **yes**; re-mine the salt for `BEFORE_ADD_LIQUIDITY \| BEFORE_SWAP \| AFTER_SWAP \| AFTER_SWAP_RETURNS_DELTA` | new flags, LP gate, altitude events |
| Migration | **yes** | immutable `hook` |
| LockedLP | **yes** | single migration slot (see above) |
| TrampWallManager | **yes** | immutable `hook`/`lockedLP`; keeper tip, new `owner`, no fees/hold |
| DiscipleRouter | **yes** | immutable `hook`/`lockedLP` |
| QuotePricer | **yes** | TWAP + `poke` (state layout change) |
| Launchpad, CurveDeployer (→ BondingCurve) | **yes** | #35 wallet cap, pricer poke on launch, curve altitude events |
| AntiSnipe, AnonLauncher, MarketLens | **yes** | immutable `launchpad` (MarketLens code itself is unchanged) |
| FeeRouter | **yes (required)** | `routeHookFee` ABI changed (no `donated`); also `setLaunchpad` is single-valued |
| RewardsVault, ReferralRegistry | optional reuse | owner-settable wiring |
| PoolManager / Quoter / StateView / UR / Permit2 / mUSDG / STRATEGY / ref pool | reuse | — |

`script/Deploy.s.sol` does all of this. It also calls `hook.setLiquidityManager(lockedLP)` and `hook.setLiquidityManager(trampWall)`.

**Post-deploy checks:**
- `hook.isLiquidityManager(lockedLP) && hook.isLiquidityManager(twm)`. If LockedLP is missing, graduation reverts.
- `QuotePricer.setPricePool` initializes the quote oracle.
- Run a keeper that calls `QuotePricer.poke(STRATEGY)` about every 60 s. Anyone can call it, and Launchpad also pokes on each launch.
- Run, or let third parties run, a **tramp/wall closer bot**: watch `isFilled(id)` and call `pull(id)`. It earns `keeperTipBps`.
- Add TrampWallManager to the Safe ownership transfer.

Sizes (runtime, all < 24,576 B):
- Hook 8,204 B
- BondingCurve 11,506 B
- CurveDeployer 13,748 B
- Launchpad 14,358 B
- TrampWallManager 10,669 B
- FeeRouter 6,278 B
- QuotePricer 7,542 B
- MarketLens 2,380 B

## New owner/admin parameters (defaults)
| Where | Setter | Default | Meaning |
|---|---|---|---|
| DiscipleHook (admin) | `setLiquidityManager(addr,bool)` | LockedLP + TWM | LP add allowlist |
| QuotePricer (owner) | `setTwapParams(window, maxTickDelta)` | 1800 s, 2000 | quote/USD TWAP for launch price |
| TrampWallManager (owner) | `setKeeperTipBps(uint16)` ≤ 100 (1%) | 10 (0.1%) | keeper tip on pull |
| Launchpad (owner) | `setWalletCapBps` (#35) | 0 | per-wallet curve cap |

## ABI / event changes for SITE / GAME
**The `Trade` event is unchanged**, and all pre-existing events keep their shapes.

New `IAltitudeEvents`, emitted by **BondingCurve (pre-grad)** and **DiscipleHook (post-grad)** right after every `Trade` from the same contract:
```solidity
event AltitudeUpdate(address indexed token, uint256 mcapUsd, uint8 tier);
event TierBreak(address indexed token, uint8 fromTier, uint8 toTier, uint256 mcapUsd);
```
- Altitude is **spot**: `mcapUsd` == the `Trade.mcapAfterUsd` just emitted. `tier` is the 0..17 index of `web/lib/config.ts` `TIERS`, using the same breakpoints as `Altitude.tierOf`.
- `TierBreak` fires on any spot tier change, up or down, on the trade that caused it. GAME can use it directly or keep deriving tiers from `Trade.mcapAfterUsd`; both give the same result.
- At graduation the hook emits one `AltitudeUpdate` at the seeded curve-end mcap (normally tier 4, PEARLY GATES), with no `TierBreak`. From then on the hook's stream replaces the curve's.
- Getters: `BondingCurve.altitudeTier()` and `DiscipleHook.altitudeTierOf(PoolId)`.
- Old (v3) coins don't emit these events.

Function changes:
- **DiscipleHook:** removed `LPDonation` event and `donationOf`; added `isLiquidityManager(address)`, `setLiquidityManager`, `altitudeTierOf(PoolId)`; event `LiquidityManagerSet`; error `OnlyLiquidityManager`. Raw v4 LP adds to DISCIPLE pools (any router other than LockedLP/TWM) now revert.
- **BondingCurve:** `altitudeTier()`.
- **Launchpad:** #35's `walletCapBps`, `walletCapBpsOf`, `setWalletCapBps`, `WalletCapSet`, `WalletCapTooHigh`. `launch` now pokes the pricer (no ABI change).
- **QuotePricer:** `poke(address)`, `twapTick(address)`, `spotPriceUsd(address)`, `twapWindow()`, `maxTickDelta()`, `setTwapParams`; events `TwapParamsSet`, `Poked`; error `BadParam`. **Behaviour change:** `quotePriceUsd` is now the TWAP (use `spotPriceUsd` for display).
- **TrampWallManager:**
  - Additions: `owner()`, `transferOwnership`, `setKeeperTipBps`, `keeperTipBps()`, `MAX_KEEPER_TIP_BPS()`.
  - Removed: `claimFees`, `pendingFees`, event `FeesClaimed`.
  - New events: `KeeperTipSet`, `OwnerTransferred`, `KeeperTipPaid(uint256 indexed id, address indexed keeper, uint256 quoteTip, uint256 tokenTip)`.
  - New errors: `OnlyOwner`, `BadParam`.
  - `positions(id)` is **unchanged**.
  - **Semantics:**
    - No hold: `cancel` works any time, `pull` as soon as `isFilled`.
    - `pull` now pays a keeper tip to `msg.sender`: `keeperTipBps` of each asset paid out (proceeds). `Filled.quoteOut/tokenOut` are the owner's net amounts; the tip is in `KeeperTipPaid`.
    - No yield: `Cancelled.quoteFees/tokenFees` are always 0.
- **FeeRouter:** `routeHookFee(token, feeToken, trader, creator, feeAmount)` (was 6 args with `donated`). Events unchanged; `TradeFeeRouted.lpShare` is the full 33%.
- MarketLens: unchanged.

The web-bundle ABIs are regenerated (`deployments/web-bundle/abi/*.json` + `index.ts`). Addresses stay unchanged until broadcast.
