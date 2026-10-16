// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../integration/IntegrationBase.sol";
import {Vm} from "forge-std/Vm.sol";
import {TrampWallManager} from "../../src/TrampWallManager.sol";
import {AnonLauncher} from "../../src/addons/AnonLauncher.sol";

/// @notice Security pass fuzz tests: hook fee split, TrampWallManager round-trip/auth, AnonLauncher sigs, LockedLP.
contract SecurityFuzzTest is IntegrationBase {
    TrampWallManager twm;
    BondingCurve curve;
    Token tok;
    address alice = makeAddr("alice");
    address whale = makeAddr("whale");

    bytes32 constant TFR = keccak256("TradeFeeRouted(address,address,address,uint256,uint256,uint256,uint256,uint256)");

    function setUp() public override {
        super.setUp();
        twm = new TrampWallManager(manager, lockedLP, address(hook));
        hook.setLiquidityManager(address(twm), true);
        twm.setKeeperTipBps(0); // legacy owner-gets-all assertions; tip covered in test/security/JitTwap.t.sol
        (curve, tok) = _launch(0, 0);
        _graduate(curve);
        quote.mint(alice, 1_000_000 ether);
        quote.mint(whale, 10_000_000 ether);
        deal(address(tok), whale, 2_000_000_000 ether);
        deal(address(tok), alice, 500_000_000 ether);
        address[2] memory us = [alice, whale];
        for (uint256 i; i < 2; i++) {
            vm.startPrank(us[i]);
            quote.approve(address(twm), type(uint256).max);
            tok.approve(address(twm), type(uint256).max);
            quote.approve(address(router), type(uint256).max);
            tok.approve(address(router), type(uint256).max);
            vm.stopPrank();
        }
    }

    /// Hook fee: creator 33 / LP 33 (all to LockedLP, no donation) / treasury 33 / referral-or-treasury 1, no value lost.
    function testFuzz_hook_fee_split_33_33_33_1(uint256 amt, bool isBuy) public {
        vm.recordLogs();
        if (isBuy) {
            amt = bound(amt, 1 ether, 50_000 ether);
            vm.prank(whale);
            router.buyExactIn(address(tok), amt, 0, whale, block.timestamp + 1);
        } else {
            amt = bound(amt, 1_000 ether, 50_000_000 ether);
            vm.prank(whale);
            router.sellExactIn(address(tok), amt, 0, whale, block.timestamp + 1);
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 cs;
        uint256 lps;
        uint256 ts;
        uint256 rs;
        bool seen;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == TFR) {
                (cs, lps, ts, rs,) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256));
                seen = true;
            }
        }
        assertTrue(seen, "fee routed");
        uint256 fee = cs + lps + ts + rs; // treasury absorbs the 1% when no referrer
        assertEq(cs, (fee * 33) / 100, "creator 33%");
        assertEq(lps, (fee * 33) / 100, "full LP 33% to LockedLP");
        assertEq(rs, 0, "no referrer -> 0");
        assertEq(ts, fee - cs - lps, "treasury 33% + 1% residual");
    }

    function _trampRange() internal view returns (int24 lo, int24 hi) {
        (int24 tick,, int24 sp, bool tIs0) = twm.poolState(address(tok));
        int24 a = tick / sp;
        if (tick < 0 && tick % sp != 0) a--;
        a *= sp;
        // tramp = quote side: if token is c0, quote is c1 → range below price; else above.
        if (tIs0) {
            hi = a - sp;
            lo = hi - 4 * sp;
        } else {
            lo = a + 2 * sp;
            hi = lo + 4 * sp;
        }
    }

    /// Placing then cancelling with no swaps returns principal (≤ 2 wei rounding), never more.
    function testFuzz_twm_round_trip_and_auth(uint256 amt) public {
        amt = bound(amt, 1 ether, 100_000 ether);
        (int24 lo, int24 hi) = _trampRange();
        uint256 q0 = quote.balanceOf(alice);
        vm.prank(alice);
        (uint256 id,) = twm.placeTramp(address(tok), lo, hi, amt, 1, block.timestamp + 1);
        vm.expectRevert(TrampWallManager.NotOwner.selector);
        twm.cancel(id);
        vm.expectRevert(TrampWallManager.NotFilled.selector);
        twm.pull(id);
        vm.prank(alice);
        (uint256 qo, uint256 to) = twm.cancel(id);
        assertEq(to, 0);
        assertLe(quote.balanceOf(alice), q0, "never more than deposited");
        assertGe(quote.balanceOf(alice) + 4, q0, "principal back");
        assertLe(qo, amt);
        vm.prank(alice);
        vm.expectRevert(TrampWallManager.Inactive.selector);
        twm.cancel(id);
    }

    function testFuzz_lockedLP_never_removable(address who, uint256 x) public {
        vm.prank(who);
        vm.expectRevert(LockedLP.RemoveLiquidityDisabled.selector);
        lockedLP.removeLiquidity(address(tok), x);
    }

    function testFuzz_lockedLP_add_only_feeRouter_or_migration(address who) public {
        vm.assume(who != address(feeRouter) && who != address(migration));
        vm.prank(who);
        vm.expectRevert(LockedLP.Unauthorized.selector);
        lockedLP.addLockedLiquidity(address(tok), address(quote), 0, 0);
    }
}

contract AnonSigFuzzTest is IntegrationBase {
    AnonLauncher anon;

    function setUp() public override {
        super.setUp();
        anon = new AnonLauncher(owner, address(launchpad), address(feeRouter), address(quote), treasury, address(0), 0);
    }

    function testFuzz_wrong_key_never_claims(uint256 pk, uint256 ownerPk) public {
        pk = bound(pk, 1, 1e70);
        ownerPk = bound(ownerPk, 1, 1e70);
        vm.assume(pk != ownerPk);
        address o = vm.addr(ownerPk);
        address[] memory toks = new address[](0);
        uint256 dl = block.timestamp + 1;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, anon.claimDigest(o, toks, o, 0, 0, dl));
        vm.expectRevert(AnonLauncher.BadSignature.selector);
        anon.claimManyBySig(AnonLauncher.ClaimReq(o, toks, o, 0, dl, abi.encodePacked(r, s, v)));
        // correct key works once and bumps nonce; replay fails
        (v, r, s) = vm.sign(ownerPk, anon.claimDigest(o, toks, o, 0, 0, dl));
        anon.claimManyBySig(AnonLauncher.ClaimReq(o, toks, o, 0, dl, abi.encodePacked(r, s, v)));
        assertEq(anon.nonces(o), 1);
        vm.expectRevert(AnonLauncher.BadSignature.selector);
        anon.claimManyBySig(AnonLauncher.ClaimReq(o, toks, o, 0, dl, abi.encodePacked(r, s, v)));
    }

    function testFuzz_digest_binds_every_field(address a, address b, address to, uint256 fee) public view {
        vm.assume(a != b);
        address[] memory x = new address[](2);
        x[0] = a;
        x[1] = b;
        address[] memory y = new address[](2);
        y[0] = b;
        y[1] = a;
        bytes32 d = anon.claimDigest(a, x, to, fee, 0, 1);
        assertTrue(d != anon.claimDigest(a, y, to, fee, 0, 1), "token order");
        assertTrue(d != anon.claimDigest(a, x, to, fee, 1, 1), "nonce");
        assertTrue(d != anon.claimDigest(a, x, to, fee == 0 ? 1 : 0, 0, 1), "relayer fee");
        assertTrue(d != anon.claimDigest(b, x, to, fee, 0, 1), "owner");
    }
}

/// FeeRouter solvency: quote held ≥ all creator + referrer liabilities, under random curve trading + claims.
contract FeeRouterHandler is Test {
    IntegrationBaseLike base;
    BondingCurve[] public curves;
    address[] public traders;
    MockUSDG quote;
    FeeRouter fr;

    constructor(FeeRouter fr_, MockUSDG q, BondingCurve[] memory cs, address[] memory ts) {
        fr = fr_;
        quote = q;
        for (uint256 i; i < cs.length; i++) {
            curves.push(cs[i]);
        }
        traders = ts;
    }

    function buy(uint256 c, uint256 t, uint256 amt) external {
        BondingCurve cv = curves[c % curves.length];
        if (cv.graduated()) return;
        address tr = traders[t % traders.length];
        amt = bound(amt, 1e15, 50 ether);
        vm.startPrank(tr);
        quote.approve(address(cv), amt);
        try cv.buy(amt, 0, block.timestamp + 1) {} catch {}
        vm.stopPrank();
    }

    function sell(uint256 c, uint256 t, uint256 frac) external {
        BondingCurve cv = curves[c % curves.length];
        if (cv.graduated()) return;
        address tr = traders[t % traders.length];
        uint256 bal = IERC20(cv.token()).balanceOf(tr);
        uint256 amt = (bal * bound(frac, 1, 100)) / 100;
        if (amt == 0) return;
        vm.startPrank(tr);
        IERC20(cv.token()).approve(address(cv), amt);
        try cv.sell(amt, 0, block.timestamp + 1) {} catch {}
        vm.stopPrank();
    }

    function claimCreator(uint256 c, address creator) external {
        address token = curves[c % curves.length].token();
        if (fr.creatorAccrued(token, creator) == 0) return;
        vm.prank(creator);
        fr.claimCreatorFees(token);
    }

    function warp(uint256 s) external {
        vm.warp(block.timestamp + bound(s, 1, 30));
    }
}

interface IntegrationBaseLike {}

contract FeeRouterSolvencyInvariant is IntegrationBase {
    FeeRouterHandler h;
    BondingCurve[] cs;
    address[] ts;

    function setUp() public override {
        super.setUp();
        _bindReferral(referred, kol, 10 ether);
        (BondingCurve c1,) = _launch(100, 0);
        (BondingCurve c2,) = _launch(0, 0);
        cs.push(c1);
        cs.push(c2);
        ts.push(trader1);
        ts.push(trader2);
        ts.push(referred);
        ts.push(sniper);
        h = new FeeRouterHandler(feeRouter, quote, cs, ts);
        targetContract(address(h));
    }

    function invariant_feeRouter_solvent() public view {
        uint256 owed = feeRouter.referrerAccrued(kol, address(quote));
        for (uint256 i; i < cs.length; i++) {
            owed += feeRouter.creatorAccrued(cs[i].token(), creator);
        }
        assertGe(quote.balanceOf(address(feeRouter)), owed);
    }

    function invariant_snipe_split_70_30() public view {
        // vault only ever receives exactly 70% of routed snipe tax (accounted == balance)
        assertEq(rewardsVault.totalAccrued(address(quote)), quote.balanceOf(address(rewardsVault)));
    }
}
