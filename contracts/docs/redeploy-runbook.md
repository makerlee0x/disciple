# DISCIPLE testnet redeploy runbook (RH testnet 46630)

One redeploy that ships: steep curve #1 (84.24% sold, $3,333 → $33,333), the 16-band USDG-only graduation floor,
FeeRouter `referralSink`, the 7s sniper tax (99% at launch, 25% at 1s, 3% at 2s, 0 from 7s; per-second table) held in escrow and sent to the compound bucket at graduation,
a 6-decimal mock USDG (like mainnet), AnonLauncher v2, and (via #106) the USDG paymaster + session policy 1.4.0.

Nothing here runs by itself. **Broadcast only on lee's GO, after AUDIT signs off.**

Scripts: `contracts/script/Deploy.s.sol`, `contracts/script/redeploy/{env.testnet,redeploy.sh,postprocess.mjs,smoke.mjs,fixtures.mjs}`.
Secrets: `/workspace/anypair/.secrets/testnet-deployer.env` (`PRIVATE_KEY`), sourced by `redeploy.sh`, never printed.

## 1. Merge order

Stack base is main@38e8802e. main has moved 8 commits since (b904b011 at time of writing).

| # | PR | Branch → base | Depends on | Notes |
|---|----|---------------|------------|-------|
| 1 | #121 mode rules v2 | feat/mode-rules-v2 → main | – | contracts + web; biggest overlap with new main |
| 2 | #127 steep curve + floor | feat/steep-curve-floor → #121 | #121 | AUDIT: SHIP; retarget to main after #121 merges |
| 3 | this PR (redeploy prep) | feat/redeploy-prep → #127 | #127 | scripts + runbook + the two #115 cherry-picks below; AUDIT fixes in section 11 |
| 3a | #115 6-dec USDG (b6a91177, 80b06f22 only) | cherry-picked into this PR as 2f55717a, 06d46f16 | – | **required before the redeploy** (AUDIT Medium: `5 ether` launch-fee cap = $5T at 6 dec). Src only; tests rewritten for this stack's 18-dec harness |
| 3b | #115 rest (96a2ec13 harness, fdc8b837 deploy, 421e7a9e, test commits) | test/usdg-6dec → main | after this stack | optional, not needed to deploy. On conflict take this stack's `Deploy.s.sol` / `script/redeploy/*` (fdc8b837 overlaps); AnonLauncher/DiscipleHook src is identical to the cherry-picks |
| 4 | #129 SITE steep curve web | site/steep-curve-web → #127 | #127 | one known FAIL until engine.js is regenerated (GAME) |
| 5 | #128 GAME sim retune | game/sim-retune-steep-curve → #127 | #127, land with/after #129 | regenerates `web/public/flight/engine.js` |
| 6 | #106 USDG paymaster | feat/usdg-paymaster → main | – (deploy needs the new USDG + ReferralRegistry) | rebase on main after #128 |

Conflict hotspots (files changed on main since 38e8802e that the stack also changes):

| File | Touched by |
|------|-----------|
| `web/public/flight/engine.js` | #121 #127 #129 #128: generated; do not hand-merge, regenerate after the last merge (GAME) |
| `web/lib/curveMath.ts` | #121 #127 #129 (main's 6-dec USDG change 1820f34c is in there too) |
| `web/lib/protocol-viem.ts` | #127, and #106. **On #106 take main's version around line 571.** |
| `web/lib/{events,trades,pnl,achievements}.ts`, `web/lib/flight/fills.ts` | #121 |
| `web/components/PnlHud.tsx` | #128 |
| `indexer/test/indexer.test.ts`, `web/scripts/test-share-pnl.mjs` | #121 |
| `web/scripts/test-v4-fixes.mts` | #121 #129 |
| `contracts/test/integration/UsdgRouter.t.sol`, `contracts/test/session/DiscipleSessionPolicy.t.sol` | #106 vs #121 |

#129 and #128 touch no common files. Deploy from main HEAD after all merges (and the AUDIT fixes).
**AUDIT round 2 (#127):** the redeploy must be cut from a tree that contains this PR (#131 head 78f2dac1 or later), not from #127
alone: the AnonLauncher cap fix (2f55717a) and the 6-dec `Trade.fee` fix (06d46f16) exist only here. Check it in pre-flight (section 2, item 9).

## 2. Pre-flight (on merged main)

1. `git pull`; `export PATH=$HOME/.foundry/bin:$PATH`; `cd contracts`.
2. Build in groups (a full cold `forge build` OOMs on the box at ~8 GB): `forge build script/Deploy.s.sol` (≈141 files, fine alone), then the tests you run.
3. Tests: `forge test --match-path test/audit/DeployConfig.t.sol` plus the steep-curve / floor / sniper suites AUDIT names.
4. **Fork dry run (section 9)** end to end: deploy + `smoke.mjs` all PASS.
5. Simulation against the live RPC, no broadcast: `./script/redeploy/redeploy.sh` (writes `deployments/rh-testnet-46630.dry-run.json`).
6. Deployer `0xd9fdF29fBAB9Be7cA1F6A3A07e0c36D65170AEf5` balance ≥ 0.05 ETH (0.27 ETH on 2026-10-24; core deploy ≈ 40.2M gas,
   at 0.01 gwei ≈ 0.0004 ETH + L1 data; paymaster deposit/stake extra).
7. Confirm env with lee: `TREASURY`, `REWARDS_VAULT_OWNER`, `PVE_ATTESTER` (must match the key SITE signs logins with), `REFERRAL_SINK` (default 0).
8. `cfg` lines in the deploy log must read: USDG decimals 6, CURVE_SOLD_BPS 8424, START 3333, GRADUATION 33333,
   ANTI_SNIPE 9900 / 7 s (table 9900·2500·300·100·30·10·3, 0 from 7 s), MAX_FLOOR_BANDS 16, referralSink 0x0.
9. **Deploy tree has #131's AUDIT fixes** (AUDIT round 2 on #127): `git merge-base --is-ancestor 2f55717a HEAD && git merge-base --is-ancestor 06d46f16 HEAD`
   (after a squash merge, check the source instead: `AnonLauncher.MAX_LAUNCH_FEE` is an `immutable` set from `feeToken.decimals()`).
   Smoke's `MAX_LAUNCH_FEE == 5 * 10**usdg.decimals()` check is the backstop after the deploy.
10. **Multicall3 on 46630** (AUDIT round 2 on #106/#131; #106's relay batches its graduating-buy reads through the canonical
   Multicall3 with `allowFailure=false`, so without it every graduating buy silently falls back to normal gas caps). Read-only:
   ```bash
   cast code 0xcA11bde05977b3631167028862bE2a173976CA11 --rpc-url https://rpc.testnet.chain.robinhood.com | wc -c   # must be > 3 (not "0x")
   ```
   `smoke.mjs` repeats this as a PASS/FAIL check (eth_getCode). Fork dry run 2026-10-24: 3,808 bytes of code served from the forked live chain.
11. **`PVE_ATTESTER` is set** (AUDIT round 3 on #131): `Deploy.s.sol:230` reads `vm.envOr("PVE_ATTESTER", address(0))`, so an unset
   var silently deploys `LoginGate` with attester 0x0 and no PVE login can ever be attested. `env.testnet` leaves it unset on purpose
   (lee confirms the value, item 7), so export it before `redeploy.sh`: `test -n "$PVE_ATTESTER" && [ "$PVE_ATTESTER" != 0x0000000000000000000000000000000000000000 ]`.
   Public address only (the SITE login-attest key's address), never the key. Smoke checks `LoginGate.attester() != 0` read-only before any tx.
12. **LEE DECISION — paymaster stake (AUDIT I-2 on #141).** Validation now writes the paymaster's sender-keyed storage
   (`reservedOf` / `reservedBy` / `rolledOf`) and returns a context, so under ERC-7562 (STO-031) a **public** 4337 mempool / bundler
   only accepts it if the paymaster is **staked**. We self-relay (`selfBundler` / `fastRelay` call `handleOps` directly; no public
   bundler), and the EntryPoint itself never checks stake, so **stake is not needed for our path**. Options: (a) leave
   `PAYMASTER_STAKE_WEI` unset — `DeployPaymaster.s.sol` then skips `addStake` (default; recommended while we self-relay); (b) set
   it (owner broadcast, 1-day unstake delay) only if we ever route ops through a public bundler. lee: ☐ (a) no stake ☐ (b) stake ___ ETH.

## 3. Core deploy

```bash
cd contracts
BROADCAST=1 ./script/redeploy/redeploy.sh   # sources env.testnet + secrets; forge script --broadcast --slow; postprocess broadcast
```

`Deploy.s.sol` order (one script, 51 txs on the fork):
1. Mock USDG (DevToken, 6 dec, public `mint`), test STRATEGY (18 dec), STRATEGY/USDG pricer pool at $0.00245 (~$1M per side; fee 3000, spacing 60, no hooks).
2. ReferralRegistry → LockedLP → FeeRouter (`referralSink` = 0) → DiscipleHook (CREATE2, mined flags) → Migration (+ LockedLP/Hook wiring).
3. DiscipleRouter, TrampWallManager, AntiSnipe (legacy, unused by v2 curves), Launchpad (pre-computed address), UsdgDepositNotifier.
4. QuotePricer (+ USDG routing), LoginGate (`PVE_ATTESTER`), QuoteProbe, CurveDeployer, `setDefaultQuote(STRATEGY)`.
5. Add-ons: RewardsVault (+ FeeRouter wiring, owner `REWARDS_VAULT_OWNER`), `hook.setPricer`, AnonLauncher v2 (fee 0.25 USDG = 250000 raw), MarketLens.
6. Optional `REFERRAL_SINK` → `FeeRouter.setReferralSink`.

`postprocess.mjs broadcast` writes `deployments/rh-testnet-46630.json` (new `id`, `startBlock` = first receipt block, new `tokens`,
old stack under `previous`, old tokens under `previousTokens`) and `deployments/web-bundle/` (addresses + ABIs). Commit both.

## 4. Paymaster + session policy (#106, after the core deploy)

From merged main (`contracts/`), with the new addresses:

```bash
set -a; . /workspace/anypair/.secrets/testnet-deployer.env; set +a
USDG=<new USDG> PAYMASTER_OWNER=<lee/ops> PAYMASTER_SIGNER=<address of PAYMASTER_SIGNER_KEY> PAYMASTER_TREASURY=<treasury> \
PAYMASTER_MIN_RATE=1000000000 PAYMASTER_MAX_RATE=10000000000 \   # USDG raw (6 dec) per ETH: $1,000–$10,000
PAYMASTER_MAX_COST_USDG=2 \   # WHOLE USDG -> maxCostCap = 2 * 10**decimals (2000000 at 6 dec), LEE DECISION 2026-10-24 11:28 CT
PAYMASTER_DEPOSIT_WEI=<≥ 348000000000000 per 11M-gas launch> \
forge script script/DeployPaymaster.s.sol --rpc-url https://rpc.testnet.chain.robinhood.com --private-key "$PRIVATE_KEY" --broadcast --slow
REFERRAL_REGISTRY=<new ReferralRegistry> PAYMASTER=<DisciplePaymaster> \
forge script script/DeploySessionPolicy.s.sol --rpc-url https://rpc.testnet.chain.robinhood.com --private-key "$PRIVATE_KEY" --broadcast --slow
SESSION_POLICY=<policy> PAYMASTER=<paymaster> node script/redeploy/postprocess.mjs broadcast   # records addons; idempotent
```

The session policy must be redeployed in any case: its constructor takes the ReferralRegistry, which is new. Users reinstall sessions (policy 1.4.1, from feat/policy-pack).
No `PAYMASTER_STAKE_WEI` by default (pre-flight item 12, LEE DECISION: stake only matters for a public 7562 bundler; we self-relay).
If lee picks (b), add `PAYMASTER_STAKE_WEI=<stake>` to the first command (owner broadcast only; 1-day unstake delay).
`PAYMASTER_MAX_COST_USDG` is in WHOLE USDG (scaled by `decimals()`), defaults to 10, and the script fails fast outside [0.1, 100] USDG.
The old raw-unit `PAYMASTER_MAX_COST` is rejected (feat/policy-pack, AUDIT 2026-10-24). The contract also refuses `maxCostCap` above
`maxCostCapLimit` (100 USDG) in the constructor and `setBounds`. `PAYMASTER_POST_OP_GAS` 30000.

**Testnet paymaster cap (LEE DECISION 2026-10-24 11:28 CT: "$2 on testnet").** Deploy with `PAYMASTER_MAX_COST_USDG=2`
(whole USDG; the script scales it to 2 * 10**decimals = 2000000 at 6 decimals), as in the command above. This env is set only on deploy day, with lee's OK. Verify right after deploy:

```bash
cast call <DisciplePaymaster> 'maxCostCap()(uint256)' --rpc-url https://rpc.testnet.chain.robinhood.com   # must print 2 * 10**decimals = 2000000 (2e6) with the 6-dec mock USDG
```

If it prints 10000000 (the 10 USDG script default), the env was not set: stop and tell lee before wiring the paymaster into the site.
Paymaster keeper (server): `PAYMASTER_KEEPER_KEY`, `PAYMASTER_MIN_DEPOSIT_WEI`, `PAYMASTER_TARGET_DEPOSIT_WEI`; run `pnpm paymaster:keeper --send --loop`.
Fork e2e before going live: `pnpm test:paymaster-e2e`.

## 5. Wiring and ownership

All done inside `Deploy.s.sol`; verify with `cast call`:
- `FeeRouter.rewardsVault()` = RewardsVault; `RewardsVault.feeRouter()` = FeeRouter. RewardsVault is now **Owned2Step**: the deploy only
  nominates `REWARDS_VAULT_OWNER` (`pendingOwner`); that wallet must then accept (step 5a). Until it does, the deployer stays owner.

### 5a. RewardsVault ownership acceptance (AUDIT round 2 on #121/#127/#131)

Only when `REWARDS_VAULT_OWNER` ≠ deployer (if unset, Deploy.s.sol nominates nobody and `owner()` stays the deployer: skip to the verify read).
Sent by the `REWARDS_VAULT_OWNER` wallet itself (lee/ops signs; never with the deployer key), on lee's GO like every live tx:

```bash
RV=<RewardsVault from deployments/rh-testnet-46630.json>; RPC=https://rpc.testnet.chain.robinhood.com
cast call $RV "pendingOwner()(address)" --rpc-url $RPC   # before: must equal REWARDS_VAULT_OWNER
# REWARDS_VAULT_OWNER wallet:
cast send $RV "acceptOwnership()" --rpc-url $RPC         # signed by REWARDS_VAULT_OWNER (hardware wallet / its own signer)
# verify (read-only):
cast call $RV "owner()(address)" --rpc-url $RPC          # must equal REWARDS_VAULT_OWNER
cast call $RV "pendingOwner()(address)" --rpc-url $RPC   # must be 0x0000000000000000000000000000000000000000
```

These two read-only `cast call`s ARE the post-acceptance verification (AUDIT round 3 on #131): **do not re-run the full smoke** for it —
a full smoke launches a coin and buys (live txs). If a smoke-style PASS/FAIL record is wanted, use the read-only mode, which sends nothing
and needs no key: `EXPECT_REWARDS_VAULT_OWNER=<REWARDS_VAULT_OWNER> READ_ONLY=1 node script/redeploy/smoke.mjs`.
Any smoke re-run that sends txs (no `READ_ONLY=1`) on the live chain needs **lee's GO**, like every live tx.

Record the acceptance tx hash in the deployments json `note`. Fork rehearsal 2026-10-24 (anvil only, public anvil keys #0 → #1):
`transferOwnership` → `pendingOwner` = #1 → `acceptOwnership` from #1 → `owner()` = #1, `pendingOwner()` = 0; smoke with
`EXPECT_REWARDS_VAULT_OWNER` = #1 PASS 25/25, and with a wrong expected owner it FAILs (exit 1) as intended.

### 5b. Other wiring
- `FeeRouter.isClaimRouter(DiscipleRouter)` = true (set in Deploy.s.sol). `claimCreatorFeesFor` no longer trusts every
  `Launchpad.isTrustedRouter`; add/revoke with `setClaimRouter(address,bool)` (owner).
- `FeeRouter.referralSink()` = 0x0 (today's routing). **lee's rule:** when set, the sink takes the WHOLE referral 1%, including the
  launch-KOL 1%. Owner call, any time: `cast send <FeeRouter> "setReferralSink(address)" <sink>` (0x0 restores today's routing).
  A sink equal to the treasury follows `setTreasury` (it moves to the new treasury), so the old treasury never accrues it as a referrer.
- Hook: trusted router = DiscipleRouter only (UniversalRouter is not trusted, SEC-05); `hook.pricer` = QuotePricer.
- Launchpad: `defaultQuote` = STRATEGY; LoginGate set; CurveDeployer set.
- Owners: everything except RewardsVault stays with the deployer. Hand over with `transferOwnership` if lee wants a multisig on testnet.
- Sniper escrow: no wiring. Curves hold it; at graduation Migration sends it to LockedLP's compound bucket; if a coin doesn't graduate within
  30 days, anyone can call `releaseSnipeEscrow()` to send it to the RewardsVault.

## 6. Env and config handoff

**lee sets these in Vercel (testnet; Preview and Production as used today):**

| Var | Value |
|-----|-------|
| `NEXT_PUBLIC_RHT_LAUNCHPAD` | Launchpad |
| `NEXT_PUBLIC_RHT_HOOK` | DiscipleHook |
| `NEXT_PUBLIC_RHT_ROUTER` | DiscipleRouter |
| `NEXT_PUBLIC_RHT_FEE_ROUTER` | FeeRouter |
| `NEXT_PUBLIC_RHT_REFERRAL_REGISTRY` | ReferralRegistry |
| `NEXT_PUBLIC_RHT_LOCKED_LP` | LockedLP |
| `NEXT_PUBLIC_RHT_QUOTE_PRICER` | QuotePricer |
| `NEXT_PUBLIC_RHT_QUOTE_PROBE` | QuoteProbe |
| `NEXT_PUBLIC_RHT_MIGRATION` | Migration |
| `NEXT_PUBLIC_RHT_ANTI_SNIPE` | AntiSnipe |
| `NEXT_PUBLIC_RHT_TRAMP_WALL_MANAGER` | TrampWallManager |
| `NEXT_PUBLIC_RHT_MARKET_LENS` | MarketLens |
| `NEXT_PUBLIC_RHT_LOGIN_GATE` | LoginGate |
| `NEXT_PUBLIC_RHT_USDG_DEPOSIT_NOTIFIER` | UsdgDepositNotifier |
| `NEXT_PUBLIC_RHT_DEFAULT_QUOTE` | new test STRATEGY |
| `NEXT_PUBLIC_RHT_USDG` | new mock USDG |
| `NEXT_PUBLIC_RHT_USDG_DECIMALS` | `6` |
| `NEXT_PUBLIC_RHT_FROM_BLOCK` | `startBlock` from the new deployments json |
| `NEXT_PUBLIC_SESSION_POLICY` | new DiscipleSessionPolicy |
| `NEXT_PUBLIC_SESSION_POLICY_VERSION` | `1.4.0` |
| `NEXT_PUBLIC_RHT_PAYMASTER` | DisciplePaymaster |
| `NEXT_PUBLIC_PAYMASTER_URL` | paymaster quote endpoint (see `docs/usdg-paymaster.md`) |
| `PAYMASTER_ADDRESS` (server) | DisciplePaymaster |
| `PAYMASTER_SIGNER_KEY` (server, secret) | key whose address is `PAYMASTER_SIGNER` |
| `PAYMASTER_USD_PER_ETH` or `PAYMASTER_RATE`, `PAYMASTER_QUOTE_TTL_SEC`, `PAYMASTER_MAX_SLACK_BPS` (server) | per #106 docs |
| `PAYMASTER_KEEPER_KEY`, `PAYMASTER_MIN_DEPOSIT_WEI`, `PAYMASTER_TARGET_DEPOSIT_WEI` (keeper) | per #106 docs |
| `NEXT_PUBLIC_INDEXER_URL` | unchanged unless the indexer moves |

**SITE updates (code/config, PR):** `web/lib/chains.ts` testnet defaults (same addresses, so a missing env can't point at the old stack),
`web/lib/anon.ts` `ANON_ADDONS[46630]` (`anonLauncher` = new AnonLauncher, `anonLauncherLegacy` = old `0x06f3…a527` if old anon coins
should still resolve, `marketLens`, `announcer`, `v2DeployBlock` = new startBlock), ABIs (`gen-abi.mjs` / the web bundle),
`scripts/check-usdg-decimals.mts` must pass against the new USDG, and the USDG faucet/mint UX now mints 6-dec units.
AUDIT round 2 copy/config items for SITE:
- **Easy First BOOST lock has no time-based unlock** (AUDIT #121 r2 Info): on an Easy coin the creator's First BOOST stays locked
  until graduation, forever if it never graduates (also past the 30-day sniper-escrow timeout). The launch flow / coin page / docs must say so.
- **New MarketLens only for v5 curves** (AUDIT #127 r2 Info): its `secondsLeft` / `sniperTax` assume the 7 s window for every curve;
  legacy (v4) curves used 77 s. Don't point the new MarketLens at old coins (keep `anonLauncherLegacy` resolution on the old lens/reads).
**GAME updates:** regenerate `web/public/flight/engine.js` after #128/#129 land; bot sizing assumes the steep curve; any sim fixtures
that hold testnet addresses come from the web bundle.

## 7. Indexer re-point

The indexer reads `contracts/deployments/rh-testnet-46630.json` (`DEPLOYMENT_JSON`) and walks `previous`, so the new stack (id v5) is
indexed from its `startBlock` and the old stacks keep indexing. After the deployments json is on the indexer host:
restart it; if the json lacks `startBlock`, set `START_BLOCK=<first deploy block>`. `STACKS=v5` restricts to the new stack.
Check the indexer catches up to head and that the smoke coin appears.
RewardsVault inflows from un-graduated coins (`releaseSnipeEscrow()` after 30 days) emit no vault-side event: attribute them from the
curve's `SnipeEscrowReleased` (AUDIT #127 r2 ruling; a vault accrual event is a later nice-to-have).

## 8. Smoke (live testnet, after deploy)

```bash
cd contracts; set -a; . /workspace/anypair/.secrets/testnet-deployer.env; set +a
GRADUATE=1 node script/redeploy/smoke.mjs     # waits out the 7s window in real time; ~9,000 USDG minted from the mock
```

Checks (each prints PASS/FAIL, exit 1 on any FAIL, writes `deployments/rh-testnet-46630.smoke.json`):
USDG decimals 6 · `referralSink` = 0 (or `EXPECT_REFERRAL_SINK`) · RewardsVault wired · `AnonLauncher.MAX_LAUNCH_FEE() == 5 * 10**usdg.decimals()`
and `launchFee` ≤ it · `FeeRouter.isClaimRouter(DiscipleRouter)` · SEC-01 (`addLockedLiquidity` from an EOA reverts) ·
First BOOST sniper-exempt (`snipeEscrow` 0 after launch) · sniper buy inside 7s is taxed into `snipeEscrow` at exactly the table
value for its second (fork: pinned to launch+1s = 25%), no `SnipeFeeRouted`, RewardsVault delta 0 · tax 0 from 7s ·
graduation: `quoteBuy.graduates`, `GraduatedToV4`, tokens sold = 84.24%, mcap = $33,333 (±0.1%) ·
floor: `FloorSeeded` with 16 bands, ≈ $1,201.27 seeded (±1%), all bands quote-only (tokenAmount 0) and summing to `quoteSeeded` ·
`SnipeEscrowToLP` = escrow and compound bucket ≥ escrow · progress 10000 · graduating-buy tx gas ≤ 3.0M (AUDIT measured ≈ 2.764M
execution at 6-dec USDG in #115's forge harness; forge `FloorSeedGas` keeps the 3.0M cap on the 18-dec harness, ≈ 2.56M) ·
**Multicall3** has code at `0xcA11bde05977b3631167028862bE2a173976CA11` (eth_getCode; AUDIT r2 #106/#131) ·
with `EXPECT_REWARDS_VAULT_OWNER` set (after step 5a): `RewardsVault.owner()` = it and `pendingOwner()` = 0.
Without `EXPECT_REWARDS_VAULT_OWNER` smoke only prints owner / pendingOwner; verify the acceptance with the two read-only `cast call`s in
step 5a (or `READ_ONLY=1` smoke), never with a tx-sending re-run unless lee gives a GO.
**Fail fast (AUDIT round 3):** smoke runs every read-only check first — code at all 17 bundle addresses + USDG, owners of the owned
contracts nonzero (`EXPECT_OWNER` to pin them), config (USDG 6 dec, referralSink, RewardsVault wiring, `MAX_LAUNCH_FEE`, launchFee,
claim router, optional RewardsVault owner), Multicall3, `LoginGate.attester() != 0` and `Launchpad.loginGate() == LoginGate` — and
if any of them FAILs it writes `ABORT: N read-only check(s) failed; no tx sent` and exits 1 **before the first tx** (mint / approve / launch / buy).
`READ_ONLY=1` stops after this phase.
Optional: `node script/redeploy/fixtures.mjs fresh|near|grad|pve` for replay coins plus post-graduation router buy/sell (STRATEGY and USDG legs).

## 9. Fork dry run (no live broadcast)

```bash
anvil --fork-url https://rpc.testnet.chain.robinhood.com --port 8545 --silent &   # chain id 46630
cd contracts && PVE_ATTESTER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 FORK=1 ./script/redeploy/redeploy.sh   # anvil key #0, attester = anvil #1 (public); writes deployments/fork/ (gitignored)
FORK=1 READ_ONLY=1 node script/redeploy/smoke.mjs                                # read-only phase only, no tx
FORK=1 node script/redeploy/smoke.mjs                                            # snipe pinned to launch+1s; evm_increaseTime skips the 7s window
FORK=1 OUT=/tmp/fx.json node script/redeploy/fixtures.mjs grad                   # optional STRATEGY coin + router swaps
```
For #106, run `DeployPaymaster.s.sol` and `DeploySessionPolicy.s.sol` against `http://127.0.0.1:8545` with the anvil key, as in section 4.
Redeploy pack: after `fixtures.mjs grad`, run `FORK=1 node script/redeploy/fixtures.mjs pack`. It covers router `swapUsdgToQuote` and
`swapQuoteToUsdg` (output == live `quoteUsdgQuoteSwap`), `launchWithUsdg` on STRATEGY, `Token.burn`, and `maxMode` == 2 (a mode 3 launch reverts `BadMode`).
`FORK=1` writes `broadcast/Deploy.s.sol/46630/run-latest.json` (gitignored), the same path a real broadcast uses; the real broadcast overwrites it.

Result 2026-10-24 ~10:55 AM CDT (fork of the live head, block 141962528, port 8546; feat/redeploy-prep with the AUDIT round 3 fail-fast
smoke; `PVE_ATTESTER` = anvil #1): deploy addresses **identical** to the 10:28 and 9:44 AM runs (all 17 contracts + 2 tokens + v4
addresses); 40,448,858 gas used (+20,140 vs the attester-0 runs: the nonzero attester slot); `READ_ONLY=1` smoke **11/11 PASS**, no tx
sent (deployer nonce unchanged); full smoke **28/28 PASS** (11 read-only first: code at 17 + USDG, owners nonzero, attester ≠ 0,
`Launchpad.loginGate`, config, Multicall3 3,808 bytes; then 17 tx checks); launch 6,712,430 gas; graduation buy 2,365,962 gas; floor
1,201.27337 USDG; mcap $33,332.999999. Negative rehearsal (anvil only: snapshot revert, `LoginGate.setAttester(0)` from the impersonated
owner): smoke prints `FAIL LoginGate.attester != 0`, `ABORT: 1 read-only check(s) failed; no tx sent`, exit 1, nonce and block unchanged.

Result 2026-10-24 ~10:28 AM CDT (fork of the live head, block 141953628; feat/redeploy-prep with the AUDIT round 2 smoke checks): deploy
addresses **identical** to the 9:44 AM run (all 17 contracts + tokens; the smoke/runbook changes don't touch Deploy.s.sol, env or
redeploy.sh), 40,428,718 gas used; smoke **24/24 PASS** (23 + Multicall3, 3,808 bytes); after the step 5a rehearsal smoke with
`EXPECT_REWARDS_VAULT_OWNER` **25/25 PASS**; launch 6,712,430 gas; graduation buy 2,365,962 gas; floor 1,201.27337 USDG; mcap $33,332.999999.

Result 2026-10-24 ~9:44 AM CDT (fork of block 141938895, branch feat/redeploy-prep after the AUDIT fixes + 7s sniper tax): core deploy
40,428,718 gas used (forge estimate 51.1M); smoke 23/23 PASS; launch 6.71M gas; First BOOST snipeEscrow 0; snipe at launch+1s taxed exactly
25% (2.5 of 10 USDG) → escrow → compound bucket at graduation; tax 0 from 7s; graduation buy 2,365,962 gas (≤ 3.0M); floor 1,201.27337 USDG
in 16 bands; graduation mcap $33,332.999999.
Earlier run (block 141892136, before the AUDIT fixes): smoke 18/18; graduation buy 2,365,864 gas;
fixtures `grad` (STRATEGY quote) graduated in a 2.40M-gas buy, floor 490,315.66 STRATEGY (≈ $1,201), router buyExactIn / sellExactIn / buyWithUsdg / sellToUsdg OK;
DisciplePaymaster (est. 2.41M gas, 0.000348 ETH deposit) and DiscipleSessionPolicy 1.4.0 (est. 4.19M gas) deployed on the fork.

## 10. Rollback

The old stack (v4) stays on chain and keeps working. To roll back: lee repoints the Vercel env to the v4 values below and redeploys the site;
the indexer keeps indexing v4 (or set `DEPLOYMENT_JSON` to the v4 json from git); SITE reverts `anon.ts`/`chains.ts` if changed;
users reinstall the old session policy. Coins launched on the new stack keep trading on it, but the site stops listing them.

| Var | v4 value |
|-----|----------|
| LAUNCHPAD | 0x4f540bc1585ca36c8a49662dc642f6e28ae534da |
| HOOK | 0x16b6a7912324b67e562769bf7ed7e048ef6128c4 |
| ROUTER | 0xb53c37baa373c22b85fd3bb27fa71b8091abd316 |
| FEE_ROUTER | 0xe7ab694edcf1c91c34be23baf493d45e83f752d9 |
| REFERRAL_REGISTRY | 0x0aa4dfb57deb37ada6de375da06aba5dc2099a9c |
| LOCKED_LP | 0x6edb30bce65f87aeb750822de0de36b1cabd3d9a |
| QUOTE_PRICER | 0xe173a0f0b8d44a7686fbd32958d65375ff77314f |
| QUOTE_PROBE | 0x4d6e5131d197318da7aeb502659486eb00bf4c1f |
| MIGRATION | 0x37f20243c2cb78613fcfbd58607ce9905cf423b0 |
| ANTI_SNIPE | 0xe21904fc33220a81e23a5f0cd3fdeba6a644f45e |
| TRAMP_WALL_MANAGER | 0x9c9693c44b5c09d318c95ba351ca4f70965c6cde |
| MARKET_LENS | 0x3afe8b96fba7c47790d6d195f0070edd560165ae |
| LOGIN_GATE | 0xe900b7060895f130e866eeddec2b3efd3ff0b69f |
| USDG_DEPOSIT_NOTIFIER | 0xaf5d4a15ee996140e83179952f0a0cf46c93f6d9 |
| DEFAULT_QUOTE | 0xd4d0eB01960AACE441bFcb323Bfaf7c3d8b555a3 |
| USDG / USDG_DECIMALS | 0x25030Bff74764aD72b912276a603717DB1C00644 / 18 |
| FROM_BLOCK | 137540728 |
| SESSION_POLICY | 0x3d3667e8880c6b633b424d645b8004788b1d6e27 |
(Also CurveDeployer 0x5f64…1550, RewardsVault 0x1f42…8b9e, AnonLauncher 0x06f3…a527.)

## 11. AUDIT fixes (reviews of 2026-10-24 on #121 #127 #106 #131; no critical/high)

| Finding | Fix | Where | Script / env / ABI / smoke impact |
|---------|-----|-------|-----------------------------------|
| Medium: `MAX_LAUNCH_FEE = 5 ether` (AnonLauncher.sol:50/:111/:124) | cap = `5 * 10**feeToken.decimals()` (immutable, same getter) | #115 b6a91177 → here 2f55717a | smoke check added; no env change |
| Medium: token-side `Trade.fee` floored WAD price at 6 dec | value from sqrtPriceX96 | #115 80b06f22 → here 06d46f16 | indexer `fee` values become exact; no ABI change |
| Low: FeeRouter.sol:193 sink vs treasury | sink equal to the treasury follows `setTreasury` | #127 98fac352 | none (no ABI change; `ReferralSinkSet` emitted on the move) |
| Low: RewardsVault.sol:41 one-step owner | Owned2Step | #121 69117a5d | **REWARDS_VAULT_OWNER must `acceptOwnership()`** (section 5); ABI: `pendingOwner`, `acceptOwnership`, Owned2Step events |
| Low: FeeRouter.sol:276 any trusted router claims creator fees | owner-set `isClaimRouter` allowlist | #121 957a463b | Deploy.s.sol wires DiscipleRouter; ABI adds `setClaimRouter`, `isClaimRouter`, `ClaimRouterSet`; smoke check added |
| Low (#106) gradBuy.ts:28/:40, gasPolicy.ts:132 | relay-side only | #106 16376682 | none for the deploy |
| Info: grad gas ≈ 2.76M at 6 dec | numbers refreshed, 3.0M cap kept | #106 3128ad31, smoke | smoke asserts ≤ 3.0M |
| Round 2 Low (#106) gasPolicy.ts:168/:177: `[anyCall, gradBuy]` / trailing approve-selector call still got grad caps | grad caps only for the exact `[approve(quote, curve\|router)*, buy]` shape (plus our paymaster's leading USDG approve), funding checked post-approve | #106 5d7bc665, c6e5812d, ec6cb2bc | relay-side only; none for the deploy |
| Round 2 run item (#106/#131): Multicall3 on 46630 unverified | pre-flight item 10 + smoke check (eth_getCode) | this PR | read-only; fork: 3,808 bytes |
| Round 2 run item (#121/#127/#131): RewardsVault `acceptOwnership` | step 5a + smoke `EXPECT_REWARDS_VAULT_OWNER` check | this PR | one tx by REWARDS_VAULT_OWNER after the deploy |
| Round 2 (#127): cut the redeploy from #131, not #127 | merge-order note + pre-flight item 9 | this PR | none |
| Round 3 (#131): smoke must fail fast | all read-only checks first; any FAIL ⇒ `ABORT … no tx sent` before mint/approve/launch/buy; `READ_ONLY=1` | this PR | smoke only; fork 28/28 |
| Round 3 (#131): post-acceptOwnership smoke re-run sends live txs | step 5a: two read-only `cast call`s (`owner()`, `pendingOwner() == 0`) or `READ_ONLY=1`; tx-sending re-runs need lee's GO | this PR | none |
| Round 3 (#131): `PVE_ATTESTER` unset ⇒ LoginGate attester 0x0 (Deploy.s.sol:230) | pre-flight item 11 + smoke `LoginGate.attester() != 0` (read-only) | this PR | env must be exported; no Deploy.s.sol change |
| I-2 (#141): ERC-7562 needs a staked paymaster | LEE DECISION, pre-flight item 12 (default: no stake; we self-relay) | this PR | `PAYMASTER_STAKE_WEI` unset unless lee picks (b) |
| Round 2 Info (#121): Easy First BOOST never unlocks without graduation | SITE copy item (section 6) | SITE | none |
| Round 2 Info (#127): MarketLens 7 s for legacy curves; `SnipeEscrowReleased` attribution | section 6 / section 7 notes | SITE / indexer | none |
| lee 2026-10-24: sniper tax 77 s linear → 7 s | per-second table 99/25/3/1/0.3/0.1/0.03 %, 0 from 7 s (`FeeMath.snipeBps`) | #127 01afead5 | smoke checks the table value at the snipe's second and 0 from 7 s; `MarketLens.sniperTax` window 7; SITE/GAME copy + sim |
| lee 2026-10-23 check: Easy First BOOST lock | already enforced (Token.sol `_update`, keyed on `from == creator`); tests for spender / recipient bypass and Hard same-block sell | #127 f2514cb6 | none |

Not taken (Info, no behaviour risk today): optional payer `maxFee` on `launchAnon` (ABI change + session-policy decoding; owner fee is
now capped at $5); LockedLP.sol:581 best-effort floor seeding at extreme prices and :595 unreachable `FloorOverspend` (would change
graduation semantics in a SHIP'd PR); Migration.sol:151 require success for v2 curves; `releaseSnipeEscrow` event.
Round 2 rulings: all four accepted for the testnet. Also not taken now: dropping the legacy `AntiSnipe` from Deploy.s.sol (AUDIT #127 r2
Info) — it would shift every later CREATE address (and the pre-computed Launchpad); revisit with the next redeploy.
The scripts read ABIs from the forge artifacts and take params from env, so contract-internal fixes need no script change.

Open items for AUDIT / lee:
- ~~`AnonLauncher.MAX_LAUNCH_FEE = 5 ether` 18-decimal cap~~ fixed (decimals-aware, 2f55717a; smoke checks 5 USDG).
- Old testnet tokens (mUSDG, STRATEGY) are 18-dec and are replaced, not migrated: user balances on the old mUSDG don't carry over.
- The session policy must be redeployed (new ReferralRegistry), with or without #106; users reinstall sessions.
- Launch costs about 6.7–6.8M gas (`fixtures.mjs` uses an 8M cap); check the AA/relay launch caps (#106 assumes 11M).

## 12. Mainnet launch checklist (paymaster cap)

LEE DECISION 2026-10-24 11:28 CT: "$3-5 to start on mainnet".

1. `script/DeployPaymaster.s.sol` is **46630-only** (`require(block.chainid == 46630)`), so mainnet needs its own deploy path
   (a mainnet script, or a chain-gated variant, built and reviewed before launch). Start with `PAYMASTER_MAX_COST_USDG` = 3–5
   (WHOLE USDG, same [0.1, 100] guard; 3000000–5000000 raw at 6 decimals). Lee picks the exact value on deploy day. Do not
   rely on the 10 USDG default.
2. Verify with `cast call <DisciplePaymaster> 'maxCostCap()(uint256)' --rpc-url <mainnet rpc>`; it must equal the chosen value × 10**decimals.
3. Measure real per-op gas for about a week. Use the paymaster `UserOperationCharged` (and `DebtRecorded`) events and the per-op `actualGasCost`, split
   by op type (buy, sell, launch, First BOOST launch, session install).
4. Then tighten the cap, and the rate band if needed, with
   `DisciplePaymaster.setBounds(minRate, maxRate, maxCostCap)` (owner only; emits `BoundsSet`). Set `maxCostCap` to about the
   measured worst real op × the rate headroom. `setBounds` refuses anything above `maxCostCapLimit` (100 USDG).
   **Before lowering the cap, check debts:** a sender whose outstanding debt (`owedOf`) is above the new cap is blocked until
   they repay or the owner calls `forgiveDebt`. List senders from `DebtRecorded` events, read `owedOf` for each, and settle or
   forgive (with lee's OK) before tightening.
5. **Any `setBounds` broadcast needs lee's explicit OK** (value and timing). Never as part of a script run.

