# RewardsVault runbook (community rewards: late / never-graduated coins' sniper tax + curve LP fees)

lee, 2026-11-10 7:44 AM CT: "we need a rewards vault made. we can do a temporary wallet for now, but it should go to a
multisig for mainnet". NOTHING here has been run. Every `cast send` / `--broadcast` is a live tx and needs lee's GO.

## What exists (read 2026-11-10)
- Contract: `src/RewardsVault.sol`, **Owned2Step** (`transferOwnership` nominates, nominee calls `acceptOwnership`;
  `transferOwnership(0)` cancels). Owner-only: `distribute(asset, to[], amounts[])`, `setFeeRouter`. Test: `test/RewardsVaultOwnership.t.sol`.
- Wiring: `FeeRouter.setRewardsVault(vault)` (FeeRouter owner only). Curves read `FeeRouter.rewardsVault()` at the moment
  they pay (`releaseSnipeEscrow`, and a graduation after the 12-day timeout). Unset (0): release reverts `ZeroRecipient`;
  a late graduation keeps both escrows for the compound bucket (old destination).
- Fresh stack: `script/Deploy.s.sol` `_addons` already deploys it (`new RewardsVault(deployer)`, `setFeeRouter`,
  `FeeRouter.setRewardsVault`) and nominates `REWARDS_VAULT_OWNER` (default: deployer). Deploy.s.sol is testnet/local only
  (`block.chainid == 46630 || 31337`); there is no mainnet deploy script yet.
- rh-testnet (46630, deployments/rh-testnet-46630.json), read-only `cast call` on 2026-11-10:
  - RewardsVault `0xf1a2784de1ded172f4b10b242f124f60a6ab38c0` has code; `FeeRouter(0xa5aa…ed8c).rewardsVault()` = it;
    `RewardsVault.feeRouter()` = that FeeRouter.
  - `owner()` = deployer EOA `0xd9fdF29fBAB9Be7cA1F6A3A07e0c36D65170AEf5`, `pendingOwner()` = 0 (REWARDS_VAULT_OWNER was
    unset at deploy). FeeRouter owner = same deployer. USDG balance 0.
  - `Launchpad.snipeEscrowTimeout()` = 2592000 (30 days); DeployLpAccrue with WIRE=true sets 12 days for future launches.
- New for an existing stack: `script/rewards/DeployRewardsVault.s.sol` (same steps as `_addons`, WIRE opt-in like
  DeployLpAccrue). `REWARDS_VAULT_OWNER` is required (no default); off testnet/local it must be a contract (the Safe).

## Env lee must supply (no address is picked here)
- `REWARDS_VAULT_OWNER`: the TEMP wallet on testnet; the mainnet multisig (Safe) on mainnet.
- `MULTISIG` (step 3 only): the Safe that takes over later.
- `RPC`, and the signer for each step (deployer / FeeRouter owner / REWARDS_VAULT_OWNER / Safe), via your usual
  `--account` / hardware wallet flags.

## Testnet now: pick ONE
**A. Reuse the existing vault (recommended; no deploy, no rewiring).** The current owner (deployer `0xd9fd…AEf5`) nominates
the temp wallet; the temp wallet accepts.
```bash
RV=0xf1a2784de1ded172f4b10b242f124f60a6ab38c0; RPC=https://rpc.testnet.chain.robinhood.com
cast send $RV "transferOwnership(address)" $REWARDS_VAULT_OWNER --rpc-url $RPC   # signed by the current owner (deployer)
cast send $RV "acceptOwnership()" --rpc-url $RPC                                  # signed by REWARDS_VAULT_OWNER
cast call $RV "owner()(address)" --rpc-url $RPC          # == REWARDS_VAULT_OWNER
cast call $RV "pendingOwner()(address)" --rpc-url $RPC   # == 0x0
```

**B. A new vault.**
```bash
cd contracts
# dry run (no broadcast) first, then add --broadcast on lee's GO. WIRE=true only if the signer owns FeeRouter.
REWARDS_VAULT_OWNER=<temp wallet> LAUNCHPAD=0x8a92e51940909424B3aACEFff99B4834588C0988 WIRE=false \
  forge script script/rewards/DeployRewardsVault.s.sol --rpc-url $RPC
# if WIRE=false: the FeeRouter owner wires it
cast send $FEE_ROUTER "setRewardsVault(address)" $NEW_RV --rpc-url $RPC
# the temp wallet accepts
cast send $NEW_RV "acceptOwnership()" --rpc-url $RPC
cast call $FEE_ROUTER "rewardsVault()(address)" --rpc-url $RPC   # == NEW_RV
```
Rollback: `FeeRouter.setRewardsVault(<previous, printed by the script>)`. Funds already in a vault stay with that vault's
owner (`distribute`). Update `contracts/deployments/rh-testnet-46630.json` / web-bundle `RewardsVault` and the indexer's
stack `rewardsVault` if the address changes; `node script/redeploy/smoke.mjs` checks `FeeRouter.rewardsVault` against it
(`READ_ONLY=1 EXPECT_REWARDS_VAULT_OWNER=<owner>` is the no-tx check).

## 1 → 3. Moving to the multisig (testnet later, or mainnet)
```bash
cast send $RV "transferOwnership(address)" $MULTISIG --rpc-url $RPC   # by the current owner (temp wallet)
# the old owner keeps control until the Safe accepts; transferOwnership(0) cancels a wrong nomination
# from the Safe (Safe UI / transaction builder): RV.acceptOwnership()
cast call $RV "owner()(address)" --rpc-url $RPC         # == MULTISIG
cast call $RV "pendingOwner()(address)" --rpc-url $RPC  # == 0x0
```
Mainnet: deploy with `REWARDS_VAULT_OWNER=<Safe>` directly (the script refuses an EOA off testnet) and add RewardsVault to
the Safe ownership checklist in `docs/mainnet-plan.md` (already listed there).
