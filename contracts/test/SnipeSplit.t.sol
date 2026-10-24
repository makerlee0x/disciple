// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./integration/IntegrationBase.sol";
import {Owned2Step} from "../src/utils/Owned2Step.sol";
import {Vm} from "forge-std/Vm.sol";

/// @notice Sniper tax (mode rules v2, replaces LOCKED #9 rev. 2026-10-15's 70/30 split): 99% → 0 over 60 s, held in
///         the curve's `snipeEscrow` in the pair coin (outside reserves / price), added to the locked LP at
///         graduation, or — if not graduated SNIPE_ESCROW_TIMEOUT (30 days) after launch — releasable by anyone to
///         the RewardsVault.
contract SnipeSplitTest is IntegrationBase {
    event SnipeEscrowToLP(address indexed token, uint256 amount);
    event SnipeEscrowReleased(address indexed token, address indexed vault, uint256 amount);

    function testFuzz_exact_escrow_on_curve(uint256 qIn, uint8 dt) public {
        qIn = bound(qIn, 1 ether, 300 ether);
        uint256 wait = bound(uint256(dt), 0, 70);
        (BondingCurve curve, Token tok) = _launch(0, 0);
        vm.warp(block.timestamp + wait);
        uint256 bps = curve.currentSnipeFeeBps();
        assertEq(bps, wait >= 60 ? 0 : 9900 - 9900 * wait / 60, "linear decay");
        uint256 snipe = (qIn * bps) / 10_000;
        uint256 t0 = (quote.balanceOf(treasury) + feeRouter.treasuryAccrued(address(quote)));
        (,,,, uint256 e0,,) = lockedLP.positions(address(tok));
        BondingCurve.BuyQuote memory q = curve.quoteBuy(qIn);
        _buy(curve, sniper, qIn, 0);
        (,,,, uint256 e1,,) = lockedLP.positions(address(tok));
        uint256 proto = FeeMath.protocolFee(qIn - snipe);
        (, uint256 lps, uint256 tsh, uint256 rsh) = FeeMath.splitTradeFee(proto);
        assertEq(q.snipeFee, snipe, "quote == executed");
        assertEq(curve.snipeEscrow(), snipe, "all of it escrowed");
        assertEq(quote.balanceOf(address(rewardsVault)), 0, "nothing to the vault on buys");
        assertEq((quote.balanceOf(treasury) + feeRouter.treasuryAccrued(address(quote))) - t0, tsh + rsh, "proto only");
        assertEq(e1 - e0, lps, "LP gets only proto LP share");
        assertEq(quote.balanceOf(address(curve)), curve.quoteReserve() + snipe, "escrow outside the reserve");
    }

    function test_escrow_excluded_from_price() public {
        (BondingCurve a,) = _launch(0, 0);
        (BondingCurve b,) = _launch(0, 0);
        // same effective curve input, one paid through the sniper tax
        uint256 bps = a.currentSnipeFeeBps();
        uint256 big = 100 ether;
        uint256 afterSnipe = big - big * bps / 10_000;
        _buy(a, sniper, big, 0);
        _warpPastSnipe();
        _buy(b, trader1, afterSnipe, 0);
        assertEq(a.tokensSold(), b.tokensSold(), "escrow never moves the curve");
        assertEq(a.spotPriceWad(), b.spotPriceWad());
        assertEq(a.quoteReserve(), b.quoteReserve());
    }

    function test_unset_vault_release_reverts() public {
        (BondingCurve curve,) = _launch(0, 0);
        _buy(curve, sniper, 50 ether, 0);
        vm.prank(owner);
        feeRouter.setRewardsVault(address(0));
        vm.warp(curve.launchTime() + Constants.SNIPE_ESCROW_TIMEOUT);
        vm.expectRevert(BondingCurve.ZeroRecipient.selector);
        curve.releaseSnipeEscrow();
    }

    function test_setRewardsVault_onlyOwner() public {
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        feeRouter.setRewardsVault(address(1));
    }

    function test_creator_launch_buy_is_exempt() public {
        (BondingCurve curve,) = _launch(0, 10 ether);
        assertEq(curve.snipeEscrow(), 0);
        assertEq(quote.balanceOf(address(rewardsVault)), 0);
    }

    function test_escrow_to_locked_lp_at_graduation() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _buy(curve, sniper, 200 ether, 0);
        uint256 esc = curve.snipeEscrow();
        assertGt(esc, 0);
        vm.recordLogs();
        _graduate(curve);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(curve) && logs[i].topics[0] == SnipeEscrowToLP.selector) {
                assertEq(logs[i].topics[1], bytes32(uint256(uint160(address(tok)))));
                assertEq(abi.decode(logs[i].data, (uint256)), esc, "escrow amount into the LP");
                seen = true;
            }
        }
        assertTrue(seen, "SnipeEscrowToLP");
        assertEq(curve.snipeEscrow(), 0, "cleared");
        assertEq(quote.balanceOf(address(curve)), curve.rewardsHeld(), "nothing left on the curve");
        assertEq(quote.balanceOf(address(rewardsVault)), 0);
        vm.warp(curve.launchTime() + Constants.SNIPE_ESCROW_TIMEOUT + 1);
        vm.expectRevert(BondingCurve.Graduated.selector);
        curve.releaseSnipeEscrow();
    }

    function test_escrow_to_vault_after_timeout_not_before() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _buy(curve, sniper, 20 ether, 0);
        uint256 esc = curve.snipeEscrow();
        vm.warp(curve.launchTime() + Constants.SNIPE_ESCROW_TIMEOUT - 1);
        vm.expectRevert(BondingCurve.EscrowLocked.selector);
        curve.releaseSnipeEscrow();
        vm.warp(curve.launchTime() + Constants.SNIPE_ESCROW_TIMEOUT);
        vm.expectEmit(true, true, false, true, address(curve));
        emit SnipeEscrowReleased(address(tok), address(rewardsVault), esc);
        vm.prank(makeAddr("anyone"));
        assertEq(curve.releaseSnipeEscrow(), esc);
        assertEq(quote.balanceOf(address(rewardsVault)), esc);
        assertEq(curve.snipeEscrow(), 0);
        assertEq(quote.balanceOf(address(curve)), curve.quoteReserve(), "reserve untouched");
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        curve.releaseSnipeEscrow();
        // trading still works; the curve can still graduate afterwards
        _graduate(curve);
    }

    function test_post_grad_no_snipe_path() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _graduate(curve);
        uint256 v0 = quote.balanceOf(address(rewardsVault));
        _swapExactInQuoteForToken(tok, trader1, 1_000 ether);
        _swapExactInTokenForQuote(tok, trader1, tok.balanceOf(trader1) / 2);
        assertEq(quote.balanceOf(address(rewardsVault)), v0, "hook never routes snipe");
        assertEq(tok.balanceOf(address(rewardsVault)), 0);
    }

    function test_vault_accounting_spoof_and_distribute() public {
        (BondingCurve curve,) = _launch(0, 0);
        _buy(curve, sniper, 20 ether, 0);
        vm.warp(curve.launchTime() + Constants.SNIPE_ESCROW_TIMEOUT);
        curve.releaseSnipeEscrow();
        uint256 bal = quote.balanceOf(address(rewardsVault));
        assertGt(bal, 0);
        assertEq(rewardsVault.totalAccrued(address(quote)), 0, "plain transfer (no notify)");
        rewardsVault.notifyReward(address(0), address(quote), 1e30); // spoof ignored
        assertEq(rewardsVault.totalAccrued(address(quote)), 0);
        address[] memory to = new address[](1);
        to[0] = trader2;
        uint256[] memory amt = new uint256[](1);
        amt[0] = bal;
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        rewardsVault.distribute(address(quote), to, amt);
        uint256 b0 = quote.balanceOf(trader2);
        vm.prank(owner);
        rewardsVault.distribute(address(quote), to, amt);
        assertEq(quote.balanceOf(trader2) - b0, bal);
    }
}
