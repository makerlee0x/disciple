# Mainnet deploy guide (Robinhood Chain 4663)

Covers `contracts/script/Deploy.s.sol` with the fee hook that holds fees until claim (maker 2026-11-19). The broader
plan and history live in `contracts/docs/mainnet-plan.md` and `contracts/docs/redeploy-runbook.md`.

## 1. Config

Copy `contracts/script/config/mainnet.env.example` to `mainnet.env` and fill:

| Var | What | Fixed after deploy? |
|---|---|---|
| `TREASURY` | treasury Safe | yes: DiscipleHook (33% share) and LockedLP store it for good. Use the final treasury Safe, not a temp wallet. |
| `COMMUNITY_SAFE` | community rewards Safe, separate from the treasury, already deployed | yes: DiscipleHook (1% share) and `FeeRouter.referralSink` (locked by `lockSettings`) |
| `PRICER_POKER` | relayer EOA the poke-pricer / lp-flush crons sign with | no |
| `REWARDS_VAULT_OWNER` | optional; defaults to `COMMUNITY_SAFE` on 4663 | nominated; the Safe must `acceptOwnership()` |

`COMMUNITY_SAFE` is still a placeholder (maker to send the address). The preflight refuses to broadcast on 4663 until
it is set to a contract that is not the treasury.

## 2. Where the money goes

| Flow | Destination |
|---|---|
| Graduated pool trades: 1% fee | held by DiscipleHook (PoolManager ERC-6909 balance), split 33/33/33/1 at claim |
| Hook 33% creator | `Launchpad.creatorOf(token)` at claim time; LockedLP for lock coins; `0x…dEaD` for burn coins |
| Hook 33% locked liquidity | LockedLP compound bucket (`flush` adds it) |
| Hook 33% treasury | `TREASURY` |
| Hook 1% | `COMMUNITY_SAFE` |
| Curve trades: 1% | `FeeRouter.referralSink` = `COMMUNITY_SAFE` (every trade, referred or not); the Safe calls `claimReferrerFees` on FeeRouter / CurveFeeVault |
| Unclaimed sniper fee after 12 days | RewardsVault, owned by `COMMUNITY_SAFE` |
| Easy holder tip with no other holder | `COMMUNITY_SAFE` (sent directly by the curve) |

Hook claims are public: `claimCreatorFees`, `claimLockedLiquidityFees`, `claimTreasuryFees`, `claimCommunityFees`
(one coin each) and `claimAll(address[])` (every share with something owed). The caller never receives anything, so a
keeper, a bot or a person can run them. Nothing needs a cron for trading to work.

Referrers are still paid by hand from the daily referral spreadsheet (`/api/cron/referral-payout`), which reads the
router's trade event and `ReferralRegistry`.

## 3. Owner settings that stay adjustable

| Setting | Default | Range | Who | Affects |
|---|---|---|---|---|
| `Launchpad.setCrewTipPpm` (Easy holder tip) | 33,000 ppm (3.3%) | 0 to 120,000 (12%) | Launchpad owner | new coins only |
| `Launchpad.setCrewTipThresholdBps` (tip cutoff, share of mcap) | 50 (0.5%) | 10 to 1,200 (12%) | Launchpad owner | new coins only |

Nothing in the hook is adjustable: fee, split and recipients are fixed at deploy, and the admin is renounced.

## 4. Deploy

Dry run on an anvil fork first, then the real broadcast (same as before):

```bash
cd contracts
set -a; . script/config/mainnet.env; set +a
anvil --fork-url https://rpc.mainnet.chain.robinhood.com   # dry run, separate terminal
forge script script/Deploy.s.sol --tc Deploy --rpc-url http://127.0.0.1:8545 --broadcast --private-key <anvil key 0>
# real deploy
forge script script/Deploy.s.sol --tc Deploy --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --account disciple-deployer --sender <deployer> --broadcast --slow
```

The script reads back and requires, on 4663: hook not authorized on FeeRouter, `hook.creatorFeeHarvest() == harvest`,
`lockedLP.hook() == hook`, `anon.hook() == hook`, `FeeRouter.referralSink() == hook.communitySafe() != treasury`,
`hook.treasury() == FeeRouter.treasury()`, hook admin renounced, LockedLP and harvest renounced, fee settings locked.

After deploy, the community Safe accepts RewardsVault ownership (`acceptOwnership()`).

## 5. Explorer verification (every contract)

Uniswap's routing review for hooked pools needs verified source, so verify every contract the script deploys,
starting with DiscipleHook. Same compiler settings as the build: solc 0.8.26, `via_ir = true`, optimizer 200 runs,
`evm_version = cancun` (all from `foundry.toml`).

The broadcast file `broadcast/Deploy.s.sol/4663/run-latest.json` lists every deployed address and its constructor
args. `--guess-constructor-args` reads them from the creation tx, so one command per contract is enough:

```bash
EXPLORER=https://explorer.chain.robinhood.com/api/   # confirm the mainnet Blockscout API URL before running
for row in \
  "src/DiscipleHook.sol:DiscipleHook <hook>" \
  "src/FeeRouter.sol:FeeRouter <feeRouter>" \
  "src/LockedLP.sol:LockedLP <lockedLP>" \
  "src/Migration.sol:Migration <migration>" \
  "src/Launchpad.sol:Launchpad <launchpad>" \
  "src/DiscipleRouter.sol:DiscipleRouter <router>" \
  "src/ReferralRegistry.sol:ReferralRegistry <referrals>" \
  "src/QuotePricer.sol:QuotePricer <pricer>" \
  "src/QuoteProbe.sol:QuoteProbe <probe>" \
  "src/CurveFeeVault.sol:CurveFeeVault <feeVault>" \
  "src/CurveDeployer.sol:CurveDeployer <curveDeployer>" \
  "src/RewardsVault.sol:RewardsVault <rewardsVault>" \
  "src/addons/CreatorFeeHarvest.sol:CreatorFeeHarvest <harvest>" \
  "src/addons/AnonLauncher.sol:AnonLauncher <anonLauncher>" \
  "src/addons/MarketLens.sol:MarketLens <marketLens>"; do
  set -- $row
  forge verify-contract "$2" "$1" --chain-id 4663 --verifier blockscout --verifier-url "$EXPLORER" \
    --rpc-url https://rpc.mainnet.chain.robinhood.com --guess-constructor-args --watch
done
```

Also verify, once each:

- **Token and BondingCurve** of the first coin (canary launch). Every later coin has the same bytecode, so Blockscout
  matches them automatically. BondingCurve is created by CurveDeployer from its stored code, so verify it with
  `--constructor-args` taken from the curve's creation input (the bytes after the creation code).
- **DisciplePermitForwarder**, deployed separately by `script/DeployPermitForwarder.s.sol`.

Check: each address shows "Contract source code verified" on the explorer, and DiscipleHook's page shows the
`afterSwap` / `claim*` functions. Send that link with the Uniswap hook allowlist request.

## 6. Site

- `NEXT_PUBLIC_RH_HOOK` = the new hook. The creator fee screen adds the hook's `claimable(token, 0)` to each graduated
  coin and puts `hook.claimCreatorFees(token)` in the same claim batch, so it is still one transaction.
- Hidden coins: AnonLauncher pulls the hook's creator share itself (`pending` already includes it).
