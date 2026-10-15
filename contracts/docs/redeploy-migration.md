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
