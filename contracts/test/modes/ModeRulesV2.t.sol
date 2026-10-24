// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase, MockUSDG} from "../integration/IntegrationBase.sol";
import {Vm} from "forge-std/Vm.sol";
import {Owned2Step} from "../../src/utils/Owned2Step.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {LoginGate} from "../../src/LoginGate.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {DiscipleRouter} from "../../src/DiscipleRouter.sol";
import {MarketLens} from "../../src/addons/MarketLens.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {Constants} from "../../src/libraries/Constants.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";
import {CurveMath} from "../../src/libraries/CurveMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Mode rules v2 matrix (contracts/docs/mode-rules-v2.md): Easy (PVE) / Hard (PVP) holding caps that grow
///         with mcap, partial fill (direct + router USDG), sniper tax 99%→0 over 77 s into a per-curve escrow
///         (→ locked LP at graduation / → RewardsVault after 30 days), Easy creator lock, Easy crew tip, rules off
///         after graduation, TRENCH unchanged except the sniper tax; plus DiscipleRouter.launchWithUsdg and
///         claimCreatorFeesToUsdg.
contract ModeRulesV2Test is IntegrationBase {
    LoginGate gate;
    MarketLens lens;
    uint256 attesterPk = 0xA77E57;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    uint256 constant ONE_PCT = Constants.TOTAL_SUPPLY / 100;
    uint256 walletNonce;

    event BuyRefunded(
        address indexed token, address indexed trader, uint256 tokensOut, uint256 quoteRefund, bool capped
    );
    event ProfitTaxCharged(
        address indexed token, address indexed seller, uint256 tax, uint256 grossQuote, uint256 costBasis
    );
    event UsdgLaunch(
        address indexed creator, address indexed token, uint256 usdgIn, uint256 quoteIn, uint256 tokensBought
    );

    function setUp() public override {
        super.setUp();
        gate = new LoginGate(owner, vm.addr(attesterPk));
        vm.prank(owner);
        launchpad.setLoginGate(address(gate));
        router.setUsdgRouting(address(quote), address(launchpad));
        router.setUsdgPool(address(strategy), strategyUsdgKey);
        lens = new MarketLens(address(launchpad), address(migration));
        address[5] memory ws = [alice, bob, carol, dave, creator];
        for (uint256 i; i < 5; ++i) {
            quote.mint(ws[i], 10_000_000 ether);
            strategy.mint(ws[i], 10_000_000 ether);
            _verify(ws[i]);
        }
    }

    // ───────── helpers ─────────

    function _params(address q, uint256 creatorBuy) internal view returns (ILaunchpad.LaunchParams memory) {
        return ILaunchpad.LaunchParams({
            name: "Rules",
            ticker: "RLS",
            imageURI: "ipfs://img",
            description: "",
            socialsURI: "",
            quote: q,
            creatorTaxBps: 0,
            creatorBuyQuoteIn: creatorBuy,
            creatorBuyMinTokensOut: 0,
            deadline: vm.getBlockTimestamp() + 1 days
        });
    }

    function _launchM(uint8 m, address q, uint256 creatorBuy)
        internal
        returns (BondingCurve c, Token t, ILaunchpad.LaunchResult memory r)
    {
        vm.startPrank(creator);
        if (creatorBuy != 0) IERC20(q).approve(address(launchpad), creatorBuy);
        r = launchpad.launchWithMode(_params(q, creatorBuy), m);
        vm.stopPrank();
        c = BondingCurve(r.curve);
        t = Token(r.token);
    }

    function _launchM(uint8 m) internal returns (BondingCurve c, Token t) {
        (c, t,) = _launchM(m, address(quote), 0);
    }

    function _verify(address w) internal {
        uint64 exp = uint64(vm.getBlockTimestamp() + 24 hours);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPk, gate.digest(w, exp, address(0)));
        gate.attest(w, exp, address(0), abi.encodePacked(r, s, v));
    }

    function _fresh() internal returns (address w) {
        w = makeAddr(string(abi.encodePacked("w", vm.toString(++walletNonce))));
        quote.mint(w, 10_000_000 ether);
        _verify(w);
    }

    function _buyQ(BondingCurve c, address w, uint256 q) internal returns (uint256 out) {
        MockUSDG qt = MockUSDG(c.quote());
        vm.startPrank(w);
        qt.approve(address(c), q);
        out = c.buy(q, 0, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
    }

    function _sellT(BondingCurve c, address w, uint256 n) internal returns (uint256 out) {
        vm.startPrank(w);
        IERC20(c.token()).approve(address(c), n);
        out = c.sell(n, 0, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
    }

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

    /// @dev pump mcap up to `targetUsd` with fresh (verified) wallets buying `chunk` each (partial fill applies).
    function _pumpTo(BondingCurve c, uint256 targetUsd, uint256 chunk) internal {
        for (uint256 i; i < 200 && !c.graduated() && c.marketCapUsd() < targetUsd; ++i) {
            _buyQ(c, _fresh(), chunk);
        }
    }

    function _grad(BondingCurve c) internal {
        for (uint256 i; i < 200 && !c.graduated(); ++i) {
            _buyQ(c, _fresh(), 1_000_000 ether);
        }
        assertTrue(c.graduated(), "graduated");
    }

    function _expectedCap(uint8 m, uint256 mc) internal pure returns (uint256) {
        (uint256 a, uint256 b) = m == Constants.MODE_PVE
            ? (Constants.PVE_CAP_START_BPS, Constants.PVE_CAP_END_BPS)
            : (Constants.PVP_CAP_START_BPS, Constants.PVP_CAP_END_BPS);
        uint256 s = Constants.TOTAL_SUPPLY;
        if (mc <= Constants.START_MCAP_USD) return s * a / 10_000;
        if (mc >= Constants.GRADUATION_MCAP_USD) return s * b / 10_000;
        return s * a / 10_000
            + Math.mulDiv(
                s * (b - a),
                mc - Constants.START_MCAP_USD,
                10_000 * (Constants.GRADUATION_MCAP_USD - Constants.START_MCAP_USD)
            );
    }

    function _mode(uint256 seed) internal pure returns (uint8) {
        return uint8(seed % 3);
    }

    // ───────── deployment ─────────

    /// The chunked CurveDeployer must deploy byte-for-byte the same runtime as `new BondingCurve(...)`.
    function test_curveDeployer_runtimeIdenticalToNew() public {
        (BondingCurve c, Token t) = _launchM(Constants.MODE_PVE);
        (uint256 ts, uint256 sc, uint256 x0, uint256 y0) = c.curveParams();
        CurveMath.Params memory p = CurveMath.Params(ts, sc, x0, y0, c.quotePriceUsd(), c.curveTail());
        vm.prank(address(launchpad));
        BondingCurve ref = new BondingCurve(
            address(t),
            address(quote),
            creator,
            address(launchpad),
            address(feeRouter),
            address(migration),
            c.creatorTaxBps(),
            p,
            c.walletCapBps(),
            c.mode(),
            c.loginGate(),
            c.trustedRouter(),
            c.crewTipThresholdBps(),
            c.snipeEscrowTimeout()
        );
        assertEq(keccak256(address(c).code), keccak256(address(ref).code), "same runtime incl. immutables");
        assertLe(address(c).code.length, 24_576, "EIP-170");
    }

    // ───────── caps ─────────

    function test_capGrowth_easy() public {
        _capGrowth(Constants.MODE_PVE, Constants.PVE_CAP_START_BPS, Constants.PVE_CAP_END_BPS);
    }

    function test_capGrowth_hard() public {
        _capGrowth(Constants.MODE_PVP, Constants.PVP_CAP_START_BPS, Constants.PVP_CAP_END_BPS);
    }

    function _capGrowth(uint8 m, uint256 a, uint256 b) internal {
        (BondingCurve c, Token t) = _launchM(m);
        assertEq(c.netCapNow(), Constants.TOTAL_SUPPLY * a / 10_000, "start cap at $7K");
        (uint256 bps, uint256 capT) = lens.capNow(address(t));
        assertEq(bps, a);
        assertEq(capT, c.netCapNow());
        vm.warp(vm.getBlockTimestamp() + 61);
        uint256 prev = c.netCapNow();
        uint256[3] memory targets = [uint256(12_000e18), 20_000e18, 30_000e18];
        for (uint256 k; k < 3; ++k) {
            _pumpTo(c, targets[k], 200 ether);
            uint256 cap = c.netCapNow();
            assertApproxEqRel(cap, _expectedCap(m, c.marketCapUsd()), 1e6, "linear in mcap");
            assertGt(cap, prev, "grows");
            assertLt(cap, Constants.TOTAL_SUPPLY * b / 10_000, "below the end cap pre-graduation");
            prev = cap;
        }
        assertEq(lens.capRoom(address(t), alice), c.capRoom(alice));
        (, uint256 sCurve,,) = c.curveParams();
        assertEq(c.capRoom(alice), Math.min(c.netCapNow(), sCurve - c.tokensSold()), "fresh wallet: full cap (or curve left)");
    }

    /// forge-config: default.fuzz.runs = 32
    function testFuzz_capFormula(uint256 modeSeed, uint256 buys, uint256 chunk) public {
        uint8 m = modeSeed % 2 == 0 ? Constants.MODE_PVE : Constants.MODE_PVP;
        (BondingCurve c,) = _launchM(m);
        vm.warp(vm.getBlockTimestamp() + 61);
        uint256 n = bound(buys, 0, 25);
        chunk = bound(chunk, 1 ether, 200 ether);
        uint256 prev = c.netCapNow();
        for (uint256 i; i < n && !c.graduated(); ++i) {
            _buyQ(c, _fresh(), chunk);
            if (c.graduated()) break;
            uint256 cap = c.netCapNow();
            assertApproxEqRel(cap, _expectedCap(m, c.marketCapUsd()), 1e6);
            assertGe(cap, prev, "monotone in mcap (buys only)");
            prev = cap;
        }
    }

    // ───────── partial fill ─────────

    function test_partialFill_direct_emitsAndRefunds() public {
        (BondingCurve c, Token t) = _launchM(Constants.MODE_PVP);
        vm.warp(vm.getBlockTimestamp() + 61);
        uint256 cap = c.netCapNow();
        uint256 q = 1_000 ether;
        BondingCurve.BuyQuote memory bq = c.quoteBuyFor(alice, q);
        assertEq(bq.tokensOut, cap, "quoteBuyFor clamps");
        assertGt(bq.refund, 0);
        uint256 b0 = quote.balanceOf(alice);
        vm.startPrank(alice);
        quote.approve(address(c), q);
        vm.expectEmit(true, true, false, true, address(c));
        emit BuyRefunded(address(t), alice, cap, bq.refund, true);
        uint256 out = c.buy(q, cap, vm.getBlockTimestamp() + 1); // minTokensOut applies to the filled amount
        vm.stopPrank();
        assertEq(out, cap);
        assertEq(b0 - quote.balanceOf(alice), q - bq.refund, "charged only what the fill needs");
        assertEq(quote.balanceOf(address(c)), c.quoteReserve() + c.snipeEscrow() + c.rewardsHeld(), "no stray quote");
    }

    function test_partialFill_minOutAboveFillReverts() public {
        (BondingCurve c,) = _launchM(Constants.MODE_PVP);
        vm.warp(vm.getBlockTimestamp() + 61);
        uint256 cap = c.netCapNow();
        vm.startPrank(alice);
        quote.approve(address(c), 1_000 ether);
        vm.expectRevert(BondingCurve.Slippage.selector);
        c.buy(1_000 ether, cap + 1, vm.getBlockTimestamp() + 1);
        vm.stopPrank();
    }

    function test_partialFill_routerUsdg_pairCoinSwappedBack() public {
        (BondingCurve c, Token t,) = _launchM(Constants.MODE_PVE, address(strategy), 0); // STRATEGY pair: 2 hops
        vm.warp(vm.getBlockTimestamp() + 61);
        uint256 cap = c.netCapNow();
        uint256 usdgIn = 1_000 ether;
        uint256 u0 = quote.balanceOf(alice);
        vm.startPrank(alice);
        quote.approve(address(router), type(uint256).max);
        uint256 out = router.buyWithUsdg(address(t), usdgIn, 1, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
        assertEq(out, cap, "filled to the Easy cap");
        assertEq(c.balanceOnCurve(alice), cap, "NET booked to the trader");
        uint256 spent = u0 - quote.balanceOf(alice);
        assertLt(spent, usdgIn / 2, "unused pair coin swapped back to USDG");
        assertGt(spent, 0);
        assertEq(quote.balanceOf(address(router)), 0, "router usdg dust");
        assertEq(strategy.balanceOf(address(router)), 0, "router pair-coin dust");
        assertEq(t.balanceOf(address(router)), 0);
    }

    function test_partialFill_routerUsdg_usdgPair() public {
        (BondingCurve c, Token t) = _launchM(Constants.MODE_PVP);
        vm.warp(vm.getBlockTimestamp() + 61);
        uint256 cap = c.netCapNow();
        uint256 u0 = quote.balanceOf(bob);
        vm.startPrank(bob);
        quote.approve(address(router), type(uint256).max);
        uint256 out = router.buyWithUsdg(address(t), 2_000 ether, 1, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
        assertEq(out, cap);
        assertLt(u0 - quote.balanceOf(bob), 2_000 ether);
        assertEq(quote.balanceOf(address(router)), 0);
    }

    /// Partial fill, any mode (TRENCH with the legacy walletCapBps so it binds): quoteBuyFor == executed, spend +
    /// refund == input, out <= room, a refund means out == room, the spend is minimal, NET <= pre-trade cap.
    /// forge-config: default.fuzz.runs = 64
    function testFuzz_partialFill(uint256 modeSeed, uint256 pre, uint256 qIn, uint256 dt) public {
        uint8 m = _mode(modeSeed);
        if (m == Constants.MODE_TRENCH) {
            vm.prank(owner);
            launchpad.setWalletCapBps(300);
        }
        (BondingCurve c,) = _launchM(m);
        vm.warp(vm.getBlockTimestamp() + bound(dt, 0, 90)); // inside or after the sniper window
        pre = bound(pre, 0, 400 ether);
        if (pre < 1e9) pre = 0; // dust pre-buys under the 99% sniper tax round to 0 tokens (ZeroAmount)
        if (pre != 0) _buyQ(c, alice, pre);
        qIn = bound(qIn, 1e9, 20_000 ether);
        uint256 room = c.capRoom(alice);
        uint256 cap = c.netCapNow();
        vm.startPrank(alice);
        quote.approve(address(c), qIn);
        if (room == 0) {
            vm.expectRevert(BondingCurve.WalletCap.selector);
            c.buy(qIn, 0, vm.getBlockTimestamp() + 1);
            vm.stopPrank();
            return;
        }
        vm.stopPrank();
        BondingCurve.BuyQuote memory bq = c.quoteBuyFor(alice, qIn);
        if (bq.refund > 0) {
            uint256 sp = qIn - bq.refund;
            // steep curve: the uncapped Newton inverse may stop a few quote-wei short (dust, pool-favoured); the capped
            // fill lands exactly on the room. Tolerance 1e-12 relative + 1e3 wei.
            assertGe(c.quoteBuy(sp).tokensOut + bq.tokensOut / 1e12 + 1e3, bq.tokensOut, "the spend fills the room");
            if (sp > 1e9) {
                assertLt(c.quoteBuy(sp - sp / 1e9 - 2).tokensOut, bq.tokensOut, "minimal spend (1e-9 rel)");
            }
        }
        uint256 net0 = c.balanceOnCurve(alice);
        uint256 b0 = quote.balanceOf(alice);
        vm.prank(alice);
        uint256 out = c.buy(qIn, 0, vm.getBlockTimestamp() + 1);
        uint256 spent = b0 - quote.balanceOf(alice);
        assertEq(out, bq.tokensOut, "quote == executed");
        assertEq(spent + bq.refund, qIn, "spend + refund == input");
        assertLe(out, room, "never above room");
        if (bq.refund > 0) assertEq(out, room, "refund only when capped");
        if (cap != type(uint256).max) assertLe(net0 + out, cap, "NET <= pre-trade cap");
        if (!c.graduated()) {
            assertEq(
                quote.balanceOf(address(c)), c.quoteReserve() + c.snipeEscrow() + c.rewardsHeld(), "accounting closes"
            );
        }
    }

    // ───────── sniper tax ─────────

    function test_sniperDecay_allModes_firstBoostExempt() public {
        for (uint8 m; m < 3; ++m) {
            (BondingCurve c, Token t,) = _launchM(m, address(quote), 10 ether);
            assertEq(c.snipeEscrow(), 0, "First BOOST exempt");
            assertEq(c.currentSnipeFeeBps(), 9900, "99% at launch");
            (uint256 bps, uint256 left) = lens.sniperTax(address(t));
            assertEq(bps, 9900);
            assertEq(left, 77);
            uint256 t0 = c.launchTime();
            uint256 e0 = c.snipeEscrow();
            _buyQ(c, bob, 1 ether);
            assertEq(c.snipeEscrow() - e0, 0.99 ether, "same block: 99%");
            vm.warp(t0 + 15);
            assertEq(c.currentSnipeFeeBps(), 9900 - uint256(9900 * 15) / 77);
            vm.warp(t0 + 38);
            assertEq(c.currentSnipeFeeBps(), 9900 - uint256(9900 * 38) / 77, "~halfway"); // 5015
            e0 = c.snipeEscrow();
            _buyQ(c, carol, 1 ether);
            assertEq(c.snipeEscrow() - e0, 0.5015 ether);
            vm.warp(t0 + 76);
            assertEq(c.currentSnipeFeeBps(), 9900 - uint256(9900 * 76) / 77); // 129
            vm.warp(t0 + 77);
            assertEq(c.currentSnipeFeeBps(), 0, "0 after 77 s");
            (bps, left) = lens.sniperTax(address(t));
            assertEq(left, 0);
            e0 = c.snipeEscrow();
            _buyQ(c, dave, 1 ether);
            assertEq(c.snipeEscrow(), e0, "no tax after the window");
            vm.warp(t0); // next mode launches at the same clock
        }
    }

    function test_sniperEscrow_toLP_atGraduation_hard() public {
        (BondingCurve c, Token t) = _launchM(Constants.MODE_PVP);
        _buyQ(c, bob, 50 ether);
        uint256 esc = c.snipeEscrow();
        assertGt(esc, 0);
        (uint256 amt, uint256 at, bool rel) = lens.snipeEscrow(address(t));
        assertEq(amt, esc);
        assertEq(at, c.launchTime() + 30 days);
        assertFalse(rel);
        vm.warp(vm.getBlockTimestamp() + 61);
        _grad(c);
        assertEq(c.snipeEscrow(), 0);
        assertEq(quote.balanceOf(address(c)), c.rewardsHeld(), "everything migrated");
        vm.warp(c.launchTime() + 30 days);
        vm.expectRevert(BondingCurve.Graduated.selector);
        c.releaseSnipeEscrow();
    }

    function test_sniperEscrow_toVault_afterTimeout_easy() public {
        (BondingCurve c, Token t) = _launchM(Constants.MODE_PVE);
        _buyQ(c, bob, 5 ether);
        uint256 esc = c.snipeEscrow();
        vm.warp(c.launchTime() + c.snipeEscrowTimeout() - 1);
        vm.expectRevert(BondingCurve.EscrowLocked.selector);
        c.releaseSnipeEscrow();
        (,, bool rel) = lens.snipeEscrow(address(t));
        assertFalse(rel);
        vm.warp(c.launchTime() + c.snipeEscrowTimeout());
        (,, rel) = lens.snipeEscrow(address(t));
        assertTrue(rel);
        uint256 v0 = quote.balanceOf(address(rewardsVault));
        vm.prank(dave);
        c.releaseSnipeEscrow();
        assertEq(quote.balanceOf(address(rewardsVault)) - v0, esc);
        assertEq(c.snipeEscrow(), 0);
    }

    // ───────── creator lock (Easy) ─────────

    function test_creatorLock_easy() public {
        (BondingCurve c, Token t, ILaunchpad.LaunchResult memory r) =
            _launchM(Constants.MODE_PVE, address(quote), 200 ether);
        uint256 locked = r.creatorTokensBought;
        assertEq(locked, Constants.TOTAL_SUPPLY * Constants.FIRST_BOOST_MAX_BPS_PVE / 10_000, "1.2% max");
        assertEq(t.creatorLocked(), locked);
        assertTrue(t.creatorLockActive());
        (address cr, uint256 l, bool unlocked) = lens.creatorLock(address(t));
        assertEq(cr, creator);
        assertEq(l, locked);
        assertFalse(unlocked);
        // can't transfer or sell any of it
        vm.prank(creator);
        vm.expectRevert(Token.CreatorLocked.selector);
        t.transfer(bob, 1);
        vm.startPrank(creator);
        t.approve(address(c), 1);
        vm.expectRevert(Token.CreatorLocked.selector);
        c.sell(1, 0, vm.getBlockTimestamp() + 1);
        vm.stopPrank();
        // only the curve can set it, once
        vm.expectRevert(Token.OnlyCurve.selector);
        t.lockCreator(1);
        vm.prank(address(c));
        vm.expectRevert(Token.AlreadySet.selector);
        t.lockCreator(1);
        // First BOOST counts in NET (1.2% > the 1% cap): no room until mcap grows
        assertEq(c.capRoom(creator), 0);
        vm.warp(vm.getBlockTimestamp() + 61);
        _pumpTo(c, 15_000e18, 200 ether);
        assertGt(c.capRoom(creator), 0);
        uint256 extra = _buyQ(c, creator, 20 ether); // later buys stay free
        vm.prank(creator);
        t.transfer(bob, extra / 2);
        _sellT(c, creator, extra - extra / 2);
        assertEq(t.balanceOf(creator), locked);
        vm.prank(creator);
        vm.expectRevert(Token.CreatorLocked.selector);
        t.transfer(bob, 1);
        // the lock is keyed on the original launcher, not the transferable fee-creator role
        vm.prank(creator);
        launchpad.transferCreator(address(t), dave);
        vm.prank(creator);
        vm.expectRevert(Token.CreatorLocked.selector);
        t.transfer(dave, 1);
        // lifted at graduation
        _grad(c);
        assertFalse(t.creatorLockActive());
        (,, unlocked) = lens.creatorLock(address(t));
        assertTrue(unlocked);
        vm.prank(creator);
        t.transfer(bob, locked);
        assertEq(t.balanceOf(creator), 0);
    }

    function test_noCreatorLock_hard_trench() public {
        for (uint8 m = 0; m < 3; m += 2) {
            (, Token t, ILaunchpad.LaunchResult memory r) = _launchM(m, address(quote), 500 ether);
            uint256 maxBps = m == Constants.MODE_PVP ? Constants.FIRST_BOOST_MAX_BPS_PVP : launchpad.creatorBuyMaxBps();
            assertEq(launchpad.firstBoostMaxBps(m), maxBps);
            assertEq(r.creatorTokensBought, Constants.TOTAL_SUPPLY * maxBps / 10_000, "First BOOST max per mode");
            assertEq(t.creatorLocked(), 0);
            (,, bool unlocked) = lens.creatorLock(address(t));
            assertTrue(unlocked);
            vm.prank(creator);
            t.transfer(bob, r.creatorTokensBought); // freely transferable
        }
    }

    function test_firstBoost_quotePerMode() public view {
        for (uint8 m; m < 3; ++m) {
            uint256 maxT = Constants.TOTAL_SUPPLY * launchpad.firstBoostMaxBps(m) / 10_000;
            (uint256 out,,,, bool ex) = launchpad.quoteCreatorBuy(address(quote), 1_000 ether, 0, m);
            assertEq(out, maxT, "clamped to the mode max");
            assertTrue(ex, "partial fill flagged");
            (out,,,, ex) = launchpad.quoteCreatorBuy(address(quote), 1 ether, 0, m);
            assertLt(out, maxT);
            assertFalse(ex);
        }
    }

    // ───────── crew tip (Easy) ─────────

    function _tipped(BondingCurve c, address w, uint256 n) internal view returns (bool) {
        return c.quoteSellFor(w, n).profitTax > 0;
    }

    function test_crewTip_thresholdEdges() public {
        (BondingCurve c, Token t) = _launchM(Constants.MODE_PVE);
        assertEq(c.crewTipThresholdBps(), Constants.CREW_TIP_THRESHOLD_BPS_DEFAULT, "0.5% default");
        vm.warp(vm.getBlockTimestamp() + 61);
        _buyQ(c, alice, 1_000 ether); // fills to the 1% cap
        _buyQ(c, bob, 30 ether);
        _pumpTo(c, 25_000e18, 200 ether);
        uint256 bal = t.balanceOf(alice);
        assertFalse(_tipped(c, alice, bal / 1000), "small sale: profit < 0.5% of mcap");
        assertTrue(_tipped(c, alice, bal), "whole position: profit > 0.5% of mcap");
        uint256 lo = bal / 1000;
        uint256 hi = bal;
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            if (_tipped(c, alice, mid)) hi = mid;
            else lo = mid;
        }
        // lens agrees: profit(lo) <= threshold < profit(hi)
        (uint256 tipLo,, uint256 pLo, uint256 thr) = lens.crewTipEstimate(address(t), alice, lo);
        (uint256 tipHi, uint256 outHi, uint256 pHi, uint256 thr2) = lens.crewTipEstimate(address(t), alice, hi);
        assertEq(thr, thr2);
        assertEq(thr, Math.mulDiv(c.marketCapQuote(), 50, 10_000), "0.5% of mcap");
        assertEq(tipLo, 0);
        assertLe(pLo, thr);
        assertGt(pHi, thr);
        assertEq(tipHi, (outHi + tipHi) * 7770 / 1e6, "0.777% of proceeds");

        uint256 snap = vm.snapshotState();
        uint256 held0 = c.rewardsHeld();
        _sellT(c, alice, lo);
        assertEq(c.rewardsHeld(), held0, "at the threshold: no tip");
        vm.revertToState(snap);
        vm.prank(alice);
        t.approve(address(c), hi);
        vm.expectEmit(true, true, false, false, address(c));
        emit ProfitTaxCharged(address(t), alice, tipHi, 0, 0);
        vm.prank(alice);
        uint256 got = c.sell(hi, 0, vm.getBlockTimestamp() + 1 hours);
        assertEq(got, outHi, "net of the tip");
        assertEq(c.rewardsHeld() - held0, tipHi, "tip to the holders claim pool");
        assertEq(c.pendingRewards(alice), 0, "seller excluded");
        assertGt(c.pendingRewards(bob), 0, "holders earn it");
    }

    function test_crewTip_lossOrBelow_noTip_andHardTrenchNever() public {
        (BondingCurve e, Token te) = _launchM(Constants.MODE_PVE);
        (BondingCurve h, Token th) = _launchM(Constants.MODE_PVP);
        (BondingCurve tr,) = _launchM(Constants.MODE_TRENCH);
        vm.warp(vm.getBlockTimestamp() + 61);
        _buyQ(e, alice, 1_000 ether);
        _buyQ(h, alice, 1_000 ether);
        _buyQ(tr, alice, 50 ether);
        // immediate round trip: a loss (fees) → no tip
        assertEq(e.quoteSellFor(alice, te.balanceOf(alice)).profitTax, 0, "loss: no tip");
        _pumpTo(h, 25_000e18, 200 ether);
        _pumpTo(tr, 25_000e18, 200 ether);
        assertEq(h.quoteSellFor(alice, th.balanceOf(alice)).profitTax, 0, "Hard: no crew tip");
        assertEq(tr.quoteSellFor(alice, IERC20(tr.token()).balanceOf(alice)).profitTax, 0, "TRENCH: none");
        (uint256 tip,,,) = lens.crewTipEstimate(address(th), alice, th.balanceOf(alice));
        assertEq(tip, 0);
    }

    function test_crewTip_thresholdTunable_snapshotted() public {
        (BondingCurve a,) = _launchM(Constants.MODE_PVE);
        vm.startPrank(owner);
        vm.expectRevert(Launchpad.CrewTipThresholdOutOfBounds.selector);
        launchpad.setCrewTipThresholdBps(Constants.CREW_TIP_THRESHOLD_BPS_MIN - 1);
        vm.expectRevert(Launchpad.CrewTipThresholdOutOfBounds.selector);
        launchpad.setCrewTipThresholdBps(Constants.CREW_TIP_THRESHOLD_BPS_MAX + 1);
        launchpad.setCrewTipThresholdBps(200);
        vm.stopPrank();
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        launchpad.setCrewTipThresholdBps(100);
        (BondingCurve b,) = _launchM(Constants.MODE_PVE);
        assertEq(a.crewTipThresholdBps(), 50, "existing coin keeps its snapshot");
        assertEq(b.crewTipThresholdBps(), 200);
    }

    function test_snipeEscrowTimeout_tunable_snapshotted() public {
        (BondingCurve a,) = _launchM(Constants.MODE_PVP);
        assertEq(a.snipeEscrowTimeout(), 30 days, "default 30 days");
        vm.startPrank(owner);
        vm.expectRevert(Launchpad.SnipeEscrowTimeoutOutOfBounds.selector);
        launchpad.setSnipeEscrowTimeout(Constants.SNIPE_ESCROW_TIMEOUT_MIN - 1);
        vm.expectRevert(Launchpad.SnipeEscrowTimeoutOutOfBounds.selector);
        launchpad.setSnipeEscrowTimeout(Constants.SNIPE_ESCROW_TIMEOUT_MAX + 1);
        launchpad.setSnipeEscrowTimeout(7 days);
        vm.stopPrank();
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        launchpad.setSnipeEscrowTimeout(2 days);
        (BondingCurve b, Token tb) = _launchM(Constants.MODE_PVP);
        assertEq(a.snipeEscrowTimeout(), 30 days, "existing coin keeps its snapshot");
        assertEq(b.snipeEscrowTimeout(), 7 days);
        _buyQ(b, bob, 10 ether);
        assertGt(b.snipeEscrow(), 0);
        (,, bool rel) = lens.snipeEscrow(address(tb));
        assertFalse(rel);
        vm.warp(b.launchTime() + 7 days - 1);
        vm.expectRevert(BondingCurve.EscrowLocked.selector);
        b.releaseSnipeEscrow();
        vm.warp(b.launchTime() + 7 days);
        (, uint256 at, bool rel2) = lens.snipeEscrow(address(tb));
        assertEq(at, b.launchTime() + 7 days);
        assertTrue(rel2);
        b.releaseSnipeEscrow();
        assertEq(b.snipeEscrow(), 0);
    }

    // ───────── rules off after graduation ─────────

    function test_rulesOffAfterGraduation_easy() public {
        (BondingCurve c, Token t,) = _launchM(Constants.MODE_PVE, address(quote), 50 ether);
        vm.warp(vm.getBlockTimestamp() + 61);
        _grad(c);
        assertEq(c.capRoom(alice), 0, "no curve room once graduated");
        (uint256 bps, uint256 capT) = lens.capNow(address(t));
        assertEq(bps, 0);
        assertEq(capT, type(uint256).max);
        (uint256 sb, uint256 left) = lens.sniperTax(address(t));
        assertEq(sb + left, 0);
        assertFalse(t.pveLive());
        vm.startPrank(alice);
        quote.approve(address(c), 1 ether);
        vm.expectRevert(BondingCurve.Graduated.selector);
        c.buy(1 ether, 0, vm.getBlockTimestamp() + 1);
        vm.stopPrank();
        // v4 pool: an unverified wallet buys well above the old 3.33% cap; tokens move freely
        _refReady(t);
        address anon = makeAddr("anonPostGrad");
        _swapExactInQuoteForToken(t, anon, 3_000 ether);
        assertGt(t.balanceOf(anon), Constants.TOTAL_SUPPLY * 333 / 10_000, "no cap post-graduation");
        uint256 ab = t.balanceOf(anon);
        vm.prank(anon);
        t.transfer(bob, ab);
        uint256 cb = t.balanceOf(creator);
        vm.prank(creator);
        t.transfer(bob, cb); // creator lock lifted
    }

    function test_rulesOffAfterGraduation_hard() public {
        (BondingCurve c, Token t) = _launchM(Constants.MODE_PVP);
        vm.warp(vm.getBlockTimestamp() + 61);
        _grad(c);
        assertEq(c.capRoom(alice), 0);
        _refReady(t);
        address anon = makeAddr("anonPostGradH");
        _swapExactInQuoteForToken(t, anon, 10_000 ether);
        assertGt(t.balanceOf(anon), Constants.TOTAL_SUPPLY * 777 / 10_000, "no cap post-graduation");
    }

    // ───────── TRENCH unchanged except the sniper tax ─────────

    function test_trench_unchangedExceptSniperTax() public {
        (BondingCurve c, Token t, ILaunchpad.LaunchResult memory r) =
            _launchM(Constants.MODE_TRENCH, address(quote), 1_000 ether);
        assertEq(r.creatorTokensBought, FeeMath.creatorBuyMax(launchpad.creatorBuyMaxBps()), "TRENCH max");
        assertEq(t.creatorLocked(), 0);
        assertEq(c.netCapNow(), type(uint256).max, "no cap");
        (uint256 tsup, uint256 sc,,) = c.curveParams();
        tsup;
        assertEq(c.capRoom(alice), sc - c.tokensSold(), "room = unsold curve supply");
        address anon = makeAddr("trenchAnon"); // no login
        quote.mint(anon, 100_000 ether);
        uint256 e0 = c.snipeEscrow();
        _buyQ(c, anon, 10 ether);
        assertEq(c.snipeEscrow() - e0, 9.9 ether, "sniper tax applies to TRENCH");
        vm.warp(vm.getBlockTimestamp() + 61);
        uint256 out = _buyQ(c, anon, 2_000 ether);
        assertGt(out, Constants.TOTAL_SUPPLY * 777 / 10_000, "no cap");
        assertEq(c.totalNet(), 0, "no Easy bookkeeping");
        _sellT(c, anon, out); // no max sell, no crew tip
    }

    // ───────── DiscipleRouter.launchWithUsdg / launchFor / claimCreatorFeesToUsdg ─────────

    function test_launchWithUsdg_usdgPair_easy_partialFill() public {
        uint256 u0 = quote.balanceOf(alice);
        vm.startPrank(alice);
        quote.approve(address(router), type(uint256).max);
        (ILaunchpad.LaunchResult memory r, uint256 refund) =
            router.launchWithUsdg(_params(address(quote), 0), Constants.MODE_PVE, 500 ether, 500 ether);
        vm.stopPrank();
        Token t = Token(r.token);
        uint256 maxT = Constants.TOTAL_SUPPLY * Constants.FIRST_BOOST_MAX_BPS_PVE / 10_000;
        assertEq(r.creatorTokensBought, maxT, "First BOOST max (partial fill)");
        assertGt(refund, 0);
        assertEq(u0 - quote.balanceOf(alice), 500 ether - refund, "leftover USDG refunded");
        assertEq(t.creator(), alice, "caller is the creator");
        assertEq(launchpad.creatorOf(address(t)), alice);
        assertEq(t.balanceOf(alice), maxT);
        assertEq(BondingCurve(r.curve).balanceOnCurve(alice), maxT);
        assertEq(t.creatorLocked(), maxT, "Easy creator lock applies");
        assertEq(BondingCurve(r.curve).snipeEscrow(), 0, "sniper-exempt");
        assertEq(quote.balanceOf(address(router)), 0);
        assertEq(t.balanceOf(address(router)), 0);
        assertEq(quote.balanceOf(address(launchpad)), 0);
    }

    function test_launchWithUsdg_defaultPairCoin_hard() public {
        uint256 u0 = quote.balanceOf(bob);
        vm.startPrank(bob);
        quote.approve(address(router), type(uint256).max);
        vm.expectEmit(true, false, false, false, address(router));
        emit UsdgLaunch(bob, address(0), 0, 0, 0);
        (ILaunchpad.LaunchResult memory r, uint256 refund) =
            router.launchWithUsdg(_params(address(0), 0), Constants.MODE_PVP, 20 ether, 1);
        vm.stopPrank();
        BondingCurve c = BondingCurve(r.curve);
        assertEq(c.quote(), address(strategy), "default pair coin via the USDG reference pool");
        assertEq(refund, 0, "under the max: no refund");
        assertEq(u0 - quote.balanceOf(bob), 20 ether);
        assertGt(r.creatorTokensBought, 0);
        assertEq(Token(r.token).creator(), bob);
        assertEq(Token(r.token).creatorLocked(), 0, "Hard: no creator lock");
        assertEq(strategy.balanceOf(address(router)), 0);
        // over the 3.33% max: the leftover pair coin is swapped back to USDG
        u0 = quote.balanceOf(bob);
        vm.prank(bob);
        (r, refund) = router.launchWithUsdg(_params(address(0), 0), Constants.MODE_PVP, 2_000 ether, 1);
        assertEq(r.creatorTokensBought, Constants.TOTAL_SUPPLY * Constants.FIRST_BOOST_MAX_BPS_PVP / 10_000);
        assertGt(refund, 1_000 ether);
        assertEq(u0 - quote.balanceOf(bob), 2_000 ether - refund);
        assertEq(strategy.balanceOf(address(router)), 0);
        assertEq(quote.balanceOf(address(router)), 0);
    }

    function test_launchWithUsdg_noBoost_slippage_deadline() public {
        vm.startPrank(carol);
        quote.approve(address(router), type(uint256).max);
        (ILaunchpad.LaunchResult memory r, uint256 refund) =
            router.launchWithUsdg(_params(address(strategy), 0), Constants.MODE_TRENCH, 0, 0);
        assertEq(r.creatorTokensBought, 0);
        assertEq(refund, 0);
        assertEq(Token(r.token).creator(), carol);
        vm.expectRevert(DiscipleRouter.Slippage.selector);
        router.launchWithUsdg(_params(address(strategy), 0), Constants.MODE_TRENCH, 10 ether, 11 ether);
        ILaunchpad.LaunchParams memory p = _params(address(strategy), 0);
        p.deadline = vm.getBlockTimestamp() - 1;
        vm.expectRevert(DiscipleRouter.Expired.selector);
        router.launchWithUsdg(p, Constants.MODE_TRENCH, 10 ether, 0);
        vm.stopPrank();
    }

    function test_launchFor_routerOnly() public {
        vm.prank(alice);
        vm.expectRevert(Launchpad.NotRouter.selector);
        launchpad.launchFor(alice, _params(address(quote), 0), Constants.MODE_TRENCH);
        vm.prank(address(router));
        vm.expectRevert();
        launchpad.launchFor(address(0), _params(address(quote), 0), Constants.MODE_TRENCH);
        vm.prank(owner);
        launchpad.setTrustedRouter(address(router), false);
        vm.startPrank(alice);
        quote.approve(address(router), type(uint256).max);
        vm.expectRevert(Launchpad.NotRouter.selector);
        router.launchWithUsdg(_params(address(quote), 0), Constants.MODE_TRENCH, 0, 0);
        vm.stopPrank();
    }

    function test_claimCreatorFeesToUsdg() public {
        // STRATEGY pair (swap) and USDG pair (plain transfer), creator = launcher via the router
        vm.startPrank(alice);
        quote.approve(address(router), type(uint256).max);
        ILaunchpad.LaunchParams memory p = _params(address(strategy), 0);
        p.creatorTaxBps = 300;
        (ILaunchpad.LaunchResult memory rs,) = router.launchWithUsdg(p, Constants.MODE_TRENCH, 0, 0);
        p.quote = address(quote);
        (ILaunchpad.LaunchResult memory ru,) = router.launchWithUsdg(p, Constants.MODE_TRENCH, 0, 0);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 61);
        vm.startPrank(bob);
        strategy.approve(rs.curve, type(uint256).max);
        BondingCurve(rs.curve).buy(100 ether, 0, vm.getBlockTimestamp() + 1);
        vm.stopPrank();
        _buyQ(BondingCurve(ru.curve), bob, 100 ether);
        uint256 accS = feeRouter.creatorAccrued(rs.token, alice);
        uint256 accU = feeRouter.creatorAccrued(ru.token, alice);
        assertGt(accS, 0);
        assertGt(accU, 0);
        uint256 u0 = quote.balanceOf(alice);
        vm.prank(alice);
        uint256 outS = router.claimCreatorFeesToUsdg(rs.token, 1);
        assertApproxEqRel(outS, accS, 0.01e18, "~1:1 pool minus the pool fee");
        assertEq(quote.balanceOf(alice) - u0, outS);
        assertEq(feeRouter.creatorAccrued(rs.token, alice), 0);
        vm.prank(alice);
        uint256 outU = router.claimCreatorFeesToUsdg(ru.token, accU);
        assertEq(outU, accU, "USDG pair: plain transfer");
        assertEq(strategy.balanceOf(address(router)), 0);
        assertEq(quote.balanceOf(address(router)), 0);
        // nothing left / not the creator
        vm.prank(alice);
        vm.expectRevert(FeeRouter.NothingToClaim.selector);
        router.claimCreatorFeesToUsdg(ru.token, 0);
        vm.prank(bob);
        vm.expectRevert(FeeRouter.NothingToClaim.selector);
        router.claimCreatorFeesToUsdg(rs.token, 0);
        // FeeRouter entry is router-only
        vm.prank(alice);
        vm.expectRevert(FeeRouter.OnlyAuthorized.selector);
        feeRouter.claimCreatorFeesFor(rs.token, alice);
    }
}
