# DISCIPLE testnet redeploy runbook (RH testnet 46630)

One redeploy that ships: steep curve #1 (84.24% sold, $3,333 → $33,333), the 16-band USDG-only graduation floor,
FeeRouter `referralSink`, the 77s sniper tax (99% → 0) held in escrow and sent to the compound bucket at graduation,
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
   ANTI_SNIPE 9900 / 77, MAX_FLOOR_BANDS 16, referralSink 0x0.

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
PAYMASTER_DEPOSIT_WEI=<≥ 348000000000000 per 11M-gas launch> PAYMASTER_STAKE_WEI=<stake, 1-day unstake> \
forge script script/DeployPaymaster.s.sol --rpc-url https://rpc.testnet.chain.robinhood.com --private-key "$PRIVATE_KEY" --broadcast --slow
REFERRAL_REGISTRY=<new ReferralRegistry> PAYMASTER=<DisciplePaymaster> \
forge script script/DeploySessionPolicy.s.sol --rpc-url https://rpc.testnet.chain.robinhood.com --private-key "$PRIVATE_KEY" --broadcast --slow
SESSION_POLICY=<policy> PAYMASTER=<paymaster> node script/redeploy/postprocess.mjs broadcast   # records addons; idempotent
```

The session policy must be redeployed in any case: its constructor takes the ReferralRegistry, which is new. Users reinstall sessions (policy 1.4.0).
`PAYMASTER_MAX_COST` defaults to 10 USDG at the token's decimals; `PAYMASTER_POST_OP_GAS` 30000.
Paymaster keeper (server): `PAYMASTER_KEEPER_KEY`, `PAYMASTER_MIN_DEPOSIT_WEI`, `PAYMASTER_TARGET_DEPOSIT_WEI`; run `pnpm paymaster:keeper --send --loop`.
Fork e2e before going live: `pnpm test:paymaster-e2e`.

## 5. Wiring and ownership

All done inside `Deploy.s.sol`; verify with `cast call`:
- `FeeRouter.rewardsVault()` = RewardsVault; `RewardsVault.feeRouter()` = FeeRouter. RewardsVault is now **Owned2Step**: the deploy only
  nominates `REWARDS_VAULT_OWNER` (`pendingOwner`); that wallet must then call `cast send <RewardsVault> "acceptOwnership()"`.
  Until it does, the deployer stays owner.
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
**GAME updates:** regenerate `web/public/flight/engine.js` after #128/#129 land; bot sizing assumes the steep curve; any sim fixtures
that hold testnet addresses come from the web bundle.

## 7. Indexer re-point

The indexer reads `contracts/deployments/rh-testnet-46630.json` (`DEPLOYMENT_JSON`) and walks `previous`, so the new stack (id v5) is
indexed from its `startBlock` and the old stacks keep indexing. After the deployments json is on the indexer host:
restart it; if the json lacks `startBlock`, set `START_BLOCK=<first deploy block>`. `STACKS=v5` restricts to the new stack.
Check the indexer catches up to head and that the smoke coin appears.

## 8. Smoke (live testnet, after deploy)

```bash
cd contracts; set -a; . /workspace/anypair/.secrets/testnet-deployer.env; set +a
GRADUATE=1 node script/redeploy/smoke.mjs     # waits out the 77s window in real time; ~9,000 USDG minted from the mock
```

Checks (each prints PASS/FAIL, exit 1 on any FAIL, writes `deployments/rh-testnet-46630.smoke.json`):
USDG decimals 6 · `referralSink` = 0 (or `EXPECT_REFERRAL_SINK`) · RewardsVault wired · `AnonLauncher.MAX_LAUNCH_FEE() == 5 * 10**usdg.decimals()`
and `launchFee` ≤ it · `FeeRouter.isClaimRouter(DiscipleRouter)` · SEC-01 (`addLockedLiquidity` from an EOA reverts) ·
sniper buy inside 77s is taxed into `snipeEscrow`, no `SnipeFeeRouted`, RewardsVault delta 0 · tax 0 after 77s ·
graduation: `quoteBuy.graduates`, `GraduatedToV4`, tokens sold = 84.24%, mcap = $33,333 (±0.1%) ·
floor: `FloorSeeded` with 16 bands, ≈ $1,201.27 seeded (±1%), all bands quote-only (tokenAmount 0) and summing to `quoteSeeded` ·
`SnipeEscrowToLP` = escrow and compound bucket ≥ escrow · progress 10000 · graduating-buy tx gas ≤ 3.0M (AUDIT measured ≈ 2.764M
execution at 6-dec USDG in #115's forge harness; forge `FloorSeedGas` keeps the 3.0M cap on the 18-dec harness, ≈ 2.56M).
Optional: `node script/redeploy/fixtures.mjs fresh|near|grad|pve` for replay coins plus post-graduation router buy/sell (STRATEGY and USDG legs).

## 9. Fork dry run (no live broadcast)

```bash
anvil --fork-url https://rpc.testnet.chain.robinhood.com --port 8545 --silent &   # chain id 46630
cd contracts && FORK=1 ./script/redeploy/redeploy.sh                              # anvil key #0; writes deployments/fork/ (gitignored)
FORK=1 node script/redeploy/smoke.mjs                                            # evm_increaseTime skips the 77s window
FORK=1 OUT=/tmp/fx.json node script/redeploy/fixtures.mjs grad                   # optional STRATEGY coin + router swaps
```
For #106, run `DeployPaymaster.s.sol` and `DeploySessionPolicy.s.sol` against `http://127.0.0.1:8545` with the anvil key, as in section 4.
`FORK=1` writes `broadcast/Deploy.s.sol/46630/run-latest.json` (gitignored), the same path a real broadcast uses; the real broadcast overwrites it.

Result 2026-10-24 (fork of block 141892136, branch feat/redeploy-prep): core deploy 51 txs, 40,180,273 gas used (forge estimate 50.8M; largest tx CurveDeployer
5.74M); smoke 18/18 PASS; launch 6.68M gas; graduation buy 2,365,864 gas; floor 1,201.27337 USDG in 16 bands; graduation mcap $33,332.999999;
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

Not taken (Info, no behaviour risk today): optional payer `maxFee` on `launchAnon` (ABI change + session-policy decoding; owner fee is
now capped at $5); LockedLP.sol:581 best-effort floor seeding at extreme prices and :595 unreachable `FloorOverspend` (would change
graduation semantics in a SHIP'd PR); Migration.sol:151 require success for v2 curves; `releaseSnipeEscrow` event.
The scripts read ABIs from the forge artifacts and take params from env, so contract-internal fixes need no script change.

Open items for AUDIT / lee:
- `AnonLauncher.MAX_LAUNCH_FEE = 5 ether` is an 18-decimal cap. With 6-dec USDG it allows up to 5e12 USDG, so the cap does nothing.
  Our 0.25 USDG (250000 raw) is fine; the cap needs a decimals-aware value (contract change).
- Old testnet tokens (mUSDG, STRATEGY) are 18-dec and are replaced, not migrated: user balances on the old mUSDG don't carry over.
- The session policy must be redeployed (new ReferralRegistry), with or without #106; users reinstall sessions.
- Launch costs about 6.7–6.8M gas (`fixtures.mjs` uses an 8M cap); check the AA/relay launch caps (#106 assumes 11M).
