// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./integration/IntegrationBase.sol";

/// @notice LOCKED #9 rev. 2026-10-15: anti-snipe tax 70% community RewardsVault / 30% treasury.
contract SnipeSplitTest is IntegrationBase {
    function testFuzz_exact_split_on_curve(uint256 qIn, uint8 dt) public {
        qIn = bound(qIn, 1 ether, 300 ether);
        uint256 wait = bound(uint256(dt), 0, 7);
        (BondingCurve curve, Token tok) = _launch(0, 0);
        vm.warp(block.timestamp + wait);
        uint256 bps = antiSnipe.currentFeeBps(address(tok));
        uint256 snipe = (qIn * bps) / 10_000;
        uint256 v0 = quote.balanceOf(address(rewardsVault));
        uint256 t0 = (quote.balanceOf(treasury) + feeRouter.treasuryAccrued(address(quote)));
        (,,,, uint256 e0,,) = lockedLP.positions(address(tok));
        _buy(curve, sniper, qIn, 0);
        (,,,, uint256 e1,,) = lockedLP.positions(address(tok));
        uint256 proto = FeeMath.protocolFee(qIn - snipe);
        (, uint256 lps, uint256 tsh, uint256 rsh) = FeeMath.splitTradeFee(proto);
        uint256 toRewards = (snipe * Constants.SNIPE_REWARDS_BPS) / Constants.BPS_DENOM;
        assertEq(quote.balanceOf(address(rewardsVault)) - v0, toRewards, "70%");
        assertEq((quote.balanceOf(treasury) + feeRouter.treasuryAccrued(address(quote))) - t0, (snipe - toRewards) + tsh + rsh, "30% + proto treasury");
        assertEq(e1 - e0, lps, "LP gets only proto LP share");
        assertEq(toRewards + (snipe - toRewards), snipe, "no dust lost");
    }

    function test_unset_vault_sends_all_snipe_to_treasury() public {
        vm.prank(owner);
        feeRouter.setRewardsVault(address(0));
        (BondingCurve curve, Token tok) = _launch(0, 0);
        uint256 t0 = (quote.balanceOf(treasury) + feeRouter.treasuryAccrued(address(quote)));
        _buy(curve, sniper, 50 ether, 0);
        uint256 snipe = (50 ether * antiSnipe.currentFeeBps(address(tok))) / 10_000;
        (,, uint256 tsh, uint256 rsh) = FeeMath.splitTradeFee(FeeMath.protocolFee(50 ether - snipe));
        assertEq((quote.balanceOf(treasury) + feeRouter.treasuryAccrued(address(quote))) - t0, snipe + tsh + rsh);
        assertEq(quote.balanceOf(address(rewardsVault)), 0);
    }

    function test_setRewardsVault_onlyOwner() public {
        vm.expectRevert(FeeRouter.OnlyOwner.selector);
        feeRouter.setRewardsVault(address(1));
    }

    function test_creator_launch_buy_is_exempt_no_snipe_to_vault() public {
        _launch(0, 10 ether);
        assertEq(quote.balanceOf(address(rewardsVault)), 0);
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
        uint256 bal = quote.balanceOf(address(rewardsVault));
        assertEq(rewardsVault.totalAccrued(address(quote)), bal);
        rewardsVault.notifyReward(address(0), address(quote), 1e30); // spoof ignored
        assertEq(rewardsVault.totalAccrued(address(quote)), bal);
        address[] memory to = new address[](1);
        to[0] = trader2;
        uint256[] memory amt = new uint256[](1);
        amt[0] = bal;
        vm.expectRevert(RewardsVault.OnlyOwner.selector);
        rewardsVault.distribute(address(quote), to, amt);
        uint256 b0 = quote.balanceOf(trader2);
        vm.prank(owner);
        rewardsVault.distribute(address(quote), to, amt);
        assertEq(quote.balanceOf(trader2) - b0, bal);
    }
}
