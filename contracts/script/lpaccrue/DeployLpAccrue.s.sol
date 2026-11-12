// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {CurveFeeVault} from "../../src/CurveFeeVault.sol";
import {CurveDeployer} from "../../src/CurveDeployer.sol";

interface IAnonLauncherView {
    function launchpad() external view returns (address);
}

interface ILaunchpadOwner {
    function owner() external view returns (address);
    function feeRouter() external view returns (address);
    function curveDeployer() external view returns (address);
    function snipeEscrowTimeout() external view returns (uint256);
    function setCurveDeployer(address d) external;
    function setSnipeEscrowTimeout(uint256 secs) external;
}

/// @notice lp-accrue rollout (NEW curves only): deploy CurveFeeVault(FeeRouter, AnonLauncher) + CurveDeployer(vault).
///         NOT RUN. Needs lee's explicit OK and AUDIT review first. Existing curves are untouched (immutable).
///         Step 1 (any EOA):   forge script script/lpaccrue/DeployLpAccrue.s.sol --rpc-url $RPC_URL [--broadcast]
///         Step 2 (Launchpad owner, only with WIRE=true): Launchpad.setCurveDeployer(new) and, if the stored value
///         is not already 12 days, Launchpad.setSnipeEscrowTimeout(12 days). Rollback: setCurveDeployer(previous).
///         Env: LAUNCHPAD (default testnet 0x8a92…0988), ANON_LAUNCHER (default testnet v5 contracts.AnonLauncher
///         0x73a2…C509, deployments/rh-testnet-46630.json; must be wired to LAUNCHPAD), WIRE (default false).
///         AUDIT H1: the vault's immutable anonLauncher lets that launcher's stealth owners claim private coins'
///         creator fees (claimCreatorFeesAsStealth / …BySig). Do not wire a vault without it.
contract DeployLpAccrue is Script {
    function run() external returns (CurveFeeVault vault, CurveDeployer deployer) {
        ILaunchpadOwner lp = ILaunchpadOwner(vm.envOr("LAUNCHPAD", address(0x8a92e51940909424B3aACEFff99B4834588C0988)));
        address feeRouter = lp.feeRouter();
        address previous = lp.curveDeployer();
        bool wire = vm.envOr("WIRE", false);
        address anon = vm.envOr("ANON_LAUNCHER", address(0x73a2a6e049aa21A5C440F3bc358dE37FE3f7C509));
        require(anon != address(0) && IAnonLauncherView(anon).launchpad() == address(lp), "anon launcher / launchpad");

        vm.startBroadcast();
        vault = new CurveFeeVault(feeRouter, anon);
        deployer = new CurveDeployer(address(vault));
        if (wire) {
            lp.setCurveDeployer(address(deployer)); // onlyOwner
            if (lp.snipeEscrowTimeout() != 12 days) lp.setSnipeEscrowTimeout(12 days); // onlyOwner
        }
        vm.stopBroadcast();

        require(address(vault.feeRouter()) == feeRouter, "vault feeRouter");
        require(deployer.feeVault() == address(vault), "deployer vault");
        require(vault.anonLauncher() == anon, "vault anonLauncher");
        console2.log("CurveFeeVault", address(vault));
        console2.log("CurveFeeVault.anonLauncher", anon);
        console2.log("CurveDeployer (lp-accrue)", address(deployer));
        console2.log("previous CurveDeployer (rollback)", previous);
        console2.log("wired", wire);
    }
}
