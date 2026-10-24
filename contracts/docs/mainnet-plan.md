# DISCIPLE mainnet plan

Scope: the combined stack from PRs #14 (anon launch), #16 (snipe split + creatorBuyMaxBps + redeploy prep), #27 (security fixes, including SEC-01) and #24 (indexer). Testnet rehearsal: `contracts/script/redeploy/redeploy.sh` (dry run is the default).

## 1. Ownership: Safe multisig
- Deploy from a fresh deployer EOA, then transfer **every** owner role to a Safe (suggested 3-of-5; signers on hardware wallets, at least 2 people/orgs).
- Owned contracts: Launchpad, FeeRouter, DiscipleHook, LockedLP, QuotePricer, ReferralRegistry, RewardsVault, AnonLauncher (`setOwner`), TrampWallManager, Migration. The deploy script ends with an ownership-transfer step. Verify each `owner()` == Safe and that the deployer holds no roles (also check `FeeRouter.setAuthorized` entries).
- Optional TimelockController (24–48h) between the Safe and the protocol for parameter changes. This mitigates SEC-04 (admin centralization). Keep emergency-only actions on the Safe directly.

## 2. Treasury and RewardsVault payout ops
- The treasury is a separate Safe (not the owner Safe). Set via `FeeRouter.setTreasury`, `LockedLP.setTreasury` and `AnonLauncher.setTreasury`.
- Fee flow: the 1% fee splits 33/33/33/1 (unchanged). The sniper tax (99% → 0 over 77 s) is escrowed in the curve and goes to LockedLP's compound bucket at graduation; RewardsVault gets it only if the coin hasn't graduated within `snipeEscrowTimeout` (default 30 days).
- RewardsVault `distribute`: run on a weekly cadence, proposed by an ops signer and executed by the Safe. Publish the distribution CSV and the tx hash. Reconcile vault balance against the indexer's sum of snipe-tax events before each payout.
- Treasury spend: Safe transaction with a written justification. Keep the monthly report from indexer data.

## 3. Parameter checklist (sign off each before broadcast)
| Param | Where | Testnet | Mainnet decision |
|---|---|---|---|
| PoolManager / V4 quoter / UniversalRouter | env | RH testnet addrs | canonical mainnet addrs |
| Default quote token + pool fee/tickSpacing/hooks | Launchpad.setDefaultQuote / QuotePricer.setPricePool | STRATEGY, 3000/60 | real quote token + deepest pool |
| QuotePricer.minLiquidity | QuotePricer | default | set to resist manipulation (SEC-03) |
| creatorBuyMaxBps | Launchpad | 77 (cap 700) | 77 |
| Anti-snipe window/tax | Hook/Launchpad consts | as coded | confirm |
| Sniper escrow timeout | Launchpad.setSnipeEscrowTimeout | 30 days | decide (1–365 days) |
| ANON_LAUNCH_FEE (USDG) | AnonLauncher | 0.25 USDG | decide |
| Trusted routers | Hook.setTrustedRouter | DiscipleRouter + UR | same (SEC-05: UR attribution is spoofable; document) |
| LockedLP.feeRouter / migration | LockedLP | wired by script | verify (SEC-01 fix) |
| Treasury / owner addresses | all | deployer | Safes |
| Hook address salt (flags) | Deploy | mined | re-mine for mainnet deployer |

## 4. Deploy order
1. Pre-flight: all tests are green (`forge test`, including security fuzz). Check every contract is under 24KB (`forge build --sizes`). Run `RH_FORK=1` fork tests against the mainnet fork. Run the dry run of `redeploy.sh` with mainnet env and review the gas estimate. The testnet run used 25.99M gas, about 0.00026 ETH at 0.01 gwei.
2. Core: QuotePricer → FeeRouter → LockedLP → Migration → Hook (CREATE2 with mined flags) → Launchpad → DiscipleRouter → TrampWallManager.
3. Wiring: `FeeRouter.setLaunchpad/setLockedLP/setAuthorized`, `LockedLP.setFeeRouter/setMigration/setPoolManager`, `Hook.setMigration/setPricer/setTrustedRouter`, `Launchpad.setPricer/setQuoteProbe/setDefaultQuote`, pricer pool.
4. Add-ons: RewardsVault (`setFeeRouter`, `FeeRouter.setRewardsVault`), AnonLauncher, MarketLens.
5. Ownership to the Safe (step 1). Treasury pointers to the treasury Safe.
6. `postprocess.mjs` writes `deployments/<chain>.json` and the web bundle. Then the indexer config, the frontend env, and a canary launch with a small creator buy, buy/sell through the router, and an anon launch.

## 5. Verification
- Verify source on the explorer for every contract (`forge verify-contract`, same solc 0.8.26, via_ir, cancun, optimizer settings).
- Run a script that reads all wiring getters and owners and diffs them against the deployment json. This becomes part of the CI artifact.
- The indexer replays from the deploy block, and its mcap matches the v4 pool (as on testnet: TRMP $45.3k, pool-derived).

## 6. Monitoring
- The indexer and API (PR #24) feed alerts for these:
  - an owner/parameter-change event (`CreatorBuyMaxSet`, setters, `OwnershipTransferred`);
  - an unusual snipe-tax volume;
  - a LockedLP `Unauthorized` revert spike;
  - a RewardsVault balance drift against expected;
  - a pricer price deviation above X% from the reference (SEC-03);
  - a failed-swap-rate spike, which would signal a gas-griefing pricer (SEC-09).
- Safe: notifications on proposals. Use Tenderly or Forta-style tx monitors on the owner Safe and treasury.
- Runbooks: pause or disable an add-on (AnonLauncher fee to max, owner rotation), replace the pricer pool, and rotate the relayer.

## 7. Alchemy dependency (blocking for gasless UX)
- Gas sponsorship is **not enabled** on the current Alchemy app ("Gas sponsorship is not enabled for this app"). Anon launches and session keys currently run self-paid.
- The current testnet `ALCHEMY_API_KEY` now returns `Must be authenticated!`, so the key needs rotating in the secrets.
- Before mainnet:
  1. Create an Alchemy app for the target chain with a Gas Manager policy. Scope it to DiscipleRouter, Launchpad, AnonLauncher and TrampWallManager, with per-user and global spend caps.
  2. Confirm the bundler, EntryPoint v0.7 and the MAv2 factory and modules are deployed on mainnet.
  3. Budget sponsorship spend.
  4. Plan a fallback: if the policy is exhausted, the UI falls back to self-paid.
- Session keys: ship per `session-keys.md`. Pinning the approve spender and the recipient is recommended before mainnet.

## 8. Open security items (from security-review.md)
- SEC-01 (High) is fixed in #27, and the redeploy must include it. The live testnet v2 stays vulnerable until then.
- SEC-02 and SEC-03 (Medium) are fixed in source on PR #44 (hook donation removed + LP-add gate, QuotePricer truncated TWAP); they ship with that redeploy. Ops: run a `QuotePricer.poke` keeper (~60 s), add TrampWallManager to the Safe ownership list, and verify `hook.isLiquidityManager(lockedLP/twm)`, and run a tramp/wall `pull` bot (earns `keeperTipBps`). SEC-04 is addressed by the Safe plus timelock.
- SEC-05 to SEC-09 are documented and accepted or tracked.


## TODO: ownership / multisig checklist (**blocking for mainnet**, SEC-04; full list in security-review.md "SEC-04 pre-mainnet requirement")

- [ ] Transfer `owner` / `admin` of FeeRouter, Launchpad, LockedLP, Migration, ReferralRegistry, UsdgDepositNotifier, QuotePricer, QuoteProbe, DiscipleRouter, TrampWallManager, RewardsVault, AnonLauncher, and DiscipleHook (`transferAdmin`) to the Safe multisig.
- [ ] Put a timelock on the wiring setters (`setLockedLP`, `setTreasury`, `setTrustedRouter`, `setPricer`, `setDepositHook`, `setAttestor`, `setLiquidityManager`).
- [ ] Check that one-shot setters are consumed at deploy: `DiscipleHook.setMigration`, `Migration.setLaunchpad`.
- [ ] Check that `isTrustedRouter` is true only for DiscipleRouter (never UniversalRouter).
- [ ] Set the `UsdgDepositNotifier` attestors (on-ramp watcher) and any `ReferralRegistry` attestors, or leave them empty on purpose.
- [ ] Redeploy (hook flags changed: BEFORE_INITIALIZE added; the salt is re-mined by Deploy.s.sol).
- [x] Post-graduation LP-share auto-compound (PR feat/lp-compound). Wire `hook.setCompounder(lockedLP, 250000)` + `lockedLP.setHook(hook)` (Deploy.s.sol does this); review `setCompoundParams` defaults.
- [x] Unabsorbed graduation quote → coin's compound quote bucket (decided 2026-10-16; `LockedLP._graduationQuoteLeftover`).
