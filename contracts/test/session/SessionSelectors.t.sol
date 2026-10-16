// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DiscipleSessionPolicy} from "../../src/session/DiscipleSessionPolicy.sol";
import {DiscipleRouter} from "../../src/DiscipleRouter.sol";
import {TrampWallManager} from "../../src/TrampWallManager.sol";
import {AnonLauncher} from "../../src/addons/AnonLauncher.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";

contract SelectorHarness is DiscipleSessionPolicy {
    function sels() external pure returns (bytes4[9] memory s) {
        s = [ROUTER_BUY, ROUTER_SELL, TRAMP, WALL, CANCEL, LAUNCH, LAUNCH_COIN, ANON_LAUNCH, CURVE_BUY4];
    }
}

/// @notice Guards against drift between the policy's hard-coded selectors and the real DISCIPLE contracts.
contract SessionSelectorsTest is Test {
    function test_selectorsMatchDiscipleContracts() public {
        bytes4[9] memory s = new SelectorHarness().sels();
        assertEq(s[0], DiscipleRouter.buyExactIn.selector);
        assertEq(s[1], DiscipleRouter.sellExactIn.selector);
        assertEq(s[2], TrampWallManager.placeTramp.selector);
        assertEq(s[3], TrampWallManager.placeWall.selector);
        assertEq(s[4], TrampWallManager.cancel.selector);
        assertEq(s[5], ILaunchpad.launch.selector);
        assertEq(s[6], ILaunchpad.launchCoin.selector);
        assertEq(s[7], AnonLauncher.launchAnon.selector);
        assertEq(s[8], bytes4(keccak256("buy(uint256,uint256,uint256,address)")));
    }
}

/// @notice The TS helper's install data (sdk/session-keys test fixture) decodes and installs correctly.
contract SessionSdkFixtureTest is Test {
    function test_sdkInstallDataDecodes() public {
        vm.warp(1_800_000_000);
        DiscipleSessionPolicy p = new DiscipleSessionPolicy();
        p.onInstall(hex"0000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000006b4b23800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000027f00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000000");
        DiscipleSessionPolicy.Session memory s = p.sessionOf(address(this), 8);
        assertTrue(s.active);
        assertEq(s.cfg.validUntil, 1_800_086_400);
        assertEq(s.cfg.permissions, 0x27f);
        assertEq(s.cfg.router, address(1));
        assertEq(s.cfg.trampWallManager, address(4));
        assertEq(s.cfg.quote0, address(6));
        assertEq(s.cfg.cap0, 100);
    }
}
