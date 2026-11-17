# Testnet launch-pair coins (Robinhood testnet 46630)

These scripts give testnet the same launch-pair coins as mainnet, so launching, trading and creator fees can be tested with every coin.

Each coin is a stand-in made the same way as the testnet STRATEGY. It is a `DevToken` from `Deploy.s.sol` (open `mint()`, 18 decimals), priced at its mainnet USD price from Nov 16, 2026. Its pools are seeded through a `PoolModifyLiquidityTest` helper, like `_seedRefPool`. Each coin is then allowed and routed on the testnet QuotePricer and DiscipleRouter.

## Scripts

- `SeedTestnetLaunchCoins.s.sol` deploys the stand-ins, seeds their pools, and sends `setAllowedQuote`, `setPriceRoute` and `setUsdgRoute` as the pricer and router owner. With `WRITE_OUT=true` it writes `deployments/testnet-launch-coins.json`.
- `SeedTestnetDelta.s.sol` adds the DELTA stand-in to that set, using the existing liquidity helper. It seeds a hookless USDG/DELTA v4 pool with fee 19900 and tickSpacing 199, matching mainnet after DELTA replaced HMM.
- `RunTestnetLaunchE2E.s.sol` checks every coin from start to finish.
  - `PHASE=launch` launches one coin paired with each pair coin. It also makes two CreatorFeeHarvest launches: AI with creator fees locked into its pool, and HOOKR with creator fees burned. It writes `deployments/testnet-launch-e2e.json`.
  - `PHASE=trade` must run at least 7 seconds later, after the snipe window. For each coin it buys with 5 USDG through `buyWithUsdg`, sells half through `sellToUsdg`, checks that a creator fee accrued, and then claims it, or routes it through CreatorFeeHarvest.

- `RunTestnetDeltaE2E.s.sol` launches one coin paired with DELTA, then (at least 7 seconds later) buys with 100 USDG, sells half, and claims the creator fee.

The transaction hashes from the Nov 16, 2026 run, and the Nov 17 DELTA add, are in `deployments/testnet-launch-coins-txs.json`.

## How the testnet routes differ from mainnet

Testnet has no Uniswap hooks for these pools, so every testnet pool has no hook and a static fee. Where a mainnet pool uses a dynamic fee, the testnet pool uses a fixed fee instead.

| Coin | Mainnet route | Testnet route |
| --- | --- | --- |
| STRATEGY | USDG to MSTR to STRATEGY | Unchanged. It keeps its existing single USDG/STRATEGY pool, because that route already works. |
| AI | USDG to NVDA to AI (long.xyz hook, dynamic fee) | USDG to NVDA stand-in (0.3%/60) to AI (1%/8) |
| SCHIFFY | USDG to GLD to SCHIFFY (dynamic fees) | USDG to GLD stand-in (0.3%/10) to SCHIFFY (1%/8) |
| BONER | USDG to HIMS to BONER (dynamic fee on leg 2) | USDG to HIMS stand-in (0.9%/90) to BONER (1%/8) |
| MEME | USDG to AMC to MEME (dynamic fee on leg 2) | USDG to AMC stand-in (0.1%/10) to MEME (1%/8) |
| MOO | USDG to MU to MOO (dynamic fee on leg 2) | USDG to MU stand-in (1%/200) to MOO (1%/8) |
| PONS | USDG to PONS (dynamic fee) | USDG to PONS (0.3%/60) |
| ORBIO | USDG to ORBIO | USDG to ORBIO (0.8%/80) |
| HOOKR | USDG to ETH to HOOKR | USDG to native ETH (0.05%/10) to HOOKR (0.25%/25) |
| CASHCAT | USDG to CASHCAT | USDG to CASHCAT (0.269%/54) |
| PRIORS | USDG to PRIORS (hooked, dynamic fee) | USDG to PRIORS (0%/200) |
| PENGU | USDG to ETH to PENGU | USDG to native ETH (0.05%/10) to PENGU (1%/100) |
| HMM | Not on the mainnet list | USDG to HMM (3.4267%/666) |
| DELTA | USDG to DELTA | USDG to DELTA (1.99%/199) |

The pools with ERC-20 tokens on both sides are full range, with about $250,000 per side.

The native-ETH pools started small, because the deployer had very little testnet ETH. Each began as a single position 20 ticks below the top of its range, worth about $20,000 per side virtually, with about $20 of real ETH.

`DeepenTestnetEthPools.s.sol` then added ETH-only positions 400 ticks wide just above the price: 0.17 ETH to USDG/ETH, and 0.1 ETH each to ETH/HOOKR and ETH/PENGU. USDG buys of HOOKR and PENGU share the USDG/ETH ETH, about $300 in total. Sells of each coin draw on its own pool, about $180 each. A $100 buy and sell on each coin went through on Nov 16, 2026.

HMM was taken off the pricer's allowed list after the first run (`setAllowedQuote(HMM, false)`). Its pools and routes are still in place.

On Nov 17, 2026, main replaced HMM with DELTA. `SeedTestnetDelta.s.sol` added a DELTA stand-in on testnet: one hookless USDG/DELTA pool (fee 19900, tickSpacing 199) at about $0.007857, with $250,000 per side. A $100 buy and sell on a coin launched against it went through, and creator fees accrued. MOO is not on main's list; the testnet MOO stand-in was left as it is.

Anyone can remove liquidity held by the `PoolModifyLiquidityTest` helper. That is fine on testnet, and it is the same as the existing testnet STRATEGY pool.

## Run

```
cd contracts
# simulate on a local fork first
anvil --fork-url https://rpc.testnet.chain.robinhood.com --port 8546
forge script script/testnet/SeedTestnetLaunchCoins.s.sol --rpc-url http://127.0.0.1:8546 --sender <owner> --unlocked --broadcast
# then testnet, with the deployer env sourced in the same command
WRITE_OUT=true forge script script/testnet/SeedTestnetLaunchCoins.s.sol --rpc-url "$RH_TESTNET_RPC" --private-key "$PRIVATE_KEY" --broadcast --slow
PHASE=launch forge script script/testnet/RunTestnetLaunchE2E.s.sol --rpc-url "$RH_TESTNET_RPC" --private-key "$PRIVATE_KEY" --broadcast --slow
PHASE=trade forge script script/testnet/RunTestnetLaunchE2E.s.sol --rpc-url "$RH_TESTNET_RPC" --private-key "$PRIVATE_KEY" --broadcast --slow
# later add-on (Nov 17 2026): DELTA stand-in and a $100 end-to-end check
forge script script/testnet/SeedTestnetDelta.s.sol --rpc-url "$RH_TESTNET_RPC" --private-key "$PRIVATE_KEY" --broadcast --slow
PHASE=launch forge script script/testnet/RunTestnetDeltaE2E.s.sol --rpc-url "$RH_TESTNET_RPC" --private-key "$PRIVATE_KEY" --broadcast --slow
PHASE=trade forge script script/testnet/RunTestnetDeltaE2E.s.sol --rpc-url "$RH_TESTNET_RPC" --private-key "$PRIVATE_KEY" --broadcast --slow
```
