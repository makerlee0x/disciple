// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {Owned2Step} from "../../src/utils/Owned2Step.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {CurveMath} from "../../src/libraries/CurveMath.sol";
import {Constants} from "../../src/libraries/Constants.sol";

contract FutureCurve {
    uint8 public mode;

    constructor(uint8 m) {
        mode = m;
    }
}

/// @dev CurveDeployer stand-in for a future mode-aware curve: same deploy() ABI, accepts any mode.
contract MockFutureCurveDeployer {
    function deploy(
        address,
        address,
        address,
        address,
        address,
        uint256,
        CurveMath.Params calldata,
        uint256,
        uint8 mode,
        address,
        address,
        uint256,
        uint256
    ) external returns (address) {
        return address(new FutureCurve(mode));
    }
}

/// @notice Launch modes are fixed to TRENCH / PVE / PVP (the setMaxMode knob was dead config, audit I-17), and the
///         curve deployer is write-once (audit 2026-11-17 R461-01).
contract MaxModeTest is IntegrationBase {
    function _params() internal view returns (ILaunchpad.LaunchParams memory) {
        return ILaunchpad.LaunchParams({
            name: "Mode3",
            ticker: "M3",
            imageURI: "ipfs://img",
            description: "",
            socialsURI: "",
            quote: address(quote),
            creatorTaxBps: 0,
            creatorBuyQuoteIn: 0,
            creatorBuyMinTokensOut: 0,
            deadline: vm.getBlockTimestamp() + 1 days
        });
    }

    function test_mode3_rejected() public {
        ILaunchpad.LaunchParams memory p = _params();
        vm.prank(creator);
        vm.expectRevert(Launchpad.BadMode.selector);
        launchpad.launchWithMode(p, 3);
    }

    function test_hardStillLaunches() public {
        ILaunchpad.LaunchParams memory p = _params();
        vm.prank(creator);
        ILaunchpad.LaunchResult memory r = launchpad.launchWithMode(p, Constants.MODE_PVP);
        assertEq(launchpad.modeOf(r.token), Constants.MODE_PVP);
    }

    /// @dev maker 2026-11-19: the Team may swap the curve code for new coins until lockCurveDeployer.
    function test_curveDeployer_swappable_thenLocked() public {
        address d = address(new MockFutureCurveDeployer());
        vm.prank(creator);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        launchpad.setCurveDeployer(d);
        vm.startPrank(owner);
        launchpad.setCurveDeployer(d);
        assertEq(address(launchpad.curveDeployer()), d);
        launchpad.lockCurveDeployer();
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        launchpad.setCurveDeployer(d);
        vm.stopPrank();
    }

    function test_curveDeployer_rejectsEoa() public {
        vm.store(address(launchpad), bytes32(uint256(5)), bytes32(0)); // test-only: pretend unset
        vm.prank(owner);
        vm.expectRevert(Launchpad.CurveDeployerUnset.selector);
        launchpad.setCurveDeployer(makeAddr("eoa"));
    }
}
