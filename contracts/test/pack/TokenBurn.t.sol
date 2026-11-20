// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Token} from "../../src/Token.sol";
import {Constants} from "../../src/libraries/Constants.sol";

/// @dev Stand-in PVE curve: accepts transfer notifications, can lock the creator and end the hooks.
contract MockPveCurve {
    address public lastFrom;
    address public lastTo;
    uint256 public lastAmt;

    function onTokenTransfer(address f, address t, uint256 a) external {
        (lastFrom, lastTo, lastAmt) = (f, t, a);
    }
    function lock(Token t, uint256 a) external { t.lockCreator(a); }
    function graduate(Token t) external { t.endPveHooks(); }
}

/// @notice Redeploy pack item 5: Token.burn / burnFrom really reduce totalSupply; PVE coins burn any time too (2026-11-19).
contract TokenBurnTest is Test {
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function _token(bool pve) internal returns (Token t) {
        Token impl = new Token(address(this), address(0), address(0));
        t = Token(Clones.clone(address(impl)));
        t.initialize("Coin", "C", creator, address(this), pve);
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

    /// maker 2026-11-19: Easy coins can be burned any time; the curve books the burn as a send to 0x…dEaD.
    function test_pve_burnAnytime_booksDead() public {
        Token t = _token(true);
        MockPveCurve c = new MockPveCurve();
        t.setPveCurve(address(c));
        t.transfer(alice, 1000e18);
        vm.prank(alice);
        t.burn(1e18);
        assertEq(t.totalSupply(), Constants.TOTAL_SUPPLY - 1e18);
        assertEq(c.lastFrom(), alice);
        assertEq(c.lastTo(), 0x000000000000000000000000000000000000dEaD);
        assertEq(c.lastAmt(), 1e18);
        vm.prank(alice);
        t.approve(bob, 1e18);
        vm.prank(bob);
        t.burnFrom(alice, 1e18);
        assertEq(t.totalSupply(), Constants.TOTAL_SUPPLY - 2e18);
    }

    /// The Easy creator's locked First BOOST still can't be burned before graduation; anything above it can.
    function test_pve_creatorBurnKeepsLock() public {
        Token t = _token(true);
        MockPveCurve c = new MockPveCurve();
        t.setPveCurve(address(c));
        t.transfer(creator, 1000e18);
        c.lock(t, 500e18);
        vm.prank(creator);
        t.burn(500e18);
        vm.prank(creator);
        vm.expectRevert(Token.CreatorLocked.selector);
        t.burn(1);
    }

    /// Audit delta T2-I1: burnFrom by an approved spender hits the same creator lock.
    function test_pve_creatorBurnFromKeepsLock() public {
        Token t = _token(true);
        MockPveCurve c = new MockPveCurve();
        t.setPveCurve(address(c));
        t.transfer(creator, 1000e18);
        c.lock(t, 500e18);
        address spender = makeAddr("spender");
        vm.prank(creator);
        t.approve(spender, type(uint256).max);
        vm.prank(spender);
        t.burnFrom(creator, 500e18);
        vm.prank(spender);
        vm.expectRevert(Token.CreatorLocked.selector);
        t.burnFrom(creator, 1);
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
