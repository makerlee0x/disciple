# flow/curve-lp-accrue: results (Nov 9 2026, CT)

Base: `flow/gasless-permit2` @ a8154368. Branch `flow/curve-lp-accrue`. Testnet only. Built and tested locally. Nothing on-chain, no PR, no merge.
Lee's go-aheads (via COO): 7:28 PM "ok yes then bundle the lp share"; 7:32 PM 12-day rule for sniper fees and LP fees; 7:37 PM drop the on-chain verified record; 7:39 PM standing rule: add no mechanism beyond the brief.
Prior work in git history: no curve fee accrual to reuse (the only "owed" commits are the paymaster and keeper jars).

## Design (NEW curves only; existing curves, FeeRouter, LockedLP, Migration, AscensionHook/AscensionHook unchanged)
Copied pattern: **Uniswap v3 accrue-then-collect**. In v3, Position.tokensOwed0/1 grow on every swap and NonfungiblePositionManager.collect() pays out later. It is named in the NatSpec of BondingCurve and CurveFeeVault.
- **Per trade (unreferred trader):** the curve only adds `protoFee` and `creatorTax` to `protoFeesOwed` and `creatorTaxOwed`. These are `uint112`, packed in the same slot as `graduated`, so it is one warm SSTORE. There is no transfer and no FeeRouter or LockedLP call. The quote stays in the curve, outside `quoteReserve`. `_prepaid` (audit L3) counts it as owed.
- **Referred trader** (ReferralRegistry.referrerOf != 0, one view call per trade): the fee settles inside the same trade, so the trader's referrer still gets exactly their 1%. A referrer only exists at trade time, so this cannot be deferred.
- **settleFees()** (the "collect"; permissionless, a no-op when nothing is owed) does three things:
  - keeps the LP 33% (same FeeMath rounding) in `lpFeeEscrow`;
  - transfers creator, treasury and the 1% (plus creator tax) to **CurveFeeVault**;
  - calls `vault.settleCurveFee` (named `settle` on flow/curve-lp-accrue; renamed on the follow-ups branch so its selector sorts first in the vault's dispatcher), which copies FeeRouter._route's split exactly, minus the LP push. That covers creatorOf, the launch-KOL 1% plus the kolCreatorShareBps cut, the referral sink, and treasury, all read live from the deployed FeeRouter and Launchpad.
- **Graduation:** `_graduate` settles first. `snipeEscrow()` now returns `sniperTaxEscrow + lpFeeEscrow`, and Migration already reads that selector as non-floor quote, so the LP share lands in LockedLP's **locked compound bucket**. Tested: the bucket is byte-identical to the old curve's on the same trade sequence (31415180580718714992 = 31415180580718714992).
- **12-day rule:**
  - `Constants.SNIPE_ESCROW_TIMEOUT` is now 12 days (was 30). It stays owner-tunable at 1–365 days and is snapshotted per curve.
  - `releaseSnipeEscrow()` settles first, then sends the sniper tax **and** `lpFeeEscrow` to `FeeRouter.rewardsVault()`. It emits `SnipeEscrowReleased` (sniper part) and `LpFeeEscrowReleased` (LP part).
  - Only the escrows move, never `quoteReserve`, `rewardsHeld` or the token inventory.
  - **LP rule (lee, Nov 9 2026, 10:17 PM CT; replaces the L2 cap):** "if the coin never graduates, those lp fees should always go to the creator rewards. if the coin graduates at a later date for whatever reason after the 12 days, they just wont get those lp fees at all. it'll just go to the creator rewards." Not graduated by launch + 12 days ⇒ **all** curve LP fees (before and after day 12) go to RewardsVault; only a graduation within 12 days sends them to the compound bucket. The release is repeatable (each call settles and sends everything owed since the last one) and a graduation after day 12 sends the remaining `lpFeeEscrow` to RewardsVault. Decided only at release or graduation, never per trade. See "Follow-ups" below.
  - A release with nothing new reverts `ZeroAmount` (no state change), same as today.
- **Claims mid-curve:** these are CurveFeeVault functions, and each settles first, then pays:
  - `claimCreatorFees(token)` settles that coin first. The quote is read from the curve, never supplied by the caller.
  - `claimReferrerFees(quote, tokens[])` and `claimTreasury(quote, tokens[])` settle the listed coins first. `claimTreasury` is permissionless and pays FeeRouter.treasury().
  - Only the coin's registered curve can call `vault.settleCurveFee`.
- **Why a new contract:** the deployed FeeRouter is immutable in Launchpad and always pushes 33% to LockedLP inside `_route`. It cannot credit creator, treasury or referral without also moving the LP share, and that would break "LP fees go to the vault if the coin doesn't bond".
- **Login:** new curves drop the on-chain PvE LoginGate check (the `verifiedUntil` read and the 10-min cache). This is app-level gating, as pump.fun and FOMO do it: login is enforced off-chain at the app and relay, and the contracts are permissionless. `loginGate` stays as an immutable so web/lib/legacyGate.ts doesn't mark new coins as legacy. `verifiedUntilOf` always returns 0. The constructor no longer requires a gate for PvE.
- Fee split (33/33/33/1, Constants.sol:119-124) unchanged. Code size: BondingCurve runtime 23,631 B (was 24,159; limit 24,576). CurveFeeVault 3,774 B. CurveDeployer now takes `feeVault` in its constructor; Launchpad's deploy call is unchanged.
- Deploy script (NOT run): `contracts/script/lpaccrue/DeployLpAccrue.s.sol` deploys the vault and the deployer. With WIRE=true (owner only) it also runs `Launchpad.setCurveDeployer(new)` and, if needed, `setSnipeEscrowTimeout(12 days)`. Rollback is setCurveDeployer(previous). The testnet Launchpad still stores 30 days until that owner call.

## Current results (Nov 10 2026, CT)

This section replaces the earlier gas and test notes. The numbers below are for the branch `hook/curve-lp-accrue-followups` after main (commit d03173b7) was merged into it on Nov 10 2026. "Main" in the tables means main at d03173b7, which still uses the old curve. The merge brought in main's pull requests #279 to #285. None of them change contract code or contract tests, and every number below was measured again after the merge. All gas numbers come from local forge tests with the same inputs on both sides. They are execution gas and leave out the fixed 21,000 gas that every transaction pays.

### Trading gas

| What is measured | Main (old curve) | This branch (new curve) | Difference |
|---|---|---|---|
| A buy on the curve, 10 USDG | 226,638 | 156,321 | 70,317 less |
| A sell on the curve | 218,660 | 148,394 | 70,266 less |
| A buy through the router (DiscipleRouter.buyWithUsdg) | 253,383 | 188,686 | 64,697 less |
| A sell through the router (DiscipleRouter.sellToUsdg) | 240,450 | 173,236 | 67,214 less |
| A gasless buy (buyWithPermit2), old curve compared with new curve on this branch | 285,800 | 223,894 | 61,906 less |
| A gasless sell (sellWithPermit2), old curve compared with new curve on this branch | 273,859 | 206,497 | 67,362 less |
| A buy on the v4 pool after graduation | 348,724 | 348,724 | the same |
| The first sell on the v4 pool after graduation | 311,511 | 362,811 | 51,300 more |
| Later sells on the v4 pool after graduation | 313,687 and 313,612 | 313,687 and 313,612 | the same |
| Launching a coin | 6,379,585 | 6,380,643 | 1,058 more |

The first sell on the v4 pool after graduation costs 51,300 more gas. The calls in that sell are the same on both sides. The extra cost comes from storage that is written for the first time: the FeeRouter's USDG balance (about 17,100 gas) and the FeeRouter's fee records for the coin (about 34,200 gas). On main, earlier curve trades had already written that storage. lee accepted this extra cost on Nov 10 2026.

### The graduating buy (audit item G1)

The graduating buy is the buy that moves a coin from the curve to the v4 pool. It costs more on this branch than on main. It was measured again on Nov 10 2026, after the merge, with a temporary test that was deleted afterwards. Both sides ran the same 17 buys of a TRENCH coin, and the 17th buy (400 USDG) graduated the coin.

| Case | Main | This branch | Difference |
|---|---|---|---|
| The first coin that ever graduates, gas used by the call | 2,559,084 | 2,662,645 | 103,561 more |
| The same, after gas refunds | 2,395,784 | 2,484,245 | 88,461 more |
| A coin that graduates after another coin already graduated, gas used by the call | 2,558,279 | 2,610,524 | 52,245 more |
| The same, after gas refunds | 2,394,979 | 2,432,124 | 37,145 more |

The repository's own gas snapshot files agree with these numbers. `contracts/snapshots/floor.json` records a graduating buy of 2,662,645 on this branch and 2,559,084 on main, and `contracts/snapshots/curve-steep.json` records 2,637,901 on this branch and 2,534,362 on main. Both files were updated by an earlier test run and are committed on this branch. The latest test run did not change them.

"After gas refunds" subtracts the refund that Ethereum gives back at the end of a transaction when storage is cleared. That refund is part of what the trader really pays. The second case is closer to normal use, because on a live network other coins will already have graduated.

Where the extra gas goes, for a coin that graduates after another coin already graduated:

- LockedLP stores a record for each coin. On main, the coin's first curve trade creates that record, because every curve trade on main sends the LP share to LockedLP. On this branch, curve trades no longer touch LockedLP, so the record is created during the graduating buy instead. This costs about 48,300 gas. The cost has moved from the first trade to the graduating buy; it has not been added.
- LockedLP's USDG balance is read for the first time in the graduating buy. This costs about 4,800 gas.
- The curve's own code costs about 10,900 more, mostly because it writes the LP fee share into storage before graduating. Most of this comes back as a refund when that storage is cleared after graduation.
- Paying out the fees owed at graduation costs about 14,500 less than main's routing of the same fees.

For the first coin that ever graduates, two shared balances are also written for the first time: CurveFeeVault's USDG balance (about 17,100 gas) and LockedLP's USDG balance (about 21,900 gas). This happens only once per deployment.

No change was made. The only large item, the LockedLP record, belongs to LockedLP, which is a core contract that this branch does not change. Making it cheaper would mean changing LockedLP or making every curve trade write that record again, and both would remove or slow existing behavior. The small savings left inside the curve are about 100 gas each and were not worth a change. lee accepted the extra graduating buy cost on Nov 10 2026.

### Contract sizes

The limit for a contract's deployed code is 24,576 bytes.

| Contract | Main | This branch |
|---|---|---|
| BondingCurve | 24,159 bytes | 24,156 bytes |
| Launchpad | 24,399 bytes | 24,399 bytes (177 bytes below the limit) |
| CurveDeployer | 696 bytes | 826 bytes |
| CurveFeeVault | not on main | 8,349 bytes |
| DiscipleRouter | 17,933 bytes | 22,021 bytes |

### Tests

All 69 contract test files were run one at a time with `FOUNDRY_FUZZ_RUNS=16 forge test -j1`, after the merge with main d03173b7. All 778 tests pass. One test file needed a fix: in `DiscipleRouterPermit2.t.sol`, a helper compared the whole coin balance with the amount from the last buy, so the second buy in a test failed. It now compares the change in balance. This fix already existed on the branch `fix/permit2-first-trade-test` and was copied over.

One test file, `LockedLPForkPoC.t.sol`, only runs when `RH_FORK=1` is set. It was run without that setting, so it passed without doing anything.

### Web tests

The web checks were run on this branch and on main (d03173b7) with the same installed packages.

- The vitest suite passes on both. On this branch, 177 tests pass and 5 are skipped, in 25 files. On main, 151 pass and 4 are skipped, in 21 files. The extra files on this branch are its own new tests.
- The TypeScript check (`tsc --noEmit`) passes on both.
- Lint (`next lint`) has no errors on either side and the same 7 warnings. The 5 new warnings came from main.
- On both sides the same 24 script tests (`npm run test:...`) fail, with the same failure messages, so the branch does not cause them. One of them, `test:boost-anim`, is new on main and fails there too. Several of them need a running local server or network access. Others look for code patterns that have changed since the test was written.

Four test scripts failed on this branch but passed on main, or failed for a different reason there. The cause was in the tests, not in the site code. The game engine on this branch has a constant named `DUST_USD`, and the site's wallet code now imports a module that decides whether gasless mode is on. The tests copy those parts of the code into a sandbox and did not provide either one. The fix gives the tests the same value the engine uses, read from the engine file, and a stand-in that keeps gasless mode off, which is the default. The files changed are `test-live-fixes.mjs`, `test-trade-ui.mjs`, `test-fix-batch.mjs` and `test-trade-speed.mjs`. After the fix, `test-live-fixes.mjs` passes, and the other three fail in exactly the same way as on main.

One more script test, `test:relayer-nonce-shared`, failed once on this branch. It sends random hostile traffic, so its result changes from run to run. Run 10 times on each side, it passed 8 times on this branch and 7 times on main. The branch does not cause it.

The indexer tests pass on both sides: 64 tests in 9 files on this branch and 60 tests in 8 files on main. The extra tests are this branch's own. The indexer's TypeScript check passes on both.

## Web
- SPARK `[0.2,0.5,1,2,5,20]` → `[3,3,3,3,5,20]`; KINDLE `[0.5,2,5,10,25,100]` → `[3,3,5,10,25,100]` (ammoTiers.ts, docs/ammo-tiers.md). Note: engine.js ignores tiers today (`AMMO_TIERS=null`, fixed $10/$25/$50/$100), and `MIN_SHOT=3` is already set.
- Gasless login relay (`disciple_gaslessLogin`): **OFF by default**. It only runs under `GAS_SPONSORSHIP_MODE=gasless` (`requireGaslessMode`; default `self`, Production `hosted`). There is no separate flag: in gasless mode it is reachable. Not edited (another job owns gaslessRelay.ts, relayLockdown.ts and app/api/gasless).

## Docs
- Constitution #9, #11 and #15, plus a 2026-11-09 revision, in /workspace/anypair/protocol-constitution.md and contracts/docs/protocol-constitution.md (including §Anti-snipe and §Fee mechanics).
- 30 → 12 days in redeploy-runbook.md, mode-rules-v2.md, bonding-modes.md, mainnet-plan.md and frontend-api.md.

## LoginGate dependents (NOT removed; what each loses on new curves)
- contracts/src/LoginGate.sol:54 `revoke` / epoch. On-chain revoke no longer stops a direct new-curve trade; only relay admission (KV revoke marker + verifiedUntil) does.
- contracts/src/Launchpad.sol:78,229,290-291: PvE launch still requires `loginGate` set (LoginGateUnset) and snapshots it. That is now unused by new curves but still a launch prerequisite.
- contracts/src/libraries/Constants.sol:190 `PVE_LOGIN_CACHE_TTL` is unused by new curves.
- contracts/src/BondingCurve.sol `verifiedUntilOf` / `NotVerified` are kept for ABI only.
- Instant revoke design (/workspace/instant-revoke-design.md, paused): the transfer block via `onTokenTransfer`, the sell block, and the claim/rewards pause all assumed a curve-level LoginGate read. On new curves there is no hook for them.
- Token.sol, FeeRouter.sol, AscensionHook.sol, RewardsVault.sol and crew tip (`_crewTip`): no LoginGate dependency found.
- web/lib/protocol-viem.ts:991-992 and 1104, plus lib/pve.ts:22-67: PvE buys still prepend a user-paid `LoginGate.attest`, which is unnecessary on new curves (extra gas and a wallet step).
  - 1098 and lib/legacyGate.ts:23 (+ components/pairart/CoinIdentity.tsx:57): legacy detection keys off `curve.loginGate()`. Kept non-legacy because the immutable stays.
  - protocol-viem.ts:264,461, launchAbi.ts:65,71 and components/create/FirstBoostField.tsx:62: NotVerified messaging. Harmless, never fires on new curves.
- web/lib/server/relayLockdown.ts:42-50,140,155-160 and fastRelay.ts:178: relay admission `verifiedUntil`. This is now THE login enforcement (owned by the other job).
  - gaslessRelay.ts:96-130 is the login relay. lib/wallet.ts:199-212 is the client login.
  - lib/aa/session.ts:269-279 is the self-relay LoginGate setup.
  - lib/aa/gasPolicy.ts:78-81,179-244 and server/gradBuy.ts:44,64,122 are the attest-prefix op shapes.
- web/app/api/pve/attest/route.ts:36-82 and lib/pveAttest.ts: the attester signing service.
- indexer/src/config.ts:25,66 indexes LoginGate events. sdk/session-keys/src/modes.ts:23,41,109-143 holds old ABI strings.

## Risks / AUDIT items
1. **CurveFeeVault is a new money-holding contract and a new claim location** for curve-phase creator, treasury and referral fees of new coins. It copies FeeRouter._route minus LP. It needs AUDIT review and lee's OK. Web claims (lib/claims/creatorFees.ts and referral claims) do not read it yet (proposal P1).
2. **AnonLauncher (private launches):** new-coin creator fees accrue in the vault under the AnonLauncher address. AnonLauncher v2 claims only from FeeRouter, so these would be **stuck** until AnonLauncher supports the vault. Blocker before setCurveDeployer.
3. Settle-time reads: unreferred fees owed at settle use the creatorOf, kolCreatorShareBps, referralSink and treasury values at settle time, not trade time. A creator who calls transferCreator before a settle hands the unsettled share to the new creator. An owner change to KOL bps or the sink applies to unsettled fees. **Decided (lee, Nov 9, L1): "Leave it, the new creator gets unsettled fees."** Documented at Launchpad.transferCreator; no code change.
4. DiscipleRouter.claimCreatorFeesToUsdg (FeeRouter.claimCreatorFeesFor) does not cover vault balances.
5. FeeRouter.TradeFeeRouted is no longer emitted for new-curve curve-phase fees. CurveFeeVault.CurveFeeSettled replaces it (trader = 0 for a batch), so the indexer and the recentAccruals feed need it.
6. The post-release accrual rule: decided by lee (Nov 9, 10:17 PM CT, replacing the 9:16 PM L2 cap): a coin not graduated by day 12 sends all its curve LP fees to RewardsVault (repeatable release + late graduation); only a graduation within 12 days sends them to the compound bucket. Implemented on hook/curve-lp-accrue-followups.
7. Rounding: per-bucket dust differs from per-trade splitting by ≤ a few wei per trade. The total is exact (referral residual).
8. With no on-chain login, a direct contract caller can trade PvE new coins without login (by design, per lee).

## Proposals (not built, per lee's 7:39 PM rule)
- P1: web claims read and claim from CurveFeeVault (show owed + accrued; batch settle before claim).
- P2: AnonLauncher support for vault claims, before rollout.
- P3: a creator-transfer UI that calls `settleFees()` before `transferCreator`.
- P4: a keeper that settles coins before `claimTreasury`.
- P5: skip `ensurePveLogin` attest for new curves (saves the user an attest tx).
- P6: BLAZE FEATHER preset is $2 (<$3); not in the brief.
- P7: referred traders keep ~217k; caching launchKol in the curve would let KOL coins accrue for referred traders too.
- P8: a separate default-off flag for disciple_gaslessLogin (other job's files).

## Follow-ups (branch hook/curve-lp-accrue-followups, lee's decisions of Nov 9 2026, 9:16 PM CT)

- **H1, private coins (AnonLauncher):** CurveFeeVault takes an immutable `anonLauncher` (constructor). `claimCreatorFeesAsStealth(token, to)` pays `creatorAccrued[token][anonLauncher]` (settled first) when `Launchpad.creatorOf(token) == anonLauncher` and `msg.sender == AnonLauncher.stealthOwnerOf(token)`. `claimManyAsStealthBySig(ClaimReq)` is the gasless form the web already uses for AnonLauncher (stealth keys never hold gas; the user's smart account submits): same `Claim` struct, relayer fee cap (500 bps), deadline and per-owner nonce as AnonLauncher.claimManyBySig, with the vault's own EIP-712 domain ("DISCIPLE CurveFeeVault", "1") and `sigNonces`. Fee claim only; no login or trade path.
- **M1, readers:** `DiscipleRouter.claimCreatorFeesToUsdg` now pays vault balances too (`CurveFeeVault.claimCreatorFeesToRouter`, gated on `FeeRouter.isClaimRouter`, same as `FeeRouter.claimCreatorFeesFor`). Web claims (lib/claims/vault.ts, creatorFees.ts, capabilities.ts, rewardsData.ts) read `curve.feeVault()` per coin and `creatorClaimable` (accrued + still owed), and claim on the side that holds the balance. The indexer stores `CurveFeeSettled` (stack vault only) and `LpFeeEscrowReleased` (coin's curve only), and splits `SnipeEscrowToLP` into sniper tax and LP fee share.
- **L1:** docs only (above, Launchpad.transferCreator NatSpec, constitution #13).
- **LP rule (lee, Nov 9 2026, 10:17 PM CT; replaces the 9:16 PM L2 cap, which is removed):** not graduated by launch + `snipeEscrowTimeout` (12 days) ⇒ all curve LP fees go to RewardsVault, whether the coin never graduates or graduates later; only a graduation within 12 days sends them to the compound bucket.
  - Trade path: no timestamp check and no extra storage write in buy/sell (byte-for-byte the flow/curve-lp-accrue trade path). The decision happens only at `releaseSnipeEscrow` or in `_graduate`.
  - `releaseSnipeEscrow` (unchanged from flow/curve-lp-accrue): settles, sends the sniper tax + all of `lpFeeEscrow`, zeroes both. Repeatable: each call sends what accrued since the last one; nothing new ⇒ `ZeroAmount`.
  - `_graduate` after the timeout: sends the remaining `sniperTaxEscrow` and `lpFeeEscrow` to RewardsVault (`SnipeEscrowReleased` / `LpFeeEscrowReleased`, same as a release) before the compound bucket is read, so no `SnipeEscrowToLP` is emitted. If `FeeRouter.rewardsVault()` is unset, both stay and go to the bucket (old destination) rather than reverting the graduating buy (kept on purpose, COO).
  - No double pay: every path zeroes what it sends; graduation blocks further releases.
  - **Sniper tax (lee, Nov 10 2026, 7:44 AM CT: "the sniper tax should go to community rewards"):** follows the same split. A late graduation sends any unreleased sniper tax to RewardsVault too (was: compound bucket). Graduation within 12 days and `releaseSnipeEscrow` unchanged.
- **RewardsVault (lee, Nov 10 2026, 7:44 AM CT):** the existing Owned2Step `RewardsVault` is reused. `script/rewards/DeployRewardsVault.s.sol` (not run) makes one for an existing stack with a required `REWARDS_VAULT_OWNER` (TEMP wallet on testnet, Safe on mainnet); steps in `contracts/docs/rewards-vault-runbook.md`.
  - CurveFeeVault `settle` → `settleCurveFee` (selector 0x038b09d3 sorts first in the dispatcher, so the H1/M1 claim functions add no gas to referred trades or settles).
- Gas and test results: see "Current results" above.
