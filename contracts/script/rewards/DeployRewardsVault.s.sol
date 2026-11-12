// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RewardsVault} from "../../src/RewardsVault.sol";

interface ILaunchpadFeeRouter {
    function feeRouter() external view returns (address);
}

interface IFeeRouterRewards {
    function owner() external view returns (address);
    function rewardsVault() external view returns (address);
    function setRewardsVault(address vault) external;
}

/// @notice Community RewardsVault for an EXISTING stack (lee 2026-11-10 7:44 AM CT: "we need a rewards vault made. we can
///         do a temporary wallet for now, but it should go to a multisig for mainnet"). NOT RUN: lee's explicit OK first.
///         Same three steps as Deploy.s.sol `_addons` (new RewardsVault(deployer); vault.setFeeRouter(FeeRouter);
///         FeeRouter.setRewardsVault(vault)) and the same Owned2Step nomination of REWARDS_VAULT_OWNER; wiring is
///         opt-in with WIRE=true like script/lpaccrue/DeployLpAccrue.s.sol.
///
///         REWARDS_VAULT_OWNER (REQUIRED, no default): the vault owner (calls `distribute`).
///           - TEMP wallet on testnet (lee: "a temporary wallet for now"),
///           - a multisig (Safe) on mainnet. Off testnet/local the script refuses an owner without code (an EOA).
///           The deploy only NOMINATES it (Owned2Step); that wallet must call vault.acceptOwnership() afterwards.
///           Moving to the multisig later: owner calls transferOwnership(multisig), the multisig calls acceptOwnership().
///         LAUNCHPAD  (default testnet 0x8a92…0988, deployments/rh-testnet-46630.json): its FeeRouter is used.
///         WIRE       (default false): also FeeRouter.setRewardsVault(new vault). Only the FeeRouter owner can; run it
///                    from that key, or have the FeeRouter owner send setRewardsVault(vault) separately.
///         Release / late-graduation transfers from curves land here as plain balance (events on the curve:
///         SnipeEscrowReleased / LpFeeEscrowReleased); FeeRouter.rewardsVault() is read at that moment, so switching it
///         redirects future releases only; funds already in a previous vault stay with that vault's owner.
contract DeployRewardsVault is Script {
    function run() external returns (RewardsVault vault) {
        address vOwner = vm.envAddress("REWARDS_VAULT_OWNER");
        require(vOwner != address(0), "REWARDS_VAULT_OWNER");
        if (block.chainid != 46630 && block.chainid != 31337) {
            require(vOwner.code.length != 0, "mainnet: REWARDS_VAULT_OWNER must be the multisig (has code)");
        }
        address launchpad = vm.envOr("LAUNCHPAD", address(0x8a92e51940909424B3aACEFff99B4834588C0988));
        IFeeRouterRewards feeRouter = IFeeRouterRewards(ILaunchpadFeeRouter(launchpad).feeRouter());
        address previous = feeRouter.rewardsVault();
        bool wire = vm.envOr("WIRE", false);

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        vault = new RewardsVault(deployer);
        vault.setFeeRouter(address(feeRouter));
        if (wire) feeRouter.setRewardsVault(address(vault)); // FeeRouter onlyOwner
        // Owned2Step: this only nominates; REWARDS_VAULT_OWNER must call vault.acceptOwnership() afterwards.
        if (vOwner != deployer) vault.transferOwnership(vOwner);
        vm.stopBroadcast();

        require(vault.feeRouter() == address(feeRouter), "vault feeRouter");
        if (wire) require(feeRouter.rewardsVault() == address(vault), "FeeRouter.rewardsVault");
        console2.log("RewardsVault", address(vault));
        console2.log("owner (until accepted)", vault.owner());
        console2.log("pendingOwner (REWARDS_VAULT_OWNER)", vault.pendingOwner());
        console2.log("FeeRouter", address(feeRouter));
        console2.log("previous FeeRouter.rewardsVault (rollback)", previous);
        console2.log("wired", wire);
    }
}
