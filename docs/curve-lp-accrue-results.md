# flow/curve-lp-accrue: results (Nov 9 2026, CT)

Base: `flow/gasless-permit2` @ a8154368. Branch `flow/curve-lp-accrue`. Testnet only. Built and tested locally. Nothing on-chain, no PR, no merge.
Lee's go-aheads (via COO): 7:28 PM "ok yes then bundle the lp share"; 7:32 PM 12-day rule for sniper fees and LP fees; 7:37 PM drop the on-chain verified record; 7:39 PM standing rule: add no mechanism beyond the brief.
Prior work in git history: no curve fee accrual to reuse (the only "owed" commits are the paymaster and keeper jars).

## Design (NEW curves only; existing curves, FeeRouter, LockedLP, Migration, AscensionHook/DiscipleHook unchanged)
Copied pattern: **Uniswap v3 accrue-then-collect**. In v3, Position.tokensOwed0/1 grow on every swap and NonfungiblePositionManager.collect() pays out later. It is named in the NatSpec of BondingCurve and CurveFeeVault.
- **Per trade (unreferred trader):** the curve only adds `protoFee` and `creatorTax` to `protoFeesOwed` and `creatorTaxOwed`. These are `uint112`, packed in the same slot as `graduated`, so it is one warm SSTORE. There is no transfer and no FeeRouter or LockedLP call. The quote stays in the curve, outside `quoteReserve`. `_prepaid` (audit L3) counts it as owed.
- **Referred trader** (ReferralRegistry.referrerOf != 0, one view call per trade): the fee settles inside the same trade, so the trader's referrer still gets exactly their 1%. A referrer only exists at trade time, so this cannot be deferred.
- **settleFees()** (the "collect"; permissionless, a no-op when nothing is owed) does three things:
  - keeps the LP 33% (same FeeMath rounding) in `lpFeeEscrow`;
  - transfers creator, treasury and the 1% (plus creator tax) to **CurveFeeVault**;
  - calls `vault.settle`, which copies FeeRouter._route's split exactly, minus the LP push. That covers creatorOf, the launch-KOL 1% plus the kolCreatorShareBps cut, the referral sink, and treasury, all read live from the deployed FeeRouter and Launchpad.
- **Graduation:** `_graduate` settles first. `snipeEscrow()` now returns `sniperTaxEscrow + lpFeeEscrow`, and Migration already reads that selector as non-floor quote, so the LP share lands in LockedLP's **locked compound bucket**. Tested: the bucket is byte-identical to the old curve's on the same trade sequence (31415180580718714992 = 31415180580718714992).
- **12-day rule:**
  - `Constants.SNIPE_ESCROW_TIMEOUT` is now 12 days (was 30). It stays owner-tunable at 1–365 days and is snapshotted per curve.
  - `releaseSnipeEscrow()` settles first, then sends the sniper tax **and** `lpFeeEscrow` to `FeeRouter.rewardsVault()`. It emits `SnipeEscrowReleased` (sniper part) and `LpFeeEscrowReleased` (LP part).
  - Only the escrows move, never `quoteReserve`, `rewardsHeld` or the token inventory.
  - **Post-release rule (lee, Nov 9 2026, L2; replaces my earlier pick):** "Only the LP fees accrued by day 12 go to the rewards vault; later ones go to the compound bucket." The release sends the LP share accrued by the timeout, once; later LP shares stay in `lpFeeEscrow` for the compound bucket at graduation. See "Follow-ups" below.
  - A second release with nothing new reverts `ZeroAmount` (no state change), same as today.
- **Claims mid-curve:** these are CurveFeeVault functions, and each settles first, then pays:
  - `claimCreatorFees(token)` settles that coin first. The quote is read from the curve, never supplied by the caller.
  - `claimReferrerFees(quote, tokens[])` and `claimTreasury(quote, tokens[])` settle the listed coins first. `claimTreasury` is permissionless and pays FeeRouter.treasury().
  - Only the coin's registered curve can call `vault.settle`.
- **Why a new contract:** the deployed FeeRouter is immutable in Launchpad and always pushes 33% to LockedLP inside `_route`. It cannot credit creator, treasury or referral without also moving the LP share, and that would break "LP fees go to the vault if the coin doesn't bond".
- **Login:** new curves drop the on-chain PvE LoginGate check (the `verifiedUntil` read and the 10-min cache). This is app-level gating, as pump.fun and FOMO do it: login is enforced off-chain at the app and relay, and the contracts are permissionless. `loginGate` stays as an immutable so web/lib/legacyGate.ts doesn't mark new coins as legacy. `verifiedUntilOf` always returns 0. The constructor no longer requires a gate for PvE.
- Fee split (33/33/33/1, Constants.sol:119-124) unchanged. Code size: BondingCurve runtime 23,631 B (was 24,159; limit 24,576). CurveFeeVault 3,774 B. CurveDeployer now takes `feeVault` in its constructor; Launchpad's deploy call is unchanged.
- Deploy script (NOT run): `contracts/script/lpaccrue/DeployLpAccrue.s.sol` deploys the vault and the deployer. With WIRE=true (owner only) it also runs `Launchpad.setCurveDeployer(new)` and, if needed, `setSnipeEscrowTimeout(12 days)`. Rollback is setCurveDeployer(previous). The testnet Launchpad still stores 30 days until that owner call.

## Gas (forge, cold access via vm.cool, steady state, execution gas; tx total ≈ +21k intrinsic + calldata)
¢ at 0.02 gwei × $2,130 = gas × 4.26e-6 ¢.
| path | old curve | new curve | Δ | tx total new (est.) | ¢ new |
|---|---|---|---|---|---|
| direct curve buy (TRENCH/PvP) | 229,735 | 159,418 | −70,317 | ~182k | 0.78¢ |
| direct curve sell | 221,095 | 150,829 | −70,266 | ~173k | 0.74¢ |
| **gasless buyWithPermit2** (USDG coin, $3) | 285,800 | 223,894 | −61,906 | ~249k (old ~311k) | **1.06¢** (old 1.33¢) |
| **gasless sellWithPermit2** | 273,859 | 206,497 | −67,362 | ~232k (old ~299k) | **0.99¢** (old 1.28¢) |
| PvE buy, login cache hit | 338,843 | 268,373 | −70,470 | | |
| PvE buy, login cache expired (old re-reads LoginGate) | 348,084 | 271,763 | −76,321 | | |
| PvE sell | 237,060 | 166,797 | −70,263 | | |
| referred trader buy / sell (new curve settles in-trade) | 229.7k / 221.1k | 216,973 / 208,385 | −12.7k | | |
- LoginGate drop: worth about 9.2k on a cache-miss buy (old miss 348.1k vs hit 338.8k) and 0 on a cache hit. The ~13k estimate included the first-buy cache SSTORE.
- Testnet STRATEGY coin (2 hops), on-chain 379.1k / 351.2k: minus the deltas, about 317k / 284k (estimate, not re-simulated).
- Still over 1¢: a gasless buy at ~1.06¢. PvE trades add ~109k of PvE bookkeeping (cost basis, rewards). Referred traders keep most of the old cost.

## Tests (targeted only, FOUNDRY_FUZZ_RUNS=16; no full regression or fuzz suites)
`forge test --match-path "test/lpaccrue/*.t.sol"`: **12/12 pass**.
LpAccrue.t.sol (11):
- per-trade accrual;
- referred trader settles in the trade, exact;
- settle-at-ascension gives a compound bucket identical to the old curve;
- claim mid-curve: creator (−KOL cut +tax), treasury and KOL exact, the vault ends at 0, and a re-accrue then claim works;
- only a registered curve can settle;
- fuzz totals match the old split (total identical, per-bucket ≤ a few wei dust);
- old curve unchanged (per-trade FeeRouter/LockedLP);
- old PvE curve reverts NotVerified while the new one trades without login;
- 12-day release: reverts at 12d−1s; at 12d sends sniper tax + LP to RewardsVault; reserve, tokensSold and inventory unchanged; creator and treasury unaffected; second release reverts ZeroAmount; post-release LP stays for the compound bucket (L2, follow-ups branch);
- graduation before 12d goes to the bucket, not the vault, and release after graduation reverts;
- gas.

LpAccrueGasless.t.sol (1): router gas, old vs new.
The old curve is a verbatim copy of a8154368 BondingCurve (`test/lpaccrue/legacy/`).
**Existing tests NOT run.** These will need updates for new-curve semantics in lee's local run (snipeEscrow split, vault claims, no NotVerified on new curves, 12-day default): FeeClaims, Lifecycle, ModeRulesV2, BondingModes, SnipeSplit, ReferralOwnership, ReferralSink, KolCreatorShare, AuditRegression, DiscipleAudit, GraduationFloor, UsdgRouter, Curve, Migration, Launchpad, AnonLauncher, security/*. All touched tests and scripts compile.
Web: vitest **177 passed / 5 skipped** (25 files, +1 new `tests/ammo-tiers-min.test.ts`, which needed adding `tests/ammo-*.test.ts` to the vitest include list). tsc clean.

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
- Token.sol, FeeRouter.sol, DiscipleHook.sol, RewardsVault.sol and crew tip (`_crewTip`): no LoginGate dependency found.
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
6. The post-release accrual rule: decided by lee (L2, Nov 9): only LP fees accrued by the timeout are released, once; later ones go to the compound bucket. Implemented on hook/curve-lp-accrue-followups.
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
- **L2:** the first trade or release at or after the timeout records the release cap once (`lpFeeEscrow` + the LP part of still-owed fees). `releaseSnipeEscrow` sends `min(cap, lpFeeEscrow)` with the sniper tax, then zeroes the cap, so a second release of LP fees is impossible (reverts `ZeroAmount` when no sniper tax is left either). Later LP shares stay in `lpFeeEscrow` and go to the compound bucket at graduation. A coin that never graduates keeps those later LP shares in the curve.
- Gas and test results: in the PR body for this branch.
