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

/// @notice Redeploy pack (lee 11:17 CT): owner-settable Launchpad.maxMode (default Hard, bounds [Hard, 15]).
contract MaxModeTest is IntegrationBase {
    event MaxModeSet(uint8 mode);

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

    function test_default_isHard() public view {
        assertEq(launchpad.maxMode(), Constants.MODE_PVP);
    }

    function test_mode3_rejectedByDefault() public {
        ILaunchpad.LaunchParams memory p = _params();
        vm.prank(creator);
        vm.expectRevert(Launchpad.BadMode.selector);
        launchpad.launchWithMode(p, 3);
    }

    function test_hardStillLaunchesByDefault() public {
        ILaunchpad.LaunchParams memory p = _params();
        vm.prank(creator);
        ILaunchpad.LaunchResult memory r = launchpad.launchWithMode(p, Constants.MODE_PVP);
        assertEq(launchpad.modeOf(r.token), Constants.MODE_PVP);
    }

    function test_setMaxMode3_currentCurveStillRevertsSafely() public {
        vm.prank(owner);
        launchpad.setMaxMode(3);
        uint256 before = launchpad.launchCount();
        ILaunchpad.LaunchParams memory p = _params();
        vm.prank(creator);
        vm.expectRevert(BondingCurve.BadParams.selector); // BondingCurve ctor: mode_ > MODE_PVP
        launchpad.launchWithMode(p, 3);
        assertEq(launchpad.launchCount(), before);
        vm.prank(creator);
        vm.expectRevert(Launchpad.BadMode.selector); // still bounded by maxMode
        launchpad.launchWithMode(p, 4);
    }

    function test_mode3_launchesWithFutureDeployer() public {
        vm.startPrank(owner);
        launchpad.setMaxMode(3);
        launchpad.setCurveDeployer(address(new MockFutureCurveDeployer()));
        vm.stopPrank();
        ILaunchpad.LaunchParams memory p = _params();
        vm.prank(creator);
        ILaunchpad.LaunchResult memory r = launchpad.launchWithMode(p, 3);
        assertEq(launchpad.modeOf(r.token), 3);
        assertEq(FutureCurve(r.curve).mode(), 3);
        assertEq(launchpad.curveOf(r.token), r.curve);
    }

    function test_trenchLaunchUnaffected() public {
        vm.prank(owner);
        launchpad.setMaxMode(15);
        (, address tok) = _launchTrench();
        assertEq(launchpad.modeOf(tok), Constants.MODE_TRENCH);
    }

    function _launchTrench() internal returns (address curve, address tok) {
        ILaunchpad.LaunchParams memory p = _params();
        vm.prank(creator);
        ILaunchpad.LaunchResult memory r = launchpad.launchCoin(p);
        return (r.curve, r.token);
    }

    function test_setMaxMode_onlyOwner() public {
        vm.prank(creator);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        launchpad.setMaxMode(3);
    }

    function test_setMaxMode_bounds() public {
        vm.startPrank(owner);
        vm.expectRevert(Launchpad.MaxModeOutOfBounds.selector);
        launchpad.setMaxMode(1);
        vm.expectRevert(Launchpad.MaxModeOutOfBounds.selector);
        launchpad.setMaxMode(0);
        vm.expectRevert(Launchpad.MaxModeOutOfBounds.selector);
        launchpad.setMaxMode(16);
        vm.expectEmit(address(launchpad));
        emit MaxModeSet(15);
        launchpad.setMaxMode(15);
        assertEq(launchpad.maxMode(), 15);
        launchpad.setMaxMode(2); // back to Hard
        assertEq(launchpad.maxMode(), 2);
        vm.stopPrank();
    }
}
