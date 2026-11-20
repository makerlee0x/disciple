// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {BondingCurve} from "./BondingCurve.sol";
import {CurveMath} from "./libraries/CurveMath.sol";

interface ICurveDeployerLaunchpad {
    function feeRouter() external view returns (address);
    function migration() external view returns (address);
}

/// @title Deploys BondingCurve instances for one Launchpad (maker 2026-11-20: clones)
/// @notice The constructor deploys one BondingCurve implementation wired to this Launchpad's FeeRouter, Migration and
///         `feeVault`. Every launch gets an EIP-1167 clone of it (about 45 bytes) set up by `initialize` in the same
///         call, so a launch no longer pays to deploy the full curve code. Only the Launchpad may deploy.
///         Swapping the curve code for new coins = deploy a new CurveDeployer and `Launchpad.setCurveDeployer`.
contract CurveDeployer {
    address public immutable launchpad;
    address public immutable feeVault;
    address public immutable implementation;

    error OnlyLaunchpad();
    error WrongWiring();

    constructor(address feeVault_, address launchpad_) {
        require(feeVault_.code.length != 0, "CurveDeployer: feeVault"); // audit 2026-11-18 B-L3
        require(launchpad_.code.length != 0, "CurveDeployer: launchpad");
        feeVault = feeVault_;
        launchpad = launchpad_;
        ICurveDeployerLaunchpad lp = ICurveDeployerLaunchpad(launchpad_);
        implementation = address(new BondingCurve(launchpad_, lp.feeRouter(), lp.migration(), feeVault_));
    }

    /// @dev Same arguments as before the clone switch; `feeRouter` and `migration` must match the implementation.
    function deploy(
        address token,
        address quote,
        address creator,
        address feeRouter,
        address migration,
        uint256 creatorTaxBps,
        CurveMath.Params calldata params,
        uint256 walletCapBps,
        uint8 mode,
        address trustedRouter,
        uint256 crewTipThresholdBps,
        uint256 snipeEscrowTimeout
    ) external returns (address curve) {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        BondingCurve impl = BondingCurve(implementation);
        if (feeRouter != address(impl.feeRouter()) || migration != address(impl.migration())) revert WrongWiring();
        curve = Clones.clone(address(impl));
        BondingCurve(curve).initialize(
            token,
            quote,
            creator,
            creatorTaxBps,
            params,
            walletCapBps,
            mode,
            trustedRouter,
            crewTipThresholdBps,
            snipeEscrowTimeout
        );
    }
}
