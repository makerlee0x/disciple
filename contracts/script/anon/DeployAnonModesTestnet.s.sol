// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/Script.sol";
import {NetworkConfig} from "../config/NetworkConfig.sol";
import {AnonLauncher} from "../../src/addons/AnonLauncher.sol";
import {CurveFeeVault} from "../../src/CurveFeeVault.sol";
import {CurveDeployer} from "../../src/CurveDeployer.sol";
import {DisciplePermitForwarder} from "../../src/addons/DisciplePermitForwarder.sol";

interface ILaunchpadOwnerView {
    function setCurveDeployer(address d) external;
}

/// @notice TESTNET ONLY (46630): turns on hidden launches on every difficulty on the live v6 stack (maker 2026-11-16 "turn it on").
///         Deploys, from the current v6 AnonLauncher's config:
///           1. AnonLauncher with launchAnonWithMode / launchAnonWithUsdgMode + Easy boost hold (PR #445)
///              (default 0, maker 2026-11-16).
///           2. CurveFeeVault(feeRouter, newAnon) + CurveDeployer(vault), then Launchpad.setCurveDeployer. The vault's anonLauncher
///              is immutable, so new coins need it for stealth owners to claim curve-phase creator fees. Existing coins keep
///              their own curve's vault.
///           3. DisciplePermitForwarder (signed `mode` in the AnonLaunch witness), CREATE2 salt v2.
///         The broadcaster must be the Launchpad owner (setCurveDeployer). Private pool / buy-and-burn launches stay off on
///         testnet (the harvest is not re-pointed). Then set in web: ANON_ADDONS[46630].anonLauncher, the forwarder default,
///         and ANON_ANY_MODE_LIVE.
///         forge script script/anon/DeployAnonModesTestnet.s.sol --rpc-url https://rpc.testnet.chain.robinhood.com --broadcast <signer>
contract DeployAnonModesTestnet is NetworkConfig {
    bytes32 constant FORWARDER_SALT = keccak256("DISCIPLE.DisciplePermitForwarder.v2");

    function run()
        external
        returns (AnonLauncher anon, CurveFeeVault vault, CurveDeployer deployer, DisciplePermitForwarder fwd)
    {
        require(!_checkNetwork() && block.chainid == 46630, "testnet only");
        AnonLauncher v6 = AnonLauncher(vm.envOr("ANON_V6", address(0x526784706e5Ef369412ABe65213ED65256182C6b)));
        ILaunchpadOwnerView lp = ILaunchpadOwnerView(address(v6.launchpad()));
        address feeRouter_ = address(v6.feeRouter());

        vm.startBroadcast();
        anon = new AnonLauncher(
            v6.owner(), address(lp), feeRouter_, address(v6.feeToken()), address(v6.announcer())
        );
        vault = new CurveFeeVault(feeRouter_, address(anon));
        deployer = new CurveDeployer(address(vault));
        lp.setCurveDeployer(address(deployer));
        fwd = new DisciplePermitForwarder{salt: FORWARDER_SALT}();
        vm.stopBroadcast();

        require(anon.owner() == v6.owner() && address(anon.launchpad()) == address(lp), "anon config");
        require(vault.anonLauncher() == address(anon), "vault anon");
        console2.log("AnonLauncher (modes)", address(anon));
        console2.log("CurveFeeVault", address(vault));
        console2.log("CurveDeployer", address(deployer));
        console2.log("DisciplePermitForwarder v2", address(fwd));
        console2.log("previous AnonLauncher (keep for claims)", address(v6));
    }
}
