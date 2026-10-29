// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IntegrationBase, MockUSDG} from "./IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {DiscipleRouter} from "../../src/DiscipleRouter.sol";
import {DiscipleSessionPolicy as P} from "../../src/session/DiscipleSessionPolicy.sol";
import {PackedUserOperation} from "../../src/session/IERC6900.sol";
import {MockMAv2} from "../session/DiscipleSessionPolicy.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {LoginGate} from "../../src/LoginGate.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {Constants} from "../../src/libraries/Constants.sol";

/// @notice DiscipleRouter.buyWithUsdg / sellToUsdg: the frontend pays in USDG, the router hops USDG<->quote through
///         the owner-registered USDG/quote pool, then the curve (pre-grad) or the coin's v4 pool (post-grad).
contract UsdgRouterTest is IntegrationBase {
    BondingCurve sCurve; // STRATEGY-quoted coin (two hops)
    Token sTok;
    BondingCurve uCurve; // USDG-quoted coin (single hop)
    Token uTok;
    address alice = makeAddr("alice");

    function setUp() public override {
        super.setUp();
        router.setUsdgRouting(address(quote), address(launchpad)); // test contract deployed the router (owner)
        router.setUsdgPool(address(strategy), strategyUsdgKey);
        (sCurve, sTok) = _launchWithQuote(address(strategy), 0, 0);
        (uCurve, uTok) = _launchWithQuote(address(quote), 0, 0);
        _warpPastSnipe();
        quote.mint(alice, 1_000_000 * U);
        vm.startPrank(alice);
        quote.approve(address(router), type(uint256).max);
        sTok.approve(address(router), type(uint256).max);
        uTok.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _dl() internal view returns (uint256) {
        return block.timestamp + 1 hours;
    }

    function _noDust() internal view {
        assertEq(quote.balanceOf(address(router)), 0, "router usdg dust");
        assertEq(strategy.balanceOf(address(router)), 0, "router quote dust");
        assertEq(sTok.balanceOf(address(router)), 0, "router token dust");
        assertEq(uTok.balanceOf(address(router)), 0, "router token dust");
    }

    function _buy(Token t, uint256 usdgIn) internal returns (uint256 out, uint256 gasUsed) {
        (uint256 q,) = router.quoteBuyWithUsdg(address(t), usdgIn);
        uint256 u0 = quote.balanceOf(alice);
        uint256 t0 = t.balanceOf(alice);
        vm.prank(alice);
        uint256 g = gasleft();
        out = router.buyWithUsdg(address(t), usdgIn, q, _dl());
        gasUsed = g - gasleft();
        assertEq(out, q, "quote == executed");
        assertEq(u0 - quote.balanceOf(alice), usdgIn, "usdg spent");
        assertEq(t.balanceOf(alice) - t0, out, "tokens to sender");
        _noDust();
    }

    function _sellAll(Token t) internal returns (uint256 out, uint256 gasUsed) {
        uint256 bal = t.balanceOf(alice) / 2;
        (uint256 q,) = router.quoteSellToUsdg(address(t), bal);
        uint256 u0 = quote.balanceOf(alice);
        vm.prank(alice);
        uint256 g = gasleft();
        out = router.sellToUsdg(address(t), bal, q, _dl());
        gasUsed = g - gasleft();
        assertEq(out, q, "quote == executed");
        assertEq(quote.balanceOf(alice) - u0, out, "usdg to sender");
        _noDust();
    }

    // ───────── curve (pre-graduation) ─────────

    function test_curveMultiHopBuySell() public {
        (uint256 out, uint256 gb) = _buy(sTok, 100 * U);
        assertGt(out, 0);
        (uint256 usdgOut, uint256 gs) = _sellAll(sTok);
        assertGt(usdgOut, 0);
        assertLt(usdgOut, 50 * U); // fees on both hops + curve
        console2.log("gas buyWithUsdg curve 2-hop", gb);
        console2.log("gas sellToUsdg curve 2-hop", gs);
    }

    function test_curveSingleHopUsdgQuote() public {
        (uint256 out, uint256 gb) = _buy(uTok, 100 * U);
        assertGt(out, 0);
        (, uint256 gs) = _sellAll(uTok);
        console2.log("gas buyWithUsdg curve 1-hop", gb);
        console2.log("gas sellToUsdg curve 1-hop", gs);
    }

    // ───────── graduated v4 pool ─────────

    function test_gradMultiHopBuySell() public {
        _graduateWith(sCurve, strategy);
        (uint256 out, uint256 gb) = _buy(sTok, 100 * U);
        assertGt(out, 0);
        (, uint256 gs) = _sellAll(sTok);
        console2.log("gas buyWithUsdg v4 2-hop", gb);
        console2.log("gas sellToUsdg v4 2-hop", gs);
    }

    function test_gradSingleHopUsdgQuote() public {
        _graduateWith(uCurve, quote);
        (, uint256 gb) = _buy(uTok, 100 * U);
        (, uint256 gs) = _sellAll(uTok);
        console2.log("gas buyWithUsdg v4 1-hop", gb);
        console2.log("gas sellToUsdg v4 1-hop", gs);
    }

    /// The final buy that graduates the curve refunds unused quote to the buyer (never left in the router).
    function test_graduatingBuyThroughRouter() public {
        // fill most of the curve with direct buys, then finish through the router
        for (uint256 i; i < 80 && sCurve.progressBps() < 9000; ++i) {
            address w = makeAddr(string(abi.encodePacked("w", vm.toString(i))));
            strategy.mint(w, 1000 ether);
            vm.startPrank(w);
            strategy.approve(address(sCurve), 1000 ether);
            try sCurve.buy(400 ether, 0, _dl()) {} catch {}
            vm.stopPrank();
        }
        quote.mint(alice, 10_000 * U);
        vm.prank(router.owner() == address(this) ? address(this) : router.owner());
        router.setMaxImpactBps(100_000);
        uint256 s0 = strategy.balanceOf(alice);
        uint256 u0 = quote.balanceOf(alice);
        vm.prank(alice);
        router.buyWithUsdg(address(sTok), 3000 * U, 1, _dl()); // $7,777→$33,333 leaves ~$2.2K above 90%
        assertTrue(sCurve.graduated(), "router buy graduated the curve");
        // DISCIPLE audit #6: the unused intermediate quote is swapped back and refunded in USDG
        assertEq(strategy.balanceOf(alice), s0, "no intermediate-quote refund");
        assertLt(u0 - quote.balanceOf(alice), 3000 * U, "unused quote refunded to buyer in USDG");
        _noDust();
    }

    // ───────── guards ─────────

    function test_slippageRevertsEndToEnd() public {
        (uint256 q,) = router.quoteBuyWithUsdg(address(sTok), 100 * U);
        vm.prank(alice);
        vm.expectRevert();
        router.buyWithUsdg(address(sTok), 100 * U, q + 1, _dl());

        vm.prank(alice);
        router.buyWithUsdg(address(sTok), 100 * U, q, _dl());
        uint256 bal = sTok.balanceOf(alice);
        (uint256 qs,) = router.quoteSellToUsdg(address(sTok), bal);
        vm.prank(alice);
        vm.expectRevert(DiscipleRouter.Slippage.selector);
        router.sellToUsdg(address(sTok), bal, qs + 1, _dl());

        _graduateWith(sCurve, strategy);
        (q,) = router.quoteBuyWithUsdg(address(sTok), 10 * U);
        vm.prank(alice);
        vm.expectRevert(DiscipleRouter.Slippage.selector);
        router.buyWithUsdg(address(sTok), 10 * U, q + 1, _dl());
    }

    function test_zeroMinOutAndDeadline() public {
        vm.startPrank(alice);
        vm.expectRevert(DiscipleRouter.ZeroMinOut.selector);
        router.buyWithUsdg(address(sTok), 1 * U, 0, _dl());
        vm.expectRevert(DiscipleRouter.ZeroMinOut.selector);
        router.sellToUsdg(address(sTok), 1 * U, 0, _dl());
        vm.expectRevert(DiscipleRouter.Expired.selector);
        router.buyWithUsdg(address(sTok), 1 * U, 1, block.timestamp - 1);
        vm.stopPrank();
    }

    function test_impactCapOnUsdgHop() public {
        // USDG/STRATEGY ref pool is 100k liquidity full-range: a big buy moves it > 50%
        (, uint256 imp) = router.quoteBuyWithUsdg(address(sTok), 60_000 * U);
        assertGt(imp, 5000);
        quote.mint(alice, 100_000 * U);
        vm.prank(alice);
        vm.expectPartialRevert(DiscipleRouter.PriceImpactTooHigh.selector);
        router.buyWithUsdg(address(sTok), 60_000 * U, 1, _dl());
    }

    function test_impactCapOnCurveHop() public {
        router.setMaxImpactBps(100); // 1%
        vm.prank(alice);
        vm.expectPartialRevert(DiscipleRouter.PriceImpactTooHigh.selector);
        router.buyWithUsdg(address(uTok), 500 * U, 1, _dl());
    }

    function test_impactCapOnGraduatedHop() public {
        _graduateWith(uCurve, quote);
        quote.mint(alice, 100_000 * U);
        vm.prank(alice);
        vm.expectPartialRevert(DiscipleRouter.PriceImpactTooHigh.selector);
        router.buyWithUsdg(address(uTok), 20_000 * U, 1, _dl());
    }

    function test_registryOwnerOnlyAndValidated() public {
        vm.prank(alice);
        vm.expectRevert(DiscipleRouter.OnlyOwner.selector);
        router.setUsdgPool(address(strategy), strategyUsdgKey);
        vm.prank(alice);
        vm.expectRevert(DiscipleRouter.OnlyOwner.selector);
        router.setUsdgRouting(address(quote), address(launchpad));
        // pool must pair USDG with the quote
        MockUSDG other = new MockUSDG();
        vm.expectRevert(DiscipleRouter.BadPool.selector);
        router.setUsdgPool(address(other), strategyUsdgKey);
        // unregistered pool → no route
        router.removeUsdgPool(address(strategy));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DiscipleRouter.NoUsdgPool.selector, address(strategy)));
        router.buyWithUsdg(address(sTok), 1 * U, 1, _dl());
    }

    // ───────── session key path (executeUserOp) ─────────

    MockMAv2 acct;
    P policy;
    address sessKey = makeAddr("sessionKey");
    uint32 constant E = 7;

    function _installSession(uint128 cap) internal {
        acct = new MockMAv2(address(this));
        policy = new P(address(referrals), address(0));
        quote.mint(address(acct), 1_000 * U);
        P.SessionConfig memory c = P.SessionConfig({
            validUntil: uint48(block.timestamp + 1 hours),
            validAfter: 0,
            permissions: policy.P_ROUTER_BUY() | policy.P_ROUTER_SELL() | policy.P_APPROVE(),
            router: address(router),
            launchpad: address(launchpad),
            anonLauncher: address(0),
            trampWallManager: address(0),
            quote0: address(quote),
            quote1: address(0),
            cap0: cap,
            cap1: 0,
            maxSlippageBps: 100,
            stealthOwner: address(0)
        });
        acct.installSession(policy, E, sessKey, c);
    }

    function _uo(MockMAv2.Call[] memory cs) internal {
        PackedUserOperation memory op;
        op.sender = address(acct);
        op.callData = abi.encodePacked(bytes4(0x8dd7712f), abi.encodeCall(MockMAv2.executeBatch, (cs)));
        vm.prank(0x0000000071727De22E5E9d8BAf0edAc6f37da032); // EntryPoint v0.7
        acct.executeUserOp(op, bytes32(0));
    }

    function _buyCalls(uint256 approveAmt, uint256 usdgIn, uint256 minOut)
        internal
        view
        returns (MockMAv2.Call[] memory cs)
    {
        cs = new MockMAv2.Call[](2);
        cs[0] = MockMAv2.Call(address(quote), 0, abi.encodeCall(IERC20.approve, (address(router), approveAmt)));
        cs[1] = MockMAv2.Call(
            address(router), 0, abi.encodeCall(DiscipleRouter.buyWithUsdg, (address(sTok), usdgIn, minOut, _dl()))
        );
    }

    function test_sessionBuySellViaExecuteUserOp_capInUsdg() public {
        _installSession(uint128(150 * U));
        (uint256 q,) = router.quoteBuyWithUsdg(address(sTok), 100 * U);
        _uo(_buyCalls(100 * U, 100 * U, q * 9950 / 10_000));
        assertGt(sTok.balanceOf(address(acct)), 0);
        assertEq(policy.sessionOf(address(acct), E).spent0, 100 * U, "cap counted in USDG");
        assertEq(quote.allowance(address(acct), address(router)), 0, "exact approve consumed");

        // over the USDG cap: 100 + 60 > 150
        (q,) = router.quoteBuyWithUsdg(address(sTok), 60 * U);
        MockMAv2.Call[] memory cs = _buyCalls(60 * U, 60 * U, q);
        vm.expectRevert(abi.encodeWithSelector(P.SpendCapExceeded.selector, address(quote), 160 * U, 150 * U));
        _uo(cs);

        // sell to USDG: proceeds pinned to the account (router pays msg.sender)
        uint256 bal = sTok.balanceOf(address(acct));
        (uint256 qs,) = router.quoteSellToUsdg(address(sTok), bal);
        cs = new MockMAv2.Call[](2);
        cs[0] = MockMAv2.Call(address(sTok), 0, abi.encodeCall(IERC20.approve, (address(router), bal)));
        cs[1] = MockMAv2.Call(
            address(router), 0, abi.encodeCall(DiscipleRouter.sellToUsdg, (address(sTok), bal, qs * 9950 / 10_000, _dl()))
        );
        uint256 u0 = quote.balanceOf(address(acct));
        _uo(cs);
        assertGt(quote.balanceOf(address(acct)), u0);
        assertEq(policy.sessionOf(address(acct), E).spent0, 100 * U, "sells do not count");
    }

    function test_sessionRejects() public {
        _installSession(uint128(1_000 * U));
        (uint256 q,) = router.quoteBuyWithUsdg(address(sTok), 10 * U);
        // slippage beyond maxSlippageBps (1%) end to end
        uint256 req = q * 9900 / 10_000;
        vm.expectRevert(abi.encodeWithSelector(P.MinOutTooLow.selector, req - 1, req));
        _uo(_buyCalls(10 * U, 10 * U, req - 1));
        // USDG approve must be exact
        vm.expectRevert(abi.encodeWithSelector(P.UsdgApproveNotExact.selector, 11 * U, 10 * U));
        _uo(_buyCalls(11 * U, 10 * U, q));
        // USDG approve only to DiscipleRouter (no curve / Permit2 / UniversalRouter)
        address permit2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
        MockMAv2.Call[] memory cs = new MockMAv2.Call[](1);
        cs[0] = MockMAv2.Call(address(quote), 0, abi.encodeCall(IERC20.approve, (permit2, 10 * U)));
        vm.expectRevert(abi.encodeWithSelector(P.SpenderNotAllowed.selector, permit2));
        _uo(cs);
        // USDG approve to a curve is allowed only for exactly that batch's curve spend (none here → 0 required)
        cs[0] = MockMAv2.Call(address(quote), 0, abi.encodeCall(IERC20.approve, (address(uCurve), 10 * U)));
        vm.expectRevert(abi.encodeWithSelector(P.UsdgApproveNotExact.selector, 10 * U, 0));
        _uo(cs);
        // zero minOut
        vm.expectRevert(P.ZeroMinOut.selector);
        _uo(_buyCalls(10 * U, 10 * U, 0));
    }

    /// DISCIPLE audit #5: exact-amount USDG approvals to a curve (and other spenders) matched to the batch's spend.
    function test_sessionUsdgApproveToCurveExact() public {
        acct = new MockMAv2(address(this));
        policy = new P(address(referrals), address(0));
        quote.mint(address(acct), 1_000 * U);
        P.SessionConfig memory c = P.SessionConfig({
            validUntil: uint48(block.timestamp + 1 hours),
            validAfter: 0,
            permissions: policy.P_CURVE_BUY() | policy.P_APPROVE() | policy.P_ROUTER_BUY(),
            router: address(router),
            launchpad: address(launchpad),
            anonLauncher: address(0),
            trampWallManager: address(0),
            quote0: address(quote),
            quote1: address(0),
            cap0: uint128(100 * U),
            cap1: 0,
            maxSlippageBps: 100,
            stealthOwner: address(0)
        });
        acct.installSession(policy, E, sessKey, c);
        uint256 q = uCurve.quoteBuy(5 * U).tokensOut;
        MockMAv2.Call[] memory cs = new MockMAv2.Call[](2);
        cs[0] = MockMAv2.Call(address(quote), 0, abi.encodeCall(IERC20.approve, (address(uCurve), 5 * U)));
        cs[1] = MockMAv2.Call(
            address(uCurve),
            0,
            abi.encodeWithSignature("buy(uint256,uint256,uint256,address)", 5 * U, q * 9950 / 10_000, _dl(), address(acct))
        );
        _uo(cs);
        assertGt(uTok.balanceOf(address(acct)), 0, "session USDG curve buy works");
        assertEq(policy.sessionOf(address(acct), E).spent0, 5 * U);
        // not exact → rejected
        cs[0] = MockMAv2.Call(address(quote), 0, abi.encodeCall(IERC20.approve, (address(uCurve), 6 * U)));
        q = uCurve.quoteBuy(5 * U).tokensOut;
        cs[1] = MockMAv2.Call(
            address(uCurve),
            0,
            abi.encodeWithSignature("buy(uint256,uint256,uint256,address)", 5 * U, q * 9950 / 10_000, _dl(), address(acct))
        );
        vm.expectRevert(abi.encodeWithSelector(P.UsdgApproveNotExact.selector, 6 * U, 5 * U));
        _uo(cs);
    }


    /// DISCIPLE audit Medium-2: session USDG quotes are for the ACCOUNT, so a PVE session buy works (the policy
    /// contract itself is not logged in) and the sell floor includes the account's profit tax.
    function test_sessionPveBuyQuotedForAccount() public {
        uint256 pk = 0xA77E57;
        LoginGate gate = new LoginGate(owner, vm.addr(pk));
        vm.prank(owner);
        launchpad.setLoginGate(address(gate));
        vm.prank(creator);
        ILaunchpad.LaunchResult memory r = launchpad.launchWithMode(
            ILaunchpad.LaunchParams({
                name: "P",
                ticker: "P",
                imageURI: "i",
                description: "",
                socialsURI: "",
                quote: address(quote),
                creatorTaxBps: 0,
                creatorBuyQuoteIn: 0,
                creatorBuyMinTokensOut: 0,
                deadline: block.timestamp + 1 days
            }),
            Constants.MODE_PVE
        );
        Token pTok = Token(r.token);
        vm.roll(block.number + 1);
        _installSession(uint128(150 * U));
        uint64 exp = uint64(vm.getBlockTimestamp() + 12 hours);
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(pk, gate.digest(address(acct), exp, address(0)));
        gate.attest(address(acct), exp, address(0), abi.encodePacked(rr, ss, v));

        // the policy (msg.sender of the old quote path) is not verified → old behaviour reverted NotVerified
        vm.prank(address(policy));
        vm.expectRevert(BondingCurve.NotVerified.selector);
        router.quoteUsdgRoute(address(pTok), true, 10 * U);

        (uint256 q,) = router.quoteUsdgRouteFor(address(acct), address(pTok), true, 10 * U);
        MockMAv2.Call[] memory cs = new MockMAv2.Call[](2);
        cs[0] = MockMAv2.Call(address(quote), 0, abi.encodeCall(IERC20.approve, (address(router), 10 * U)));
        cs[1] = MockMAv2.Call(
            address(router), 0, abi.encodeCall(DiscipleRouter.buyWithUsdg, (address(pTok), 10 * U, q, _dl()))
        );
        _uo(cs);
        assertEq(pTok.balanceOf(address(acct)), q, "PVE session buy executed at the account's quote");

        // sell floor: the account's quote nets out its PVE profit tax (zero-basis callers would be looser)
        uint256 bal = pTok.balanceOf(address(acct));
        (uint256 qs,) = router.quoteUsdgRouteFor(address(acct), address(pTok), false, bal);
        assertEq(qs, BondingCurve(r.curve).quoteSellFor(address(acct), bal).quoteOut);
    }
}

/// @notice 6-decimal USDG run of UsdgRouterTest (mainnet USDG / next testnet mock); same tests, `U` = 1e6.
contract UsdgRouter6DecTest is UsdgRouterTest {
    function _usdgDecimals() internal pure override returns (uint8) {
        return 6;
    }
}
