// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./integration/IntegrationBase.sol";
import {AnonLauncher} from "../src/addons/AnonLauncher.sol";
import {DiscipleRouter} from "../src/DiscipleRouter.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev Fee token that re-enters AnonLauncher.launchAnonWithUsdg on the launch-fee transfer.
contract ReenteringFeeToken is MockUSDG {
    AnonLauncher public target;
    bool public attack;

    function arm(AnonLauncher t) external {
        target = t;
        attack = true;
    }

    function transferFrom(address from, address to, uint256 amt) public override returns (bool) {
        require(super.transferFrom(from, to, amt));
        if (attack && address(target) != address(0)) {
            attack = false;
            ILaunchpad.LaunchParams memory p = ILaunchpad.LaunchParams({
                name: "Re",
                ticker: "RE",
                imageURI: "ipfs://x",
                description: "",
                socialsURI: "",
                quote: address(0),
                creatorTaxBps: 0,
                creatorBuyQuoteIn: 0,
                creatorBuyMinTokensOut: 0,
                deadline: block.timestamp + 1 hours,
                creatorFeeDestination: 0
            });
            target.launchAnonWithUsdg(p, address(1), address(1), "", 0x00, type(uint256).max, 0, 0, address(0));
        }
        return true;
    }
}

/// @notice Private-launch First BOOST paid in USDG through DiscipleRouter.launchWithUsdg.
contract AnonLauncherFirstBuyTest is IntegrationBase {
    AnonLauncher internal anon;
    address internal payer = makeAddr("payer");
    uint256 internal skA;
    address internal stealthA;
    uint256 internal skB;
    address internal stealthB;
    uint256 constant FEE = 0.5 ether;

    function setUp() public override {
        super.setUp();
        anon =
            new AnonLauncher(owner, address(launchpad), address(feeRouter), address(quote), treasury, address(0), FEE);
        (stealthA, skA) = makeAddrAndKey("stealthA");
        (stealthB, skB) = makeAddrAndKey("stealthB");
        quote.mint(payer, 1_000_000 ether);
        vm.prank(payer);
        quote.approve(address(anon), type(uint256).max);
        router.setUsdgRouting(address(quote), address(launchpad));
        router.setUsdgPool(address(strategy), strategyUsdgKey);
    }

    function _paramsQ(address q, uint256 minOut, uint256 deadline)
        internal
        view
        returns (ILaunchpad.LaunchParams memory)
    {
        return ILaunchpad.LaunchParams({
            name: "Anon",
            ticker: "ANON",
            imageURI: "ipfs://x",
            description: "",
            socialsURI: "",
            quote: q,
            creatorTaxBps: 0,
            creatorBuyQuoteIn: 0,
            creatorBuyMinTokensOut: minOut,
            deadline: deadline,
            creatorFeeDestination: 0
        });
    }

    function _paramsLegacy(uint256 buy) internal view returns (ILaunchpad.LaunchParams memory) {
        ILaunchpad.LaunchParams memory p = _paramsQ(address(quote), 0, block.timestamp + 1 hours);
        p.creatorBuyQuoteIn = buy;
        return p;
    }

    function _launchUsdg(address stealth, address recipient, address q, uint256 usdgIn, uint256 minQuoteIn)
        internal
        returns (ILaunchpad.LaunchResult memory r, uint256 refund)
    {
        return _launchUsdgTo(stealth, recipient, q, usdgIn, minQuoteIn, address(0));
    }

    function _launchUsdgTo(
        address stealth,
        address recipient,
        address q,
        uint256 usdgIn,
        uint256 minQuoteIn,
        address refundTo
    ) internal returns (ILaunchpad.LaunchResult memory r, uint256 refund) {
        vm.prank(payer);
        return anon.launchAnonWithUsdg(
            _paramsQ(q, 0, block.timestamp + 1 hours), stealth, recipient, "", 0x00, FEE, usdgIn, minQuoteIn, refundTo
        );
    }

    function test_launchAnonWithUsdg_succeeds_usdgPair() public {
        uint256 u0 = quote.balanceOf(payer);
        (ILaunchpad.LaunchResult memory r, uint256 refund) =
            _launchUsdg(stealthA, stealthA, address(quote), 10 ether, 10 ether);
        assertEq(refund, 0, "under the Trench First BOOST cap: no refund");
        assertGt(r.creatorTokensBought, 0);
        assertEq(anon.stealthOwnerOf(r.token), stealthA);
        assertEq(launchpad.creatorOf(r.token), address(anon));
        assertEq(Token(r.token).creator(), address(anon));
        assertEq(Token(r.token).balanceOf(stealthA), r.creatorTokensBought);
        assertEq(Token(r.token).balanceOf(payer), 0);
        assertEq(Token(r.token).balanceOf(address(anon)), 0);
        assertEq(launchpad.modeOf(r.token), Constants.MODE_TRENCH);
        assertEq(u0 - quote.balanceOf(payer), FEE + 10 ether);
        assertEq(quote.balanceOf(address(anon)), 0);
        assertEq(quote.balanceOf(address(router)), 0);
    }

    function test_launchAnonWithUsdg_succeeds_strategyPair() public {
        uint256 u0 = quote.balanceOf(payer);
        (ILaunchpad.LaunchResult memory r, uint256 refund) =
            _launchUsdg(stealthA, stealthA, address(strategy), 20 ether, 1);
        assertEq(refund, 0, "under the cap on the 1:1 reference pool");
        assertGt(r.creatorTokensBought, 0);
        assertEq(BondingCurve(r.curve).quote(), address(strategy));
        assertEq(Token(r.token).balanceOf(stealthA), r.creatorTokensBought);
        assertEq(u0 - quote.balanceOf(payer), FEE + 20 ether);
        assertEq(strategy.balanceOf(address(anon)), 0);
        assertEq(strategy.balanceOf(address(router)), 0);
        assertEq(quote.balanceOf(address(router)), 0);
    }

    function test_overCap_partialFill_refundsUsdg() public {
        uint256 cap = FeeMath.creatorBuyMax(launchpad.firstBoostMaxBps(Constants.MODE_TRENCH));
        uint256 u0 = quote.balanceOf(payer);
        (ILaunchpad.LaunchResult memory r, uint256 refund) =
            _launchUsdg(stealthA, stealthA, address(quote), 500 ether, 1);
        assertEq(r.creatorTokensBought, cap, "Trench First BOOST cap, partial fill");
        assertGt(refund, 0, "unused USDG refunded");
        assertEq(u0 - quote.balanceOf(payer), FEE + 500 ether - refund);
        assertEq(Token(r.token).balanceOf(stealthA), cap);
        assertEq(quote.balanceOf(address(anon)), 0);
    }

    function test_zero_first_buy_still_works() public {
        uint256 t0 = quote.balanceOf(treasury);
        (ILaunchpad.LaunchResult memory r, uint256 refund) = _launchUsdg(stealthA, stealthA, address(quote), 0, 0);
        assertEq(r.creatorTokensBought, 0);
        assertEq(refund, 0);
        assertEq(anon.stealthOwnerOf(r.token), stealthA);
        assertEq(launchpad.creatorOf(r.token), address(anon));
        assertEq(Token(r.token).balanceOf(stealthA), 0);
        assertEq(quote.balanceOf(treasury) - t0, FEE);
        // existing launchAnon path is unchanged
        vm.prank(payer);
        ILaunchpad.LaunchResult memory r2 = anon.launchAnon(_paramsLegacy(0), stealthB, stealthB, "", 0x00, FEE);
        assertEq(r2.creatorTokensBought, 0);
        assertEq(anon.stealthOwnerOf(r2.token), stealthB);
    }

    function test_slippage_and_minOut_revert() public {
        vm.startPrank(payer);
        vm.expectRevert(DiscipleRouter.Slippage.selector);
        anon.launchAnonWithUsdg(
            _paramsQ(address(strategy), 0, block.timestamp + 1 hours),
            stealthA,
            stealthA,
            "",
            0x00,
            FEE,
            10 ether,
            11 ether,
            address(0)
        );
        ILaunchpad.LaunchParams memory p = _paramsQ(address(quote), 1_000_000 ether, block.timestamp + 1 hours);
        vm.expectRevert(); // curve min-out
        anon.launchAnonWithUsdg(p, stealthA, stealthA, "", 0x00, FEE, 10 ether, 1, address(0));
        vm.stopPrank();
    }

    function test_stealth_owner_unlinkable() public {
        (ILaunchpad.LaunchResult memory r,) = _launchUsdg(stealthA, address(0), address(quote), 10 ether, 1);
        assertEq(Token(r.token).balanceOf(stealthA), r.creatorTokensBought);
        assertTrue(payer != stealthA);
        assertTrue(launchpad.creatorOf(r.token) != payer);
        assertTrue(Token(r.token).creator() != payer);
        assertEq(launchpad.creatorOf(r.token), address(anon));
        assertEq(Token(r.token).creator(), address(anon));
        assertEq(anon.stealthOwnerOf(r.token), stealthA);
        assertEq(Token(r.token).balanceOf(payer), 0, "First BOOST does not land on the paying wallet");
    }

    function test_reentrancy_guard() public {
        ReenteringFeeToken fee = new ReenteringFeeToken();
        AnonLauncher victim =
            new AnonLauncher(owner, address(launchpad), address(feeRouter), address(fee), treasury, address(0), FEE);
        fee.mint(payer, 100 ether);
        vm.prank(payer);
        fee.approve(address(victim), type(uint256).max);
        fee.arm(victim);
        vm.prank(payer);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        victim.launchAnonWithUsdg(
            _paramsQ(address(quote), 0, block.timestamp + 1 hours), stealthA, stealthA, "", 0x00, FEE, 0, 0, address(0)
        );
    }

    function test_stealth_owner_claims_first_buy_tokens_and_fees() public {
        (ILaunchpad.LaunchResult memory r,) = _launchUsdg(stealthA, stealthA, address(quote), 10 ether, 1);
        Token t = Token(r.token);
        uint256 bought = r.creatorTokensBought;
        assertEq(t.balanceOf(stealthA), bought);
        address bag = makeAddr("bag");
        vm.prank(stealthA);
        t.transfer(bag, bought);
        assertEq(t.balanceOf(bag), bought);
        assertEq(t.balanceOf(stealthA), 0);
        vm.warp(block.timestamp + 61);
        vm.startPrank(trader1);
        quote.approve(r.curve, type(uint256).max);
        BondingCurve(r.curve).buy(100 ether, 0, block.timestamp + 1 hours);
        vm.stopPrank();
        uint256 accrued = feeRouter.creatorAccrued(address(t), address(anon));
        assertGt(accrued, 0);
        address dest = makeAddr("feeDest");
        address[] memory toks = new address[](1);
        toks[0] = address(t);
        vm.prank(stealthA);
        anon.claimMany(toks, dest);
        assertEq(quote.balanceOf(dest), accrued);
        assertEq(feeRouter.creatorAccrued(address(t), address(anon)), 0);
    }

    function test_routerUnset_reverts() public {
        vm.prank(owner);
        launchpad.setTrustedRouter(address(router), false);
        vm.prank(payer);
        vm.expectRevert(AnonLauncher.RouterUnset.selector);
        anon.launchAnonWithUsdg(
            _paramsQ(address(quote), 0, block.timestamp + 1 hours),
            stealthA,
            stealthA,
            "",
            0x00,
            FEE,
            10 ether,
            1,
            address(0)
        );
    }

    function test_gas_private_launch_with_and_without_first_buy() public {
        uint256 g0 = gasleft();
        (ILaunchpad.LaunchResult memory r0,) = _launchUsdg(stealthA, stealthA, address(quote), 0, 0);
        uint256 gasNoBuy = g0 - gasleft();
        assertTrue(r0.token != address(0));

        g0 = gasleft();
        (ILaunchpad.LaunchResult memory r1,) = _launchUsdg(stealthB, stealthB, address(quote), 10 ether, 1);
        uint256 gasWithBuy = g0 - gasleft();
        assertGt(r1.creatorTokensBought, 0);

        emit log_named_uint("gas_private_launch_no_first_buy", gasNoBuy);
        emit log_named_uint("gas_private_launch_with_first_buy", gasWithBuy);
    }

    function test_overCap_refundTo_gets_leftover_not_payer() public {
        address refundTo = makeAddr("refundTo");
        uint256 cap = FeeMath.creatorBuyMax(launchpad.firstBoostMaxBps(Constants.MODE_TRENCH));
        uint256 u0 = quote.balanceOf(payer);
        (ILaunchpad.LaunchResult memory r, uint256 refund) =
            _launchUsdgTo(stealthA, stealthA, address(quote), 500 ether, 1, refundTo);
        assertEq(r.creatorTokensBought, cap, "Trench First BOOST cap, partial fill");
        assertGt(refund, 0, "unused USDG refunded");
        // payer is down the fee + the full 500; leftover is sent to refundTo, not back to the payer
        assertEq(u0 - quote.balanceOf(payer), FEE + 500 ether);
        assertEq(quote.balanceOf(refundTo), refund);
        assertEq(quote.balanceOf(address(anon)), 0);
        assertEq(Token(r.token).balanceOf(stealthA), cap);
    }

    function test_overCap_strategyPair_refundTo_gets_usdg() public {
        address refundTo = makeAddr("refundTo");
        uint256 u0 = quote.balanceOf(payer);
        (ILaunchpad.LaunchResult memory r, uint256 refund) =
            _launchUsdgTo(stealthA, stealthA, address(strategy), 500 ether, 1, refundTo);
        assertGt(refund, 0, "unused USDG after the pair-token leftover is swapped back");
        assertGt(r.creatorTokensBought, 0);
        assertEq(u0 - quote.balanceOf(payer), FEE + 500 ether);
        assertEq(quote.balanceOf(refundTo), refund);
        assertEq(quote.balanceOf(address(anon)), 0);
        assertEq(strategy.balanceOf(address(anon)), 0);
        assertEq(strategy.balanceOf(refundTo), 0, "leftover is USDG, not the pair token");
        assertEq(quote.balanceOf(address(router)), 0);
        assertEq(strategy.balanceOf(address(router)), 0);
    }

    function test_underCap_refundTo_gets_nothing() public {
        address refundTo = makeAddr("refundTo");
        uint256 u0 = quote.balanceOf(payer);
        (ILaunchpad.LaunchResult memory r, uint256 refund) =
            _launchUsdgTo(stealthA, stealthA, address(quote), 10 ether, 10 ether, refundTo);
        assertEq(refund, 0);
        assertGt(r.creatorTokensBought, 0);
        assertEq(quote.balanceOf(refundTo), 0);
        assertEq(u0 - quote.balanceOf(payer), FEE + 10 ether);
        assertEq(quote.balanceOf(address(anon)), 0);
    }

    function test_refundTo_zero_defaults_to_msgSender() public {
        uint256 u0 = quote.balanceOf(payer);
        (ILaunchpad.LaunchResult memory r, uint256 refund) =
            _launchUsdgTo(stealthA, stealthA, address(quote), 500 ether, 1, address(0));
        assertGt(refund, 0);
        assertGt(r.creatorTokensBought, 0);
        // address(0) means msg.sender (the payer), same as the pre-refundTo behavior
        assertEq(u0 - quote.balanceOf(payer), FEE + 500 ether - refund);
        assertEq(quote.balanceOf(address(anon)), 0);
    }

    function test_refundTo_cannot_be_launcher() public {
        vm.prank(payer);
        vm.expectRevert(AnonLauncher.BadRefundTo.selector);
        anon.launchAnonWithUsdg(
            _paramsQ(address(quote), 0, block.timestamp + 1 hours),
            stealthA,
            stealthA,
            "",
            0x00,
            FEE,
            10 ether,
            1,
            address(anon)
        );
    }

    function test_multicall_caller_refunds_to_player_not_caller() public {
        address mc = makeAddr("multicall3");
        address player = makeAddr("player");
        uint256 cap = FeeMath.creatorBuyMax(launchpad.firstBoostMaxBps(Constants.MODE_TRENCH));
        quote.mint(mc, 1_000_000 ether);
        vm.startPrank(mc);
        quote.approve(address(anon), type(uint256).max);
        (ILaunchpad.LaunchResult memory r, uint256 refund) = anon.launchAnonWithUsdg(
            _paramsQ(address(quote), 0, block.timestamp + 1 hours),
            stealthA,
            stealthA,
            "",
            0x00,
            FEE,
            500 ether,
            1,
            player
        );
        vm.stopPrank();
        assertEq(r.creatorTokensBought, cap);
        assertGt(refund, 0);
        // caller (Multicall3) is down fee + 500, leftover went to the named player, nothing stuck on the caller or launcher
        assertEq(quote.balanceOf(player), refund);
        assertEq(quote.balanceOf(address(anon)), 0);
        assertEq(quote.balanceOf(mc), 1_000_000 ether - FEE - 500 ether);
        assertEq(Token(r.token).balanceOf(stealthA), cap);
        assertEq(Token(r.token).balanceOf(mc), 0);
        assertEq(Token(r.token).balanceOf(player), 0);
    }
}
