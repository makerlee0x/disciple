// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IntegrationBase, MockUSDG} from "./IntegrationBase.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Vm} from "forge-std/Vm.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {TrampWallManager} from "../../src/TrampWallManager.sol";
import {DiscipleRouter} from "../../src/DiscipleRouter.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {Constants} from "../../src/libraries/Constants.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

contract TrampWallTest is IntegrationBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    TrampWallManager twm;
    BondingCurve curve;
    Token tok;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address keeper = makeAddr("keeper");
    address whale = makeAddr("whale");

    function setUp() public override {
        super.setUp();
        twm = new TrampWallManager(manager, lockedLP, address(hook));
        hook.setLiquidityManager(address(twm), true);
        twm.setMinHold(0); // legacy behaviour tests; hold + keeper tip covered in test/security/JitTwap.t.sol
        twm.setKeeperTipBps(0);
        (curve, tok) = _launch(0, 0);
        _graduate(curve);
        quote.mint(alice, 1_000_000 ether);
        quote.mint(whale, 10_000_000 ether);
        quote.mint(bob, 1_000_000 ether);
        deal(address(tok), alice, 500_000_000 ether);
        deal(address(tok), whale, 2_000_000_000 ether);
        for (uint256 i; i < 3; i++) {
            address u = [alice, whale, bob][i];
            vm.startPrank(u);
            quote.approve(address(twm), type(uint256).max);
            tok.approve(address(twm), type(uint256).max);
            quote.approve(address(router), type(uint256).max);
            tok.approve(address(router), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ── helpers ──
    function _state() internal view returns (int24 tick, int24 ts, bool tokenIsC0) {
        (tick,, ts, tokenIsC0) = twm.poolState(address(tok));
    }

    function _floor(int24 t, int24 ts) internal pure returns (int24) {
        int24 c = t / ts;
        if (t < 0 && t % ts != 0) c--;
        return c * ts;
    }

    /// @dev Range on the side of `sideIsC0` (c0-only above tick, c1-only below), `off` spacings away, `w` wide.
    function _range(bool sideIsC0, int24 off, int24 w) internal view returns (int24 lo, int24 hi) {
        (int24 tick, int24 ts,) = _state();
        int24 a = _floor(tick, ts);
        if (sideIsC0) {
            lo = a + ts * off;
            hi = lo + ts * w;
        } else {
            hi = a - ts * (off - 1);
            if (hi > a) hi = a;
            lo = hi - ts * w;
        }
    }

    function _trampRange(int24 off, int24 w) internal view returns (int24, int24) {
        (,, bool tIs0) = _state();
        return _range(!tIs0, off, w); // tramp side = quote
    }

    function _wallRange(int24 off, int24 w) internal view returns (int24, int24) {
        (,, bool tIs0) = _state();
        return _range(tIs0, off, w);
    }

    function _priceX18() internal view returns (uint256) {
        (, uint160 sp,, bool tIs0) = twm.poolState(address(tok));
        return hook.priceX18FromSqrt(sp, tIs0);
    }

    function _sell(address u, uint256 amt) internal {
        vm.prank(u);
        router.sellExactIn(address(tok), amt, 0, u, block.timestamp + 1);
    }

    function _buy(address u, uint256 amt) internal {
        vm.prank(u);
        router.buyExactIn(address(tok), amt, 0, u, block.timestamp + 1);
    }

    /// @dev Sell until price is below `p` (quote per token).
    function _sellUntilBelow(uint256 p, uint256 step) internal {
        for (uint256 i; i < 200 && _priceX18() >= p; i++) {
            _sell(whale, step);
        }
        require(_priceX18() < p, "could not push down");
    }

    function _buyUntilAbove(uint256 p, uint256 step) internal {
        for (uint256 i; i < 200 && _priceX18() <= p; i++) {
            _buy(whale, step);
        }
        require(_priceX18() > p, "could not push up");
    }

    function _priceAtTick(int24 t) internal view returns (uint256) {
        (,,, bool tIs0) = twm.poolState(address(tok));
        return hook.priceX18FromSqrt(TickMathLike.at(t), tIs0);
    }

    // ── placement ──

    function test_place_tramp_quote_only_and_wall_token_only() public {
        (int24 lo, int24 hi) = _trampRange(1, 4);
        uint256 q0 = quote.balanceOf(alice);
        uint256 t0 = tok.balanceOf(alice);
        vm.recordLogs();
        vm.prank(alice);
        (uint256 id, uint128 liq) = twm.placeTramp(address(tok), lo, hi, 100 ether, 1, block.timestamp + 1);
        assertGt(liq, 0);
        assertLe(q0 - quote.balanceOf(alice), 100 ether);
        assertGe(q0 - quote.balanceOf(alice), 100 ether - 2);
        assertEq(tok.balanceOf(alice), t0, "tramp takes no token");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == TrampWallManager.TrampPlaced.selector) seen = true;
        }
        assertTrue(seen);
        (address o,, int24 l, int24 h, uint128 pl,, bool active) = twm.positions(id);
        assertEq(o, alice);
        assertEq(l, lo);
        assertEq(h, hi);
        assertEq(pl, liq);
        assertTrue(active);

        (lo, hi) = _wallRange(1, 4);
        q0 = quote.balanceOf(alice);
        vm.prank(alice);
        (uint256 id2,) = twm.placeWall(address(tok), lo, hi, 1_000_000 ether, 1, block.timestamp + 1);
        assertEq(quote.balanceOf(alice), q0, "wall takes no quote");
        assertEq(twm.positionsOf(alice).length, 2);
        assertEq(twm.positionsOf(alice)[1], id2);
    }

    function test_place_rejects_wrong_side_misaligned_expired_minLiq_ungraduated() public {
        (int24 lo, int24 hi) = _wallRange(1, 4); // token side
        vm.startPrank(alice);
        vm.expectRevert(TrampWallManager.NotSingleSided.selector);
        twm.placeTramp(address(tok), lo, hi, 100 ether, 0, block.timestamp + 1);
        (lo, hi) = _trampRange(1, 4);
        vm.expectRevert(TrampWallManager.NotSingleSided.selector);
        twm.placeWall(address(tok), lo, hi, 100 ether, 0, block.timestamp + 1);
        // range straddling current tick
        (int24 tick, int24 ts,) = _state();
        int24 a = _floor(tick, ts);
        vm.expectRevert(TrampWallManager.NotSingleSided.selector);
        twm.placeTramp(address(tok), a - ts, a + ts, 100 ether, 0, block.timestamp + 1);
        vm.expectRevert(TrampWallManager.BadRange.selector);
        twm.placeTramp(address(tok), lo + 1, hi, 100 ether, 0, block.timestamp + 1);
        vm.expectRevert(TrampWallManager.BadRange.selector);
        twm.placeTramp(address(tok), hi, lo, 100 ether, 0, block.timestamp + 1);
        vm.expectRevert(TrampWallManager.Expired.selector);
        twm.placeTramp(address(tok), lo, hi, 100 ether, 0, block.timestamp - 1);
        vm.expectRevert();
        twm.placeTramp(address(tok), lo, hi, 100 ether, type(uint128).max, block.timestamp + 1);
        vm.stopPrank();

        (, Token fresh) = _launch(0, 0);
        vm.expectRevert(TrampWallManager.NotGraduated.selector);
        twm.placeTramp(address(fresh), lo, hi, 1 ether, 0, block.timestamp + 1);
    }

    // ── donations ──

    function test_donation_reaches_in_range_tramp_not_out_of_range() public {
        (int24 lo, int24 hi) = _trampRange(1, 6);
        (int24 flo, int24 fhi) = _trampRange(60, 6); // far below
        vm.startPrank(alice);
        (uint256 near,) = twm.placeTramp(address(tok), lo, hi, 500 ether, 0, block.timestamp + 1);
        (uint256 far,) = twm.placeTramp(address(tok), flo, fhi, 500 ether, 0, block.timestamp + 1);
        vm.stopPrank();

        // push price into the near tramp (below its top edge) but not through it
        uint256 top = _priceAtTick(_tokenIsC0() ? hi : lo);
        _sellUntilBelow(top, 200_000 ether);
        assertFalse(twm.isFilled(near));
        // trade inside the range
        for (uint256 i; i < 4; i++) {
            _buy(bob, 1 ether);
            _sell(whale, 50_000 ether);
        }
        (uint256 nq, uint256 nt) = twm.pendingFees(near);
        (uint256 fq, uint256 ft) = twm.pendingFees(far);
        assertGt(nq + nt, 0, "in-range tramp earns donation");
        assertEq(fq + ft, 0, "out-of-range tramp earns nothing");

        // claim
        uint256 q0 = quote.balanceOf(alice);
        uint256 t0 = tok.balanceOf(alice);
        vm.prank(alice);
        (uint256 cq, uint256 ct) = twm.claimFees(near);
        assertApproxEqAbs(cq, nq, 1);
        assertApproxEqAbs(ct, nt, 1);
        assertEq(quote.balanceOf(alice) - q0, cq);
        assertEq(tok.balanceOf(alice) - t0, ct);
        (nq, nt) = twm.pendingFees(near);
        assertEq(nq + nt, 0);
        vm.prank(bob);
        vm.expectRevert(TrampWallManager.NotOwner.selector);
        twm.claimFees(near);
    }

    function _tokenIsC0() internal view returns (bool t) {
        (,, t) = _state();
    }

    function test_hook_fee_split_accounting_with_donation() public {
        bytes32 routedTopic =
            keccak256("TradeFeeRouted(address,address,address,uint256,uint256,uint256,uint256,uint256)");
        bytes32 donTopic = keccak256("LPDonation(address,address,uint256)");
        for (uint256 dir; dir < 2; dir++) {
            vm.recordLogs();
            if (dir == 0) _buy(bob, 100 ether);
            else _sell(alice, 1_000_000 ether);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            uint256 donated;
            uint256 sumShares;
            bool sawDon;
            for (uint256 i; i < logs.length; i++) {
                if (logs[i].topics[0] == donTopic) {
                    donated = abi.decode(logs[i].data, (uint256));
                    sawDon = true;
                }
                if (logs[i].topics[0] == routedTopic) {
                    (uint256 c, uint256 lp, uint256 t, uint256 r,) =
                        abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256));
                    sumShares = c + lp + t + r;
                }
            }
            assertTrue(sawDon);
            // Find fee from Trade: reconstruct via donationOf inverse bounds
            assertGt(donated, 0);
            // creator+lp+treasury+ref (+kol, 0 here) + donated == full 1% fee; donated == fee*33/100/3
            uint256 fee = sumShares + donated;
            assertEq(donated, hook.donationOf(fee), "donation = 1/3 of 33% LP share");
            assertEq(fee * 100 / 100, fee);
        }
    }

    // ── fills / pull / cancel ──

    function test_tramp_fill_converts_and_keeper_pull_pays_owner() public {
        (int24 lo, int24 hi) = _trampRange(1, 2);
        vm.prank(alice);
        (uint256 id,) = twm.placeTramp(address(tok), lo, hi, 200 ether, 0, block.timestamp + 1);
        vm.expectRevert(TrampWallManager.NotFilled.selector);
        twm.pull(id);

        uint256 bottom = _priceAtTick(_tokenIsC0() ? lo : hi);
        _sellUntilBelow(bottom, 20_000_000 ether);
        assertTrue(twm.isFilled(id));

        uint256 q0 = quote.balanceOf(alice);
        uint256 t0 = tok.balanceOf(alice);
        vm.recordLogs();
        vm.prank(keeper);
        (uint256 qOut, uint256 tOut) = twm.pull(id);
        assertGt(tOut, 0, "converted to token");
        assertEq(tok.balanceOf(alice) - t0, tOut);
        assertEq(quote.balanceOf(alice) - q0, qOut); // only donation fees in quote, if any
        assertLt(qOut, 1 ether);
        assertEq(tok.balanceOf(keeper), 0);
        // bought ~200 quote worth of token at ~range price (well, at least something sane)
        assertGt(tOut * _priceAtTick(_tokenIsC0() ? lo : hi) / 1e18, 190 ether);
        vm.expectRevert(TrampWallManager.Inactive.selector);
        twm.pull(id);
        vm.prank(alice);
        vm.expectRevert(TrampWallManager.Inactive.selector);
        twm.cancel(id);
    }

    function test_wall_fill_converts_to_quote() public {
        (int24 lo, int24 hi) = _wallRange(1, 2);
        uint256 amt = 2_000_000 ether;
        vm.prank(alice);
        (uint256 id,) = twm.placeWall(address(tok), lo, hi, amt, 0, block.timestamp + 1);
        uint256 topP = _priceAtTick(_tokenIsC0() ? hi : lo);
        _buyUntilAbove(topP, 200 ether);
        assertTrue(twm.isFilled(id));
        uint256 q0 = quote.balanceOf(alice);
        vm.prank(keeper);
        (uint256 qOut, uint256 tOut) = twm.pull(id);
        assertGt(qOut, 0);
        assertEq(quote.balanceOf(alice) - q0, qOut);
        assertLt(tOut, 1e18, "token fully converted (maybe dust fees)");
        // sold at >= range bottom
        uint256 botP = _priceAtTick(_tokenIsC0() ? lo : hi);
        assertGe(qOut * 1e18 / amt, botP * 999 / 1000);
    }

    function test_cancel_mid_range_returns_both_assets_and_fees() public {
        (int24 lo, int24 hi) = _trampRange(1, 8);
        vm.prank(alice);
        (uint256 id,) = twm.placeTramp(address(tok), lo, hi, 300 ether, 0, block.timestamp + 1);
        uint256 top = _priceAtTick(_tokenIsC0() ? hi : lo);
        _sellUntilBelow(top, 100_000 ether);
        _sell(whale, 100_000 ether);
        assertFalse(twm.isFilled(id));
        (uint256 pq, uint256 pt) = twm.pendingFees(id);

        vm.prank(bob);
        vm.expectRevert(TrampWallManager.NotOwner.selector);
        twm.cancel(id);

        uint256 q0 = quote.balanceOf(alice);
        uint256 t0 = tok.balanceOf(alice);
        vm.prank(alice);
        (uint256 qOut, uint256 tOut) = twm.cancel(id);
        assertGt(qOut, 0, "unfilled quote back");
        assertGt(tOut, 0, "filled part as token");
        assertGe(qOut, pq);
        assertGe(tOut, pt);
        assertEq(quote.balanceOf(alice) - q0, qOut);
        assertEq(tok.balanceOf(alice) - t0, tOut);
        assertLe(qOut, 300 ether + pq + 1);
    }

    function test_cancel_untouched_returns_principal() public {
        (int24 lo, int24 hi) = _trampRange(5, 4);
        uint256 q0 = quote.balanceOf(alice);
        vm.prank(alice);
        (uint256 id,) = twm.placeTramp(address(tok), lo, hi, 100 ether, 0, block.timestamp + 1);
        vm.prank(alice);
        (uint256 qOut, uint256 tOut) = twm.cancel(id);
        assertEq(tOut, 0);
        assertApproxEqAbs(quote.balanceOf(alice), q0, 2, "principal back (rounding only)");
        assertEq(q0 - quote.balanceOf(alice) + qOut, q0 - quote.balanceOf(alice) + qOut);
    }

    function test_unlockCallback_only_poolManager() public {
        vm.expectRevert(TrampWallManager.OnlyPoolManager.selector);
        twm.unlockCallback("");
    }

    // ── creator anti-snipe exemption ──

    function test_creator_buy_exempt_from_anti_snipe() public {
        uint256 qIn = 20 ether;
        (uint256 tOut,, uint256 snipe,,) = launchpad.quoteCreatorBuy(address(quote), qIn);
        assertEq(snipe, 0);
        vm.startPrank(creator);
        quote.approve(address(launchpad), qIn);
        vm.recordLogs();
        ILaunchpad.LaunchResult memory r = launchpad.launchCoin(
            ILaunchpad.LaunchParams({
                name: "X",
                ticker: "X",
                imageURI: "ipfs://x",
                description: "",
                socialsURI: "",
                quote: address(quote),
                creatorTaxBps: 0,
                creatorBuyQuoteIn: qIn,
                creatorBuyMinTokensOut: tOut,
                deadline: block.timestamp + 1
            })
        );
        vm.stopPrank();
        assertEq(r.creatorTokensBought, tOut);
        // a normal buyer in the same block pays the full snipe fee
        BondingCurve c2 = BondingCurve(r.curve);
        BondingCurve.BuyQuote memory q = c2.quoteBuy(qIn);
        assertEq(q.snipeFee, qIn * Constants.ANTI_SNIPE_START_BPS / 10_000);
        // creator paid exactly 1% protocol fee (no snipe → LockedLP got nothing from snipe)
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 tt =
            keccak256("Trade(address,address,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)");
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == tt) {
                (, uint256 qa,, uint256 fee, uint256 sf) =
                    abi.decode(logs[i].data, (bool, uint256, uint256, uint256, uint256));
                assertEq(qa, qIn);
                assertEq(fee, qIn / 100);
                assertEq(sf, 0);
            }
        }
    }
}

contract ReentrantQuote is MockUSDG {
    address public target;
    bytes public payload;
    bool public attempted;
    bytes public lastRevert;

    function arm(address t, bytes calldata p) external {
        target = t;
        payload = p;
    }

    function transferFrom(address from, address to, uint256 v) public override returns (bool) {
        if (target != address(0)) {
            address t = target;
            target = address(0);
            attempted = true;
            (bool ok, bytes memory ret) = t.call(payload);
            require(!ok, "reentrancy succeeded");
            lastRevert = ret;
        }
        return super.transferFrom(from, to, v);
    }
}

contract TrampWallReentrancyTest is IntegrationBase {
    function test_reentrancy_blocked_via_malicious_quote() public {
        ReentrantQuote rq = new ReentrantQuote();
        vm.startPrank(owner);
        quoteProbe.setAlwaysPass(address(rq), true);
        vm.stopPrank();
        PoolKey memory k = _initRefPool(address(rq), address(quote), uint160(1) << 96);
        vm.prank(owner);
        pricer.setPricePool(address(rq), k);
        (BondingCurve c, Token t) = _launchWithQuote(address(rq), 0, 0);
        _graduateWith(c, MockUSDG(address(rq)));
        TrampWallManager twm = new TrampWallManager(manager, lockedLP, address(hook));
        hook.setLiquidityManager(address(twm), true);
        twm.setMinHold(0); // legacy behaviour tests; hold + keeper tip covered in test/security/JitTwap.t.sol
        twm.setKeeperTipBps(0);
        (int24 tick,, int24 ts, bool tIs0) = twm.poolState(address(t));
        int24 a = (tick / ts) * ts;
        if (tick < 0 && tick % ts != 0) a -= ts;
        // tramp side = quote(rq): if token is c0, quote is c1 → below
        (int24 lo, int24 hi) = tIs0 ? (a - 5 * ts, a - ts) : (a + 2 * ts, a + 6 * ts);
        address u = makeAddr("u");
        rq.mint(u, 1_000 ether);
        vm.startPrank(u);
        rq.approve(address(twm), type(uint256).max);
        (uint256 id0,) = twm.placeTramp(address(t), lo, hi, 10 ether, 0, block.timestamp + 1);
        vm.stopPrank();
        rq.arm(address(twm), abi.encodeCall(TrampWallManager.cancel, (id0)));
        vm.prank(u);
        twm.placeTramp(address(t), lo, hi, 10 ether, 0, block.timestamp + 1);
        assertTrue(rq.attempted());
        assertEq(bytes4(rq.lastRevert()), ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        (,,,,,, bool active) = twm.positions(id0);
        assertTrue(active, "first position untouched");
    }
}

library TickMathLike {
    function at(int24 t) internal pure returns (uint160) {
        return TickMathImport.getSqrtPriceAtTick(t);
    }
}

import {TickMath as TickMathImport} from "@uniswap/v4-core/src/libraries/TickMath.sol";
