// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Token} from "../../src/Token.sol";
import {Constants} from "../../src/libraries/Constants.sol";

/// @dev Stand-in PVE curve: accepts transfer notifications, can lock the creator and end the hooks.
contract MockPveCurve {
    function onTokenTransfer(address, address, uint256) external {}
    function lock(Token t, uint256 a) external { t.lockCreator(a); }
    function graduate(Token t) external { t.endPveHooks(); }
}

/// @notice Redeploy pack item 5: Token.burn / burnFrom really reduce totalSupply; PVE coins burn only after graduation.
contract TokenBurnTest is Test {
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function _token(bool pve) internal returns (Token t) {
        t = new Token("Coin", "C", creator, address(this), address(this), pve);
    }

    function test_burn_dropsTotalSupply() public {
        Token t = _token(false);
        t.transfer(alice, 1000e18);
        vm.prank(alice);
        t.burn(400e18);
        assertEq(t.balanceOf(alice), 600e18);
        assertEq(t.totalSupply(), Constants.TOTAL_SUPPLY - 400e18);
    }

    function test_burn_moreThanBalance_reverts() public {
        Token t = _token(false);
        t.transfer(alice, 10e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 10e18, 11e18));
        t.burn(11e18);
    }

    function test_burnFrom_usesAllowance() public {
        Token t = _token(false);
        t.transfer(alice, 1000e18);
        vm.prank(alice);
        t.approve(bob, 300e18);
        vm.prank(bob);
        t.burnFrom(alice, 300e18);
        assertEq(t.balanceOf(alice), 700e18);
        assertEq(t.allowance(alice, bob), 0);
        assertEq(t.totalSupply(), Constants.TOTAL_SUPPLY - 300e18);
    }

    function test_burnFrom_withoutAllowance_reverts() public {
        Token t = _token(false);
        t.transfer(alice, 1000e18);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, bob, 0, 1));
        t.burnFrom(alice, 1);
    }

    function test_pve_burnLockedUntilGraduation() public {
        Token t = _token(true);
        MockPveCurve c = new MockPveCurve();
        t.setPveCurve(address(c));
        t.transfer(alice, 1000e18);
        vm.prank(alice);
        vm.expectRevert(Token.BurnLocked.selector);
        t.burn(1e18);
        // approved burnFrom is blocked the same way
        vm.prank(alice);
        t.approve(bob, 1e18);
        vm.prank(bob);
        vm.expectRevert(Token.BurnLocked.selector);
        t.burnFrom(alice, 1e18);

        c.graduate(t);
        vm.prank(alice);
        t.burn(1e18);
        assertEq(t.totalSupply(), Constants.TOTAL_SUPPLY - 1e18);
    }

    function test_trench_burnAnytime_creatorToo() public {
        Token t = _token(false);
        t.transfer(creator, 5e18);
        vm.prank(creator);
        t.burn(5e18);
        assertEq(t.balanceOf(creator), 0);
    }

    function testFuzz_burn(uint256 give, uint256 amt) public {
        Token t = _token(false);
        give = bound(give, 0, Constants.TOTAL_SUPPLY);
        amt = bound(amt, 0, give);
        t.transfer(alice, give);
        vm.prank(alice);
        t.burn(amt);
        assertEq(t.totalSupply(), Constants.TOTAL_SUPPLY - amt);
        assertEq(t.balanceOf(alice), give - amt);
    }
}
