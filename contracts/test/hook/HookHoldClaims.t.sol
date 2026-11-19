// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {DiscipleHook} from "../../src/DiscipleHook.sol";
import {LockedLP} from "../../src/LockedLP.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {Constants} from "../../src/libraries/Constants.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice maker 2026-11-19: the hook keeps the 1% (as its PoolManager balance) and splits it 33/33/33/1 only when
///         someone claims. Claims are public and always pay the fixed recipient.
contract HookHoldClaimsTest is IntegrationBase {
    address internal constant COMMUNITY = address(0xC0FFEE0001); // V4Deploy.COMMUNITY
    address internal bot = makeAddr("bot");

    BondingCurve internal c;
    Token internal tok;
    bool internal tokenIsC0;

    function setUp() public override {
        super.setUp();
        (c, tok) = _launch(0, 0);
        _graduate(c);
        tokenIsC0 = uint160(address(tok)) < uint160(address(quote));
    }

    function _fees() internal view returns (uint256 q, uint256 t) {
        (uint128 a0, uint128 a1) = hook.feesOf(hook.poolOf(address(tok)));
        (q, t) = tokenIsC0 ? (uint256(a1), uint256(a0)) : (uint256(a0), uint256(a1));
    }

    function _bal6909(address asset) internal view returns (uint256) {
        return manager.balanceOf(address(hook), Currency.wrap(asset).toId());
    }

    function _trade() internal {
        _swapExactInQuoteForToken(tok, trader1, 200 * U); // buy: fee in the rocket token
        _swapExactInTokenForQuote(tok, trader1, tok.balanceOf(trader1) / 2); // sell: fee in quote
    }

    // ── swap path ───────────────────────────────────────────────────────

    function test_swap_onlyBooksPending_noOutsideCalls() public {
        uint256 frQ = quote.balanceOf(address(feeRouter));
        uint256 frT = tok.balanceOf(address(feeRouter));
        (uint256 bkT,) = lockedLP.compoundBucket(address(tok));
        // nothing but the PoolManager may be called from inside a swap
        vm.expectCall(address(feeRouter), "", 0);
        // (the test helper reads lockedLP.getPoolKey outside the swap; no credit / flush / add may happen)
        vm.expectCall(address(lockedLP), abi.encodeWithSelector(LockedLP.creditLockedLiquidity.selector), 0);
        vm.expectCall(address(lockedLP), abi.encodeWithSelector(LockedLP.flush.selector), 0);
        vm.expectCall(address(launchpad), "", 0);
        vm.expectCall(address(referrals), "", 0);
        vm.expectCall(address(harvest), "", 0);
        vm.expectCall(address(migration), "", 0);
        _trade();
        (uint256 q, uint256 t) = _fees();
        assertGt(q, 0, "quote fee pending");
        assertGt(t, 0, "token fee pending");
        assertEq(_bal6909(address(quote)), q, "held as PoolManager balance");
        assertEq(_bal6909(address(tok)), t);
        assertEq(quote.balanceOf(address(hook)) + tok.balanceOf(address(hook)), 0, "no ERC-20 in the hook");
        assertEq(quote.balanceOf(address(feeRouter)), frQ, "FeeRouter untouched");
        assertEq(tok.balanceOf(address(feeRouter)), frT);
        (uint256 bkT2,) = lockedLP.compoundBucket(address(tok));
        assertEq(bkT2, bkT, "LockedLP untouched");
    }

    function test_swap_feeIsOnePercentOfOutput() public {
        uint256 b0 = tok.balanceOf(trader1);
        _swapExactInQuoteForToken(tok, trader1, 200 * U);
        uint256 got = tok.balanceOf(trader1) - b0;
        (, uint256 t) = _fees();
        // got = out - fee, fee = out * 1% (rounded down)
        assertApproxEqAbs(t, (got + t) * Constants.TRADE_FEE_BPS / Constants.BPS_DENOM, 1);
    }

    // ── claims ──────────────────────────────────────────────────────────

    function test_eachClaim_paysFixedRecipient_anyCaller() public {
        _trade();
        (uint256 q, uint256 t) = _fees();
        uint256 cq = quote.balanceOf(creator);
        uint256 ct = tok.balanceOf(creator);
        uint256 tq = quote.balanceOf(treasury);
        uint256 tt = tok.balanceOf(treasury);
        (uint256 bT, uint256 bQ) = lockedLP.compoundBucket(address(tok));
        uint256 botQ = quote.balanceOf(bot);
        uint256 botT = tok.balanceOf(bot);

        vm.startPrank(bot);
        hook.claimCreatorFees(address(tok));
        hook.claimLockedLiquidityFees(address(tok));
        hook.claimTreasuryFees(address(tok));
        hook.claimCommunityFees(address(tok));
        vm.stopPrank();

        assertEq(quote.balanceOf(creator) - cq, q * 33 / 100, "creator quote");
        assertEq(tok.balanceOf(creator) - ct, t * 33 / 100, "creator token");
        assertEq(quote.balanceOf(treasury) - tq, q * 33 / 100, "treasury quote");
        assertEq(tok.balanceOf(treasury) - tt, t * 33 / 100, "treasury token");
        assertEq(quote.balanceOf(COMMUNITY), q / 100, "community quote");
        assertEq(tok.balanceOf(COMMUNITY), t / 100, "community token");
        (uint256 bT2, uint256 bQ2) = lockedLP.compoundBucket(address(tok));
        assertEq(bT2 - bT, t * 33 / 100, "LP token bucket");
        assertEq(bQ2 - bQ, q * 33 / 100, "LP quote bucket");
        assertEq(quote.balanceOf(bot), botQ, "caller paid nothing");
        assertEq(tok.balanceOf(bot), botT);
        // what is left is only per-share rounding dust (<= 3 wei per currency)
        assertLe(_bal6909(address(quote)), 3);
        assertLe(_bal6909(address(tok)), 3);
    }

    function test_noDoublePay() public {
        _trade();
        hook.claimCreatorFees(address(tok));
        vm.expectRevert(DiscipleHook.NothingToClaim.selector);
        hook.claimCreatorFees(address(tok));
        hook.claimTreasuryFees(address(tok));
        vm.expectRevert(DiscipleHook.NothingToClaim.selector);
        hook.claimTreasuryFees(address(tok));
        // claimAll skips the empty shares and pays only the remaining two once
        address[] memory list = new address[](1);
        list[0] = address(tok);
        hook.claimAll(list);
        hook.claimAll(list); // no-op, no revert
        for (uint8 s; s < 4; ++s) {
            (uint256 cq, uint256 ct) = hook.claimable(address(tok), s);
            assertEq(cq + ct, 0, "all shares paid");
        }
        // later fees are owed again, only the new part
        (uint256 q0,) = _fees();
        _swapExactInTokenForQuote(tok, trader1, tok.balanceOf(trader1) / 2);
        (uint256 q1,) = _fees();
        (uint256 owed,) = hook.claimable(address(tok), 0);
        assertApproxEqAbs(owed, (q1 - q0) * 33 / 100, 1);
    }

    function test_interleavedClaims_neverOverpay(uint8 rounds, uint256 seed) public {
        rounds = uint8(bound(rounds, 1, 12));
        address[] memory list = new address[](1);
        list[0] = address(tok);
        for (uint256 i; i < rounds; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            _swapExactInQuoteForToken(tok, trader1, (seed % 300 + 1) * U / 7);
            _swapExactInTokenForQuote(tok, trader1, tok.balanceOf(trader1) / (2 + seed % 5));
            uint8 s = uint8(seed % 4);
            (uint256 cq, uint256 ct) = hook.claimable(address(tok), s);
            if (cq + ct == 0) continue;
            if (s == 0) hook.claimCreatorFees(address(tok));
            else if (s == 1) hook.claimLockedLiquidityFees(address(tok));
            else if (s == 2) hook.claimTreasuryFees(address(tok));
            else hook.claimCommunityFees(address(tok));
        }
        // solvency: everything still owed is backed by the hook's PoolManager balance
        uint256 owedQ;
        uint256 owedT;
        for (uint8 s; s < 4; ++s) {
            (uint256 cq, uint256 ct) = hook.claimable(address(tok), s);
            owedQ += cq;
            owedT += ct;
        }
        assertLe(owedQ, _bal6909(address(quote)));
        assertLe(owedT, _bal6909(address(tok)));
        hook.claimAll(list);
        assertLe(_bal6909(address(quote)), 3);
        assertLe(_bal6909(address(tok)), 3);
    }

    function test_creatorHandover_paysCurrentCreator() public {
        address next = makeAddr("next");
        address third = makeAddr("third");
        _trade();
        vm.prank(creator);
        launchpad.transferCreator(address(tok), next);
        vm.prank(next);
        launchpad.transferCreator(address(tok), third); // any number of times, no fee
        (uint256 q, uint256 t) = hook.claimable(address(tok), 0);
        hook.claimCreatorFees(address(tok));
        assertEq(quote.balanceOf(third), q);
        assertEq(tok.balanceOf(third), t);
        assertEq(hook.creatorQuotePaidTo(address(tok), third), q);
    }

    function test_creatorShare_lockedDestination_goesToLockedLP() public {
        vm.mockCall(address(harvest), abi.encodeWithSignature("creatorFeeDestinationOf(address)", address(tok)), abi.encode(uint8(1)));
        _trade();
        (uint256 q, uint256 t) = hook.claimable(address(tok), 0);
        (uint256 bT, uint256 bQ) = lockedLP.compoundBucket(address(tok));
        uint256 cq = quote.balanceOf(creator);
        hook.claimCreatorFees(address(tok));
        (uint256 bT2, uint256 bQ2) = lockedLP.compoundBucket(address(tok));
        assertEq(bT2 - bT, t);
        assertEq(bQ2 - bQ, q);
        assertEq(quote.balanceOf(creator), cq, "creator not paid on a locked coin");
    }

    function test_creatorShare_burnDestination_goesToDead() public {
        vm.mockCall(address(harvest), abi.encodeWithSignature("creatorFeeDestinationOf(address)", address(tok)), abi.encode(uint8(2)));
        _trade();
        (uint256 q, uint256 t) = hook.claimable(address(tok), 0);
        address dead = hook.BURN();
        uint256 dq = quote.balanceOf(dead);
        uint256 dt = tok.balanceOf(dead);
        hook.claimCreatorFees(address(tok));
        assertEq(quote.balanceOf(dead) - dq, q);
        assertEq(tok.balanceOf(dead) - dt, t);
    }

    function test_unknownToken_reverts() public {
        vm.expectRevert(DiscipleHook.NotRegistered.selector);
        hook.claimTreasuryFees(address(0xBEEF));
        (uint256 q, uint256 t) = hook.claimable(address(0xBEEF), 2);
        assertEq(q + t, 0);
    }

    function test_recipientsFixed_noAdminLeft() public {
        assertEq(hook.treasury(), feeRouter.treasury());
        assertEq(hook.communitySafe(), COMMUNITY);
        vm.prank(hook.admin());
        hook.renounceAdmin();
        vm.expectRevert(DiscipleHook.OnlyAdmin.selector);
        hook.setCreatorFeeHarvest(address(feeRouter));
        vm.expectRevert(DiscipleHook.OnlyAdmin.selector);
        hook.setMigration(address(feeRouter));
    }

    function test_unlockCallback_onlyPoolManager() public {
        vm.expectRevert(DiscipleHook.OnlyPoolManager.selector);
        hook.unlockCallback(abi.encode(address(quote), address(tok), bot, uint256(1), uint256(1)));
    }

    function test_lockedLP_hookSlotWriteOnce() public {
        assertEq(lockedLP.hook(), address(hook));
        vm.prank(owner);
        vm.expectRevert(LockedLP.AlreadyWired.selector);
        lockedLP.setHook(address(feeRouter));
        // only FeeRouter / the hook may credit
        vm.prank(bot);
        vm.expectRevert(LockedLP.Unauthorized.selector);
        lockedLP.creditLockedLiquidity(address(tok), address(quote), 1, 1);
    }

    function test_feeRouter_ownerCannotAuthorize() public {
        vm.prank(owner);
        vm.expectRevert();
        feeRouter.setAuthorized(address(bot), true);
        assertFalse(feeRouter.authorizedCallers(address(hook)));
    }
}
