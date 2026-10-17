// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase, MockUSDG} from "../integration/IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {LoginGate} from "../../src/LoginGate.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {Constants} from "../../src/libraries/Constants.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";

/// @notice Bonding-curve game modes (contracts/docs/bonding-modes.md): PVE / PVP / TRENCH WARFARE.
contract BondingModesTest is IntegrationBase {
    using stdStorage for StdStorage;
    LoginGate gate;
    uint256 attesterPk = 0xA77E57;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");

    uint256 constant ONE_PCT = Constants.TOTAL_SUPPLY / 100;

    event LaunchMode(address indexed token, address indexed curve, uint8 mode);
    event ProfitTaxCharged(
        address indexed token, address indexed seller, uint256 tax, uint256 grossQuote, uint256 costBasis
    );

    function setUp() public override {
        super.setUp();
        gate = new LoginGate(owner, vm.addr(attesterPk));
        vm.prank(owner);
        launchpad.setLoginGate(address(gate));
        router.setUsdgRouting(address(quote), address(launchpad));
        address[4] memory ws = [alice, bob, carol, dave];
        for (uint256 i; i < 4; ++i) quote.mint(ws[i], 10_000_000 ether);
    }

    // ── helpers ──
    function _params(uint256 creatorBuy) internal view returns (ILaunchpad.LaunchParams memory) {
        return ILaunchpad.LaunchParams({
            name: "Mode",
            ticker: "MODE",
            imageURI: "ipfs://img",
            description: "",
            socialsURI: "",
            quote: address(quote),
            creatorTaxBps: 0,
            creatorBuyQuoteIn: creatorBuy,
            creatorBuyMinTokensOut: 0,
            deadline: block.timestamp + 1 days
        });
    }

    function _launchMode(uint8 m) internal returns (BondingCurve c, Token t) {
        vm.prank(creator);
        ILaunchpad.LaunchResult memory r = launchpad.launchWithMode(_params(0), m);
        c = BondingCurve(r.curve);
        t = Token(r.token);
    }

    function _verify(address w) internal {
        uint64 exp = uint64(block.timestamp + 12 hours);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPk, gate.digest(w, exp, address(0)));
        gate.attest(w, exp, address(0), abi.encodePacked(r, s, v));
    }

    function _open(uint256 dt) internal {
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + dt);
    }

    function _buyQ(BondingCurve c, address w, uint256 q) internal returns (uint256 out) {
        vm.startPrank(w);
        quote.approve(address(c), q);
        out = c.buy(q, 0, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
    }

    /// @dev quote needed to buy ~`tokens` at the current price (overshoot-safe: 2% under).
    function _quoteFor(BondingCurve c, uint256 tokens) internal view returns (uint256 q) {
        q = 1 ether;
        while (c.quoteBuy(q).tokensOut < tokens) q = q * 2;
        uint256 lo = q / 2;
        uint256 hi = q;
        for (uint256 i; i < 60; ++i) {
            uint256 mid = (lo + hi) / 2;
            if (c.quoteBuy(mid).tokensOut <= tokens) lo = mid;
            else hi = mid;
        }
        return lo;
    }

    function _sc(BondingCurve c) internal view returns (uint256 sc) {
        (, sc,,) = c.curveParams();
    }

    function _sellT(BondingCurve c, Token t, address w, uint256 n) internal returns (uint256 out) {
        vm.startPrank(w);
        t.approve(address(c), n);
        out = c.sell(n, 0, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
    }

    // ── launch / mode storage ──

    function test_modeStoredAndEvent() public {
        vm.expectEmit(false, false, false, false);
        emit LaunchMode(address(0), address(0), 2);
        (BondingCurve c, Token t) = _launchMode(Constants.MODE_PVP);
        assertEq(c.mode(), Constants.MODE_PVP);
        assertEq(launchpad.modeOf(address(t)), Constants.MODE_PVP);
        (BondingCurve c2,) = _launch(0, 0); // legacy launchCoin = TRENCH
        assertEq(c2.mode(), Constants.MODE_TRENCH);
    }

    function test_badModeAndGateRequired() public {
        vm.prank(creator);
        vm.expectRevert(Launchpad.BadMode.selector);
        launchpad.launchWithMode(_params(0), 3);
        vm.prank(owner);
        launchpad.setLoginGate(address(0));
        vm.prank(creator);
        vm.expectRevert(Launchpad.LoginGateUnset.selector);
        launchpad.launchWithMode(_params(0), Constants.MODE_PVE);
    }

    function test_trenchNoCaps() public {
        (BondingCurve c,) = _launchMode(Constants.MODE_TRENCH);
        _warpPastSnipe();
        uint256 out = _buyQ(c, alice, 5_000 ether); // far above 1% / 3.33%
        assertGt(out, 4 * ONE_PCT);
        assertEq(c.totalNet(), 0, "TRENCH does no PVE bookkeeping");
    }

    // ── PVE ──

    function test_pve_loginRequired() public {
        (BondingCurve c,) = _launchMode(Constants.MODE_PVE);
        _open(10 minutes);
        vm.startPrank(alice);
        quote.approve(address(c), 1 ether);
        vm.expectRevert(BondingCurve.NotVerified.selector);
        c.buy(1 ether, 0, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
        // bad signer
        uint64 exp = uint64(block.timestamp + 1 days);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, gate.digest(alice, exp, address(0)));
        vm.expectRevert(LoginGate.BadSignature.selector);
        gate.attest(alice, exp, address(0), abi.encodePacked(r, s, v));
        // expired
        (v, r, s) = vm.sign(attesterPk, gate.digest(alice, uint64(block.timestamp), address(0)));
        vm.expectRevert(LoginGate.Expired.selector);
        gate.attest(alice, uint64(block.timestamp), address(0), abi.encodePacked(r, s, v));
        // ok + cached
        _verify(alice);
        _buyQ(c, alice, 1 ether);
        assertGt(c.verifiedUntilOf(alice), block.timestamp, "cached");
    }

    function test_pve_coinScopedAttestation() public {
        (BondingCurve c, Token t) = _launchMode(Constants.MODE_PVE);
        (BondingCurve c2,) = _launchMode(Constants.MODE_PVE);
        _open(10 minutes);
        uint64 exp = uint64(block.timestamp + 1 days);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPk, gate.digest(alice, exp, address(t)));
        gate.attest(alice, exp, address(t), abi.encodePacked(r, s, v));
        _buyQ(c, alice, 1 ether);
        vm.startPrank(alice);
        quote.approve(address(c2), 1 ether);
        vm.expectRevert(BondingCurve.NotVerified.selector);
        c2.buy(1 ether, 0, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
    }

    function test_pve_launchBlockOnlyCreatorBuy() public {
        _verify(creator);
        _verify(alice);
        vm.startPrank(creator);
        quote.approve(address(launchpad), 5 ether);
        ILaunchpad.LaunchResult memory res = launchpad.launchWithMode(_params(5 ether), Constants.MODE_PVE);
        vm.stopPrank();
        BondingCurve c = BondingCurve(res.curve);
        assertGt(res.creatorTokensBought, 0, "creator launch buy allowed in launch tx");
        assertEq(c.balanceOnCurve(creator), res.creatorTokensBought, "creator buy counts toward NET");
        vm.startPrank(alice);
        quote.approve(address(c), 1 ether);
        vm.expectRevert(BondingCurve.LaunchBlock.selector);
        c.buy(1 ether, 0, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
        vm.roll(block.number + 1);
        _buyQ(c, alice, 1 ether);
    }

    function test_pve_creatorLaunchBuyCapped() public {
        _verify(creator);
        vm.startPrank(creator);
        quote.approve(address(launchpad), 200 ether);
        vm.expectRevert(BondingCurve.BuyTooLarge.selector); // > 0.25% inside the launch window
        launchpad.launchWithMode(_params(200 ether), Constants.MODE_PVE);
        vm.stopPrank();
    }

    function test_pve_windowCapThenNetCap() public {
        (BondingCurve c, Token t) = _launchMode(Constants.MODE_PVE);
        _verify(alice);
        _open(10); // past anti-snipe, inside the 7-min window
        assertEq(c.maxBuyNow(), Constants.TOTAL_SUPPLY * 25 / 10_000);
        uint256 q = _quoteFor(c, ONE_PCT / 2); // 0.5% > 0.25%
        vm.startPrank(alice);
        quote.approve(address(c), q);
        vm.expectRevert(BondingCurve.BuyTooLarge.selector);
        c.buy(q, 0, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
        _buyQ(c, alice, _quoteFor(c, ONE_PCT / 5)); // 0.2% ok
        // window ends at exactly 7 minutes
        vm.warp(c.launchTime() + Constants.PVE_WINDOW);
        assertEq(c.maxBuyNow(), type(uint256).max);
        _buyQ(c, alice, _quoteFor(c, ONE_PCT * 7 / 10)); // total ~0.9%
        uint256 q2 = _quoteFor(c, ONE_PCT / 5);
        vm.startPrank(alice);
        quote.approve(address(c), q2);
        vm.expectRevert(BondingCurve.WalletCap.selector);
        c.buy(q2, 0, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
        // sells free up room (NET)
        _sellT(c, t, alice, c.balanceOnCurve(alice) / 2);
        _buyQ(c, alice, q2);
        assertLe(c.balanceOnCurve(alice), ONE_PCT);
    }

    function test_pve_maxSell() public {
        (BondingCurve c, Token t) = _launchMode(Constants.MODE_PVE);
        _verify(alice);
        _open(8 minutes);
        _buyQ(c, alice, _quoteFor(c, ONE_PCT * 9 / 10));
        uint256 tooMuch = ONE_PCT / 2 + 1;
        vm.startPrank(alice);
        t.approve(address(c), tooMuch);
        vm.expectRevert(BondingCurve.SellTooLarge.selector);
        c.sell(tooMuch, 0, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
        _sellT(c, t, alice, ONE_PCT / 2);
    }

    /// Pump price ≥ 1.8x with many verified wallets (each under the 1% cap).
    function _pump(BondingCurve c, uint256 ratioBps) internal {
        uint256 p0 = c.spotPriceWad();
        for (uint256 i; i < 60 && c.spotPriceWad() * 10_000 < p0 * ratioBps; ++i) {
            address w = makeAddr(string(abi.encodePacked("pump", vm.toString(i))));
            quote.mint(w, 1_000_000 ether);
            _verify(w);
            _buyQ(c, w, _quoteFor(c, ONE_PCT * 9 / 10));
        }
        assertGe(c.spotPriceWad() * 10_000, p0 * ratioBps, "pumped");
    }

    function test_pve_profitTaxAccumulatorFairness() public {
        (BondingCurve c, Token t) = _launchMode(Constants.MODE_PVE);
        _open(8 minutes);
        _verify(alice);
        _verify(bob);
        _verify(carol);
        _verify(dave);
        _buyQ(c, alice, _quoteFor(c, ONE_PCT * 8 / 10));
        _buyQ(c, bob, _quoteFor(c, ONE_PCT * 6 / 10));
        _buyQ(c, carol, _quoteFor(c, ONE_PCT * 3 / 10));
        _pump(c, 20_000); // 2x price

        uint256 sellAmt = ONE_PCT * 4 / 10;
        BondingCurve.SellQuote memory sq = c.quoteSellFor(alice, sellAmt);
        assertGt(sq.profitTax, 0, "taxed");
        assertEq(sq.profitTax, (sq.quoteOut + sq.profitTax) * 7770 / 1e6, "0.777% of proceeds");

        uint256 totalBefore = c.totalNet();
        uint256 aliceAfter = c.balanceOnCurve(alice) - sellAmt;
        uint256 others = totalBefore - sellAmt - aliceAfter;
        uint256 bobNet = c.balanceOnCurve(bob);
        uint256 carolNet = c.balanceOnCurve(carol);

        vm.prank(alice);
        t.approve(address(c), sellAmt);
        vm.expectEmit(true, true, false, false);
        emit ProfitTaxCharged(address(t), alice, 0, 0, 0);
        vm.prank(alice);
        uint256 out = c.sell(sellAmt, 0, vm.getBlockTimestamp() + 1 hours);
        assertEq(out, sq.quoteOut, "quote == executed (net of tax)");

        assertEq(c.pendingRewards(alice), 0, "seller excluded");
        assertApproxEqRel(c.pendingRewards(bob), sq.profitTax * bobNet / others, 1e6, "bob pro-rata");
        assertApproxEqRel(c.pendingRewards(carol), sq.profitTax * carolNet / others, 1e6, "carol pro-rata");

        // dave joins AFTER the taxed sell → 0 of it
        _buyQ(c, dave, _quoteFor(c, ONE_PCT / 2));
        assertEq(c.pendingRewards(dave), 0, "late joiner gets 0");

        // a second taxed sell (bob) → dave now shares, bob excluded from his own
        uint256 bobPend = c.pendingRewards(bob);
        uint256 daveNet = c.balanceOnCurve(dave);
        BondingCurve.SellQuote memory sq2 = c.quoteSellFor(bob, ONE_PCT / 10);
        uint256 others2 = c.totalNet() - c.balanceOnCurve(bob);
        _sellT(c, t, bob, ONE_PCT / 10);
        if (sq2.profitTax > 0) {
            assertApproxEqRel(c.pendingRewards(dave), sq2.profitTax * daveNet / others2, 1e6, "dave shares 2nd");
            assertEq(c.pendingRewards(bob), bobPend, "bob excluded from own tax");
        }

        // claim (direct + via Launchpad)
        uint256 b0 = quote.balanceOf(carol);
        uint256 pc = c.pendingRewards(carol);
        vm.prank(carol);
        launchpad.claim(address(t));
        assertEq(quote.balanceOf(carol) - b0, pc);
        assertEq(c.pendingRewards(carol), 0);
        vm.prank(carol);
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        c.claim();
    }

    function test_pve_noTaxBelowThreshold() public {
        (BondingCurve c, Token t) = _launchMode(Constants.MODE_PVE);
        _open(8 minutes);
        _verify(alice);
        _verify(bob);
        _buyQ(c, alice, _quoteFor(c, ONE_PCT / 2));
        _buyQ(c, bob, _quoteFor(c, ONE_PCT / 2)); // small move, << 1.77x
        BondingCurve.SellQuote memory sq = c.quoteSellFor(alice, ONE_PCT / 4);
        assertEq(sq.profitTax, 0);
        uint256 avg0 = c.costBasisOf(alice) * 1e18 / c.balanceOnCurve(alice);
        _sellT(c, t, alice, ONE_PCT / 4);
        assertEq(c.pendingRewards(bob), 0);
        // cost basis shrinks pro-rata with the NET position (avg cost unchanged)
        assertApproxEqRel(c.costBasisOf(alice) * 1e18 / c.balanceOnCurve(alice), avg0, 1e9);
    }

    function test_pve_claimAfterGraduation() public {
        (BondingCurve c, Token t) = _launchMode(Constants.MODE_PVE);
        _open(8 minutes);
        _verify(alice);
        _verify(bob);
        _buyQ(c, alice, _quoteFor(c, ONE_PCT * 9 / 10));
        _buyQ(c, bob, _quoteFor(c, ONE_PCT * 9 / 10));
        _pump(c, 20_000);
        _sellT(c, t, alice, ONE_PCT / 2);
        uint256 pb = c.pendingRewards(bob);
        assertGt(pb, 0);
        // graduate with many verified wallets
        for (uint256 i; i < 120 && !c.graduated(); ++i) {
            address w = makeAddr(string(abi.encodePacked("g", vm.toString(i))));
            quote.mint(w, 10_000_000 ether);
            _verify(w);
            uint256 room = ONE_PCT - 1;
            uint256 left = _sc(c) - c.tokensSold();
            uint256 q = room < left ? _quoteFor(c, room * 99 / 100) : 1_000_000 ether;
            _buyQ(c, w, q);
        }
        assertTrue(c.graduated(), "graduated");
        assertEq(c.pendingRewards(bob), pb, "frozen at graduation");
        uint256 b0 = quote.balanceOf(bob);
        vm.prank(bob);
        c.claim();
        assertEq(quote.balanceOf(bob) - b0, pb);
    }

    // ── PVP ──

    function test_pvp_maxBuyAndGrowingNetCap() public {
        (BondingCurve c,) = _launchMode(Constants.MODE_PVP);
        _warpPastSnipe();
        assertEq(c.netCapNow(), Constants.TOTAL_SUPPLY * 400 / 10_000, "4% at launch");
        uint256 q = _quoteFor(c, ONE_PCT * 35 / 10); // 3.5% > 3.33%
        vm.startPrank(alice);
        quote.approve(address(c), q);
        vm.expectRevert(BondingCurve.BuyTooLarge.selector);
        c.buy(q, 0, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
        _buyQ(c, alice, _quoteFor(c, ONE_PCT * 3)); // 3%, no login needed
        uint256 q2 = _quoteFor(c, ONE_PCT * 15 / 10);
        vm.startPrank(alice);
        quote.approve(address(c), q2);
        vm.expectRevert(BondingCurve.WalletCap.selector); // 4.5% > ~4.x%
        c.buy(q2, 0, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
        // progress → cap grows linearly
        for (uint256 i; i < 12; ++i) {
            address w = makeAddr(string(abi.encodePacked("pvp", vm.toString(i))));
            quote.mint(w, 10_000_000 ether);
            _buyQ(c, w, _quoteFor(c, ONE_PCT * 3));
        }
        uint256 expectBps = 400 + (800 * c.tokensSold()) / _sc(c);
        assertEq(c.netCapNow(), Constants.TOTAL_SUPPLY * expectBps / 10_000);
        assertGt(expectBps, 500);
        _buyQ(c, alice, q2); // now fits
    }

    // ── router pass-through ──

    function test_router_passThroughPve() public {
        (BondingCurve c, Token t) = _launchMode(Constants.MODE_PVE);
        _open(8 minutes);
        _verify(alice);
        vm.startPrank(alice);
        quote.approve(address(router), type(uint256).max);
        t.approve(address(router), type(uint256).max);
        (uint256 qb,) = router.quoteBuyWithUsdg(address(t), 20 ether);
        uint256 out = router.buyWithUsdg(address(t), 20 ether, qb, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
        assertEq(out, qb, "quote == executed");
        assertEq(c.balanceOnCurve(alice), out, "NET booked to trader");
        assertEq(c.balanceOnCurve(address(router)), 0, "never the router");
        assertGt(c.costBasisOf(alice), 0, "cost basis to trader");
        vm.startPrank(alice);
        (uint256 qs,) = router.quoteSellToUsdg(address(t), out / 2);
        uint256 us = router.sellToUsdg(address(t), out / 2, qs, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
        assertEq(us, qs);
        assertEq(c.balanceOnCurve(alice), out - out / 2, "router sell debits trader");
        // unverified trader can't buy through the router either
        vm.startPrank(bob);
        quote.approve(address(router), type(uint256).max);
        vm.expectRevert(BondingCurve.NotVerified.selector);
        router.buyWithUsdg(address(t), 1 ether, 1, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
    }

    function test_router_capsApplyToTrader() public {
        (BondingCurve c, Token t) = _launchMode(Constants.MODE_PVP);
        _warpPastSnipe();
        uint256 q = _quoteFor(c, ONE_PCT * 35 / 10);
        vm.startPrank(alice);
        quote.approve(address(router), type(uint256).max);
        vm.expectRevert(BondingCurve.BuyTooLarge.selector);
        router.buyWithUsdg(address(t), q, 1, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
    }

    function test_router_untrustedCallerRejected() public {
        (BondingCurve c,) = _launchMode(Constants.MODE_TRENCH);
        vm.expectRevert(BondingCurve.NotRouter.selector);
        c.routerBuy(alice, 1 ether, 0, block.timestamp + 1, type(uint256).max);
        vm.expectRevert(BondingCurve.NotRouter.selector);
        c.routerSell(alice, 1 ether, 0, block.timestamp + 1, alice, type(uint256).max);
    }

    function test_router_trenchSellCreditsTraderNotRouter() public {
        (BondingCurve c, Token t) = _launchMode(Constants.MODE_TRENCH);
        _warpPastSnipe();
        vm.startPrank(alice);
        quote.approve(address(router), type(uint256).max);
        t.approve(address(router), type(uint256).max);
        uint256 out = router.buyWithUsdg(address(t), 50 ether, 1, vm.getBlockTimestamp() + 1 hours);
        router.sellToUsdg(address(t), out, 1, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
        assertEq(c.balanceOnCurve(alice), 0);
        assertEq(c.balanceOnCurve(address(router)), 0);
    }

    // ── DISCIPLE audit Medium-1: PVE NET positions follow transfers ──

    function _pveSetup() internal returns (BondingCurve c, Token t) {
        (c, t) = _launchMode(Constants.MODE_PVE);
        _open(8 minutes);
        _verify(alice);
        _verify(bob);
        _verify(carol);
        _verify(dave);
    }

    function test_pve_netFollowsTransfer_noPhantomRewards() public {
        (BondingCurve c, Token t) = _pveSetup();
        _buyQ(c, alice, _quoteFor(c, ONE_PCT * 8 / 10));
        _buyQ(c, carol, _quoteFor(c, ONE_PCT * 3 / 10));
        _pump(c, 20_000);
        uint256 aNet = c.balanceOnCurve(alice);
        uint256 aCost = c.costBasisOf(alice);
        uint256 tn = c.totalNet();
        uint256 bal = t.balanceOf(alice);
        vm.prank(alice);
        t.transfer(bob, bal);
        assertEq(c.balanceOnCurve(alice), 0, "sender NET moved");
        assertEq(c.costBasisOf(alice), 0);
        assertEq(c.balanceOnCurve(bob), aNet, "receiver NET");
        assertEq(c.costBasisOf(bob), aCost, "cost basis follows");
        assertEq(c.totalNet(), tn, "totalNet unchanged");
        // bob sells at a profit (inherited basis) → tax goes to real holders, not to alice (0 tokens)
        BondingCurve.SellQuote memory sq = c.quoteSellFor(bob, ONE_PCT * 4 / 10);
        assertGt(sq.profitTax, 0);
        _sellT(c, t, bob, ONE_PCT * 4 / 10);
        assertEq(c.pendingRewards(alice), 0, "no phantom rewards for a 0-balance wallet");
        assertGt(c.pendingRewards(carol), 0);
        assertEq(c.pendingRewards(bob), 0, "seller excluded");
    }

    function test_pve_transferSettlesRewardsBothSides() public {
        (BondingCurve c, Token t) = _pveSetup();
        _buyQ(c, alice, _quoteFor(c, ONE_PCT * 8 / 10));
        _buyQ(c, carol, _quoteFor(c, ONE_PCT * 6 / 10));
        _buyQ(c, dave, _quoteFor(c, ONE_PCT * 2 / 10));
        _pump(c, 20_000);
        _sellT(c, t, alice, ONE_PCT * 4 / 10); // taxed → carol + dave (+ pumpers) earn
        uint256 cp = c.pendingRewards(carol);
        uint256 dp = c.pendingRewards(dave);
        assertGt(cp, 0);
        uint256 half = t.balanceOf(carol) / 2;
        vm.prank(carol);
        t.transfer(dave, half);
        assertEq(c.pendingRewards(carol), cp, "sender's earned rewards kept");
        assertEq(c.pendingRewards(dave), dp, "receiver gets none of the past");
        assertEq(c.rewardsHeld(), quote.balanceOf(address(c)) - c.quoteReserve(), "reward pool fully backed");
    }

    function test_pve_transferReceiverNetCap() public {
        (BondingCurve c, Token t) = _pveSetup();
        _buyQ(c, alice, _quoteFor(c, ONE_PCT * 5 / 10));
        _buyQ(c, bob, _quoteFor(c, ONE_PCT * 9 / 10));
        uint256 bal = t.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(BondingCurve.WalletCap.selector);
        t.transfer(bob, bal);
        vm.prank(alice);
        t.transfer(bob, ONE_PCT / 20); // stays under 1%
    }

    function test_pve_hooksOffAfterGraduation_trenchNoHooks() public {
        (BondingCurve c, Token t) = _launchMode(Constants.MODE_PVE);
        assertTrue(t.pveHooks());
        assertEq(t.pveCurve(), address(c));
        assertTrue(t.pveLive());
        (, Token tt) = _launchMode(Constants.MODE_TRENCH);
        assertFalse(tt.pveHooks());
        assertEq(tt.pveCurve(), address(0));
        vm.expectRevert(Token.OnlyCurve.selector);
        t.endPveHooks();
        vm.expectRevert(BondingCurve.OnlyToken.selector);
        c.onTokenTransfer(alice, bob, 1);
    }

    // ── audit L1 / L2: login cache TTL + max attestation TTL ──

    function test_pve_revokeBitesAfterCacheTtl() public {
        (BondingCurve c,) = _pveSetup();
        _buyQ(c, alice, 1 ether);
        assertEq(c.verifiedUntilOf(alice), vm.getBlockTimestamp() + Constants.PVE_LOGIN_CACHE_TTL, "capped cache");
        vm.prank(owner);
        gate.revoke(alice, address(0));
        _buyQ(c, alice, 1 ether); // still cached
        vm.warp(vm.getBlockTimestamp() + Constants.PVE_LOGIN_CACHE_TTL);
        vm.startPrank(alice);
        quote.approve(address(c), 1 ether);
        vm.expectRevert(BondingCurve.NotVerified.selector);
        c.buy(1 ether, 0, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
    }

    function test_loginGate_maxTtl() public {
        uint64 exp = uint64(vm.getBlockTimestamp() + 24 hours + 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPk, gate.digest(alice, exp, address(0)));
        vm.expectRevert(LoginGate.TtlTooLong.selector);
        gate.attest(alice, exp, address(0), abi.encodePacked(r, s, v));
        exp = uint64(vm.getBlockTimestamp() + 24 hours);
        (v, r, s) = vm.sign(attesterPk, gate.digest(alice, exp, address(0)));
        gate.attest(alice, exp, address(0), abi.encodePacked(r, s, v));
    }

    // ── audit L3: router prepaid amounts are balance-checked ──

    function test_router_prepaidMustBeHere() public {
        (BondingCurve c, Token t) = _pveSetup();
        _buyQ(c, alice, _quoteFor(c, ONE_PCT / 2));
        assertEq(c.trustedRouter(), address(router), "router snapshotted");
        vm.startPrank(address(router));
        vm.expectRevert(BondingCurve.NotPrepaid.selector);
        c.routerBuy(bob, 10 ether, 0, vm.getBlockTimestamp() + 1, type(uint256).max);
        vm.expectRevert(BondingCurve.NotPrepaid.selector);
        c.routerSell(alice, 1e18, 0, vm.getBlockTimestamp() + 1, alice, type(uint256).max);
        vm.stopPrank();
        // honest prepay passes
        vm.prank(bob);
        quote.transfer(address(c), 10 ether);
        vm.prank(address(router));
        c.routerBuy(bob, 10 ether, 0, vm.getBlockTimestamp() + 1, type(uint256).max);
        assertGt(t.balanceOf(bob), 0);
    }

    // ── audit L6: profit tax with no other NET holder → treasury immediately ──

    function test_pve_soleHolderTaxToTreasury() public {
        (BondingCurve c, Token t) = _pveSetup();
        _buyQ(c, alice, _quoteFor(c, ONE_PCT * 8 / 10));
        _pump(c, 20_000);
        // white-box: make alice the only NET holder (pumpers' NET excluded) to reach the branch
        stdstore.target(address(c)).sig("totalNet()").checked_write(c.balanceOnCurve(alice));
        BondingCurve.SellQuote memory sq = c.quoteSellFor(alice, ONE_PCT * 4 / 10);
        assertGt(sq.profitTax, 0);
        uint256 tr0 = feeRouter.treasuryAccrued(address(quote));
        uint256 acc0 = c.accRewardPerToken();
        _sellT(c, t, alice, ONE_PCT * 4 / 10);
        assertEq(c.accRewardPerToken(), acc0, "not folded into later holders");
        assertEq(c.rewardsHeld(), 0);
        assertGe(feeRouter.treasuryAccrued(address(quote)) - tr0, sq.profitTax, "tax accrued to treasury");
    }

    // ── DISCIPLE audit round 3 HIGH: self-transfers must not touch NET / rewards ──

    function test_m1_selfTransferInflatesNet() public {
        (BondingCurve c, Token t) = _pveSetup();
        _buyQ(c, alice, _quoteFor(c, ONE_PCT * 5 / 10));
        uint256 net0 = c.balanceOnCurve(alice);
        uint256 tn0 = c.totalNet();
        uint256 cost0 = c.costBasisOf(alice);
        uint256 bal = t.balanceOf(alice);
        for (uint256 i; i < 4; ++i) {
            vm.prank(alice);
            t.transfer(alice, bal);
        }
        assertEq(c.balanceOnCurve(alice), net0, "NET unchanged");
        assertEq(c.totalNet(), tn0, "totalNet unchanged");
        assertEq(c.costBasisOf(alice), cost0, "basis unchanged");
        // and the curve rejects a forged self-notification even if a token ever sent one
        vm.prank(address(t));
        c.onTokenTransfer(alice, alice, bal);
        assertEq(c.balanceOnCurve(alice), net0);
    }

    function test_m1_selfTransferDoublesPending() public {
        (BondingCurve c, Token t) = _pveSetup();
        _buyQ(c, alice, _quoteFor(c, ONE_PCT * 8 / 10));
        _buyQ(c, carol, _quoteFor(c, ONE_PCT * 6 / 10));
        _pump(c, 20_000);
        _sellT(c, t, alice, ONE_PCT * 4 / 10); // taxed
        uint256 cp = c.pendingRewards(carol);
        uint256 held = c.rewardsHeld();
        assertGt(cp, 0);
        uint256 bal = t.balanceOf(carol);
        vm.prank(carol);
        t.transfer(carol, bal);
        vm.prank(carol);
        t.transferFrom(carol, carol, 0); // zero-value / self path
        assertEq(c.pendingRewards(carol), cp, "pending not doubled");
        assertEq(c.rewardsHeld(), held);
    }

    function test_m1_selfTransferUnbackedAccrual() public {
        (BondingCurve c, Token t) = _pveSetup();
        _buyQ(c, alice, _quoteFor(c, ONE_PCT * 8 / 10));
        _buyQ(c, carol, _quoteFor(c, ONE_PCT * 6 / 10));
        _buyQ(c, dave, _quoteFor(c, ONE_PCT * 3 / 10));
        _pump(c, 20_000);
        _sellT(c, t, alice, ONE_PCT * 4 / 10);
        address[2] memory hs = [carol, dave];
        for (uint256 k; k < 3; ++k) {
            for (uint256 j; j < 2; ++j) {
                uint256 b = t.balanceOf(hs[j]);
                vm.prank(hs[j]);
                t.transfer(hs[j], b);
            }
        }
        address[] memory all = _pveHolders(c);
        uint256 sum;
        for (uint256 j; j < all.length; ++j) sum += c.pendingRewards(all[j]);
        assertLe(sum, c.rewardsHeld() + all.length, "pending backed by rewardsHeld");
        for (uint256 j; j < all.length; ++j) {
            if (c.pendingRewards(all[j]) == 0) continue;
            vm.prank(all[j]);
            c.claim();
        }
        assertGe(quote.balanceOf(address(c)), c.quoteReserve(), "claims never dip into the reserve");
    }

    /// @dev every wallet that can hold NET in these tests: the 4 actors + the `_pump` wallets.
    function _pveHolders(BondingCurve c) internal returns (address[] memory hs) {
        hs = new address[](64);
        hs[0] = alice;
        hs[1] = bob;
        hs[2] = carol;
        hs[3] = dave;
        uint256 n = 4;
        for (uint256 i; i < 60; ++i) {
            address w = makeAddr(string(abi.encodePacked("pump", vm.toString(i))));
            if (c.balanceOnCurve(w) == 0 && c.pendingRewards(w) == 0 && IERC20(c.token()).balanceOf(w) == 0) break;
            hs[n++] = w;
        }
        assembly {
            mstore(hs, n)
        }
    }

    function _checkPveInvariants(BondingCurve c, address[] memory hs) internal view {
        uint256 sumNet;
        uint256 sumPending;
        for (uint256 j; j < hs.length; ++j) {
            sumNet += c.balanceOnCurve(hs[j]);
            sumPending += c.pendingRewards(hs[j]);
        }
        assertEq(sumNet, c.totalNet(), "NET conservation");
        // each pendingRewards floors separately → allow ≤ 1 wei per holder of rounding in the protocol's favour
        assertLe(sumPending, c.rewardsHeld() + hs.length, "sum(pending) <= rewardsHeld");
        assertGe(quote.balanceOf(address(c)), c.quoteReserve() + c.rewardsHeld(), "curve solvent");
    }

    /// Random buys / sells / transfers (incl. self) / claims: NET conserved, rewards always backed.
    /// forge-config: default.fuzz.runs = 24
    function testFuzz_pveRewardsInvariant(uint256[] calldata ops) public {
        vm.assume(ops.length > 0);
        (BondingCurve c, Token t) = _pveSetup();
        _buyQ(c, alice, _quoteFor(c, ONE_PCT * 8 / 10));
        _buyQ(c, carol, _quoteFor(c, ONE_PCT * 5 / 10));
        _pump(c, 20_000);
        address[] memory hs = _pveHolders(c);
        _sellT(c, t, alice, ONE_PCT * 3 / 10); // seed the reward pool
        _checkPveInvariants(c, hs);
        uint256 n = ops.length > 24 ? 24 : ops.length;
        for (uint256 i; i < n; ++i) {
            uint256 op = ops[i];
            address a = hs[op % hs.length];
            address b = hs[(op >> 8) % hs.length];
            uint256 kind = (op >> 16) % 5;
            uint256 bal = t.balanceOf(a);
            uint256 amt = bal * ((op >> 24) % 10_001) / 10_000;
            vm.startPrank(a);
            if (kind == 0) {
                uint256 q = ((op >> 40) % 2_000 + 1) * 1 ether;
                quote.mint(a, q);
                quote.approve(address(c), q);
                try c.buy(q, 0, vm.getBlockTimestamp() + 1) {} catch {}
            } else if (kind == 1) {
                t.approve(address(c), amt);
                try c.sell(amt, 0, vm.getBlockTimestamp() + 1) {} catch {}
            } else if (kind == 2) {
                try t.transfer(b, amt) {} catch {}
            } else if (kind == 3) {
                t.transfer(a, amt);
            } else if (c.pendingRewards(a) != 0) {
                c.claim();
            }
            vm.stopPrank();
            _checkPveInvariants(c, hs);
        }
    }

    // ── audit round 3 (ops): kill switch for a curve's cached trusted router ──
    function test_router_killSwitch() public {
        (BondingCurve c, Token t) = _launchMode(Constants.MODE_TRENCH);
        _open(8 minutes);
        assertEq(c.trustedRouter(), address(router));
        quote.mint(alice, 100 ether);
        vm.prank(alice);
        quote.approve(address(router), type(uint256).max);
        address[] memory cs = new address[](1);
        cs[0] = address(c);
        vm.prank(alice);
        vm.expectRevert(Launchpad.OnlyOwner.selector);
        launchpad.setCurveRouterKilled(cs, true);
        vm.expectRevert(BondingCurve.OnlyLaunchpad.selector);
        c.setRouterKilled(true);
        vm.prank(owner);
        launchpad.setCurveRouterKilled(cs, true);
        assertTrue(c.routerKilled());
        vm.prank(alice);
        vm.expectRevert(); // NotRouter (bubbled through the router)
        router.buyWithUsdg(address(t), 10 ether, 1, vm.getBlockTimestamp() + 1 hours);
        // direct curve trades unaffected
        _buyQ(c, alice, 1 ether);
        vm.prank(owner);
        launchpad.setCurveRouterKilled(cs, false);
        vm.prank(alice);
        router.buyWithUsdg(address(t), 10 ether, 1, vm.getBlockTimestamp() + 1 hours);
    }
}
