// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {CurveMath} from "../../src/libraries/CurveMath.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/// @notice Auditor delta-2 part 3/4 fixes: D2-L4 (self-made clones can't be initialized), D2-L6 (no lock with the
///         curve deployer unset), D2-I2 (creator share never pays address(0)).
contract AuditDelta2Part3 is IntegrationBase {
    address internal mallory = makeAddr("mallory");

    function test_D2_L4_selfMadeTokenClone_cannotInitialize() public {
        address impl = launchpad.tokenDeployer().implementation();
        Token t = Token(Clones.clone(impl));
        vm.prank(mallory);
        vm.expectRevert(Token.OnlyCloner.selector);
        t.initialize("Fake", "FAKE", mallory, mallory, false);
        assertEq(t.totalSupply(), 0);
    }

    function test_D2_L4_selfMadeCurveClone_cannotInitialize() public {
        (BondingCurve real, Token tok) = _launch(0, 0);
        address impl = launchpad.curveDeployer().implementation();
        BondingCurve c = BondingCurve(Clones.clone(impl));
        CurveMath.Params memory p;
        (p.totalSupply, p.sCurve, p.x0, p.y0) = real.curveParams();
        p.quotePriceUsd = real.quotePriceUsd();
        p.tail = real.curveTail();
        vm.prank(mallory);
        vm.expectRevert(BondingCurve.BadParams.selector);
        c.initialize(address(tok), address(quote), mallory, 0, p, 0, 0, address(0), 50, 0);
        assertEq(c.token(), address(0));
    }

    function test_D2_L6_lockCurveDeployer_requiresDeployer() public {
        // test-only: clear the stored curve deployer (slot found by value) to model a fresh Launchpad
        bytes32 slot;
        address cd = address(launchpad.curveDeployer());
        for (uint256 i; i < 64; ++i) {
            if (vm.load(address(launchpad), bytes32(i)) == bytes32(uint256(uint160(cd)))) {
                slot = bytes32(i);
                break;
            }
        }
        vm.store(address(launchpad), slot, bytes32(0));
        assertEq(address(launchpad.curveDeployer()), address(0));
        vm.prank(owner);
        vm.expectRevert(Launchpad.CurveDeployerUnset.selector);
        launchpad.lockCurveDeployer();
        assertFalse(launchpad.curveDeployerLocked());
    }
}
