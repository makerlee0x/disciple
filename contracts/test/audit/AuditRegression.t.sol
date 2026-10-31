// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../integration/IntegrationBase.sol";
import {Owned2Step} from "../../src/utils/Owned2Step.sol";
import {Vm} from "forge-std/Vm.sol";
import {TrampWallManager} from "../../src/TrampWallManager.sol";
import {UsdgDepositNotifier} from "../../src/UsdgDepositNotifier.sol";

contract FixedPricer {
    uint256 public p;

    constructor(uint256 p_) {
        p = p_;
    }

    function quotePriceUsd(address) external view returns (uint256) {
        return p;
    }
}

/// @notice Regression tests for the Oct-16 audit findings (PoCs from test/audit/AuditPoC.t.sol, inverted to assert
///         the fixed behaviour). Numbering matches the PR findings→fix table.
contract AuditRegression is IntegrationBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address attacker = makeAddr("attacker");

    function gradExt(BondingCurve curve) external {
        _graduate(curve);
    }

    // ── #1 permissionless Migration.migrate ──
    function test_audit1_migrateOnlyFromRegisteredCurve() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _warpPastSnipe();
        _buy(curve, trader1, 2000 ether, 0);
        quote.mint(attacker, 100 ether);
        _buy(curve, attacker, 10 ether, 0);
        uint256 tb = tok.balanceOf(attacker);
        vm.startPrank(attacker);
        tok.approve(address(migration), tb);
        quote.approve(address(migration), 1 ether);
        vm.expectRevert(Migration.OnlyCurve.selector);
        migration.migrate(address(tok), address(quote), tb / 2, 1 ether, uint160(1) << 96);
        vm.stopPrank();
        assertFalse(migration.isGraduated(address(tok)));

        // the curve itself with a wrong quote is refused too
        vm.prank(address(curve));
        vm.expectRevert(Migration.QuoteMismatch.selector);
        migration.migrate(address(tok), address(strategy), 1, 1, uint160(1) << 96);

        // real graduation still works; creator comes from the Launchpad record
        this.gradExt(curve);
        assertTrue(migration.isGraduated(address(tok)));
        assertEq(migration.creatorOf(address(tok)), creator);
        (,, address hookCreator,,) = hook.metaOf(_poolKey(tok).toId());
        assertEq(hookCreator, creator);
    }

    function test_audit1_setLaunchpadOnceOwnerOnly() public {
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        migration.setLaunchpad(attacker);
        vm.prank(owner);
        vm.expectRevert(Migration.LaunchpadAlreadySet.selector);
        migration.setLaunchpad(attacker);
    }

    // ── #2 pre-initialized pool ──
    function test_audit2_preInitBlocked_graduatesAtCurvePrice() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        bool tokenIsC0 = uint160(address(tok)) < uint160(address(quote));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(tokenIsC0 ? address(tok) : address(quote)),
            currency1: Currency.wrap(tokenIsC0 ? address(quote) : address(tok)),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        vm.prank(attacker);
        vm.expectRevert();
        manager.initialize(key, uint160(1) << 96);

        this.gradExt(curve);
        (uint160 sp,,,) = manager.getSlot0(key.toId());
        (uint256 ts, uint256 sC, uint256 x0, uint256 y0) = curve.curveParams();
        CurveMath.Params memory cp = CurveMath.Params(ts, sC, x0, y0, curve.quotePriceUsd(), curve.curveTail());
        uint160 expected = SqrtPrice.fromReserves(CurveMath.marketCapQuote(cp, curve.tokensSold()), ts, tokenIsC0);
        assertEq(sp, expected, "pool initialized at the curve-end price");
        assertTrue(hook.getHookPermissions().beforeInitialize);
    }

    function Math_mulDiv(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        return (a * b) / c;
    }

    // ── #3 referral hijack ──
    function test_audit3_tryAttributeOnlyWalletOrAttestor() public {
        depositHook.notifyDeposit(trader1, 10 ether);
        vm.prank(attacker);
        vm.expectRevert(ReferralRegistry.NotWalletOrAttestor.selector);
        referrals.tryAttribute(trader1, attacker);
        assertEq(referrals.referrerOf(trader1), address(0));

        vm.prank(trader1);
        referrals.tryAttribute(trader1, kol);
        assertEq(referrals.referrerOf(trader1), kol);

        // attestor path + first-touch: a later different referrer never overwrites the pending one
        address att = makeAddr("attestor");
        vm.prank(owner);
        referrals.setAttestor(att, true);
        vm.prank(att);
        referrals.tryAttribute(trader2, kol);
        vm.prank(trader2);
        assertFalse(referrals.tryAttribute(trader2, attacker));
        assertEq(referrals.pendingReferrer(trader2), kol);
        depositHook.notifyDeposit(trader2, 10 ether);
        assertEq(referrals.referrerOf(trader2), kol);
    }

    // ── #4 stranded quote at graduation ──
    function test_audit4_noIdleQuoteAfterGraduation() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        vm.recordLogs();
        _graduate(curve);
        (,, uint256 tAmt, uint256 qAmt, uint256 escrow, bool grad, uint128 liq) = lockedLP.positions(address(tok));
        assertTrue(grad);
        assertGt(liq, 0);
        assertEq(escrow, 0, "escrow reset");
        // rev. 2026-10-16: unpaired quote is held as the coin's compound quote bucket (not idle, not treasury)
        (uint256 bTok, uint256 bQuote) = lockedLP.compoundBucket(address(tok));
        assertEq(quote.balanceOf(address(lockedLP)), bQuote, "LockedLP quote == compound bucket");
        assertEq(bTok, 0);
        assertGt(bQuote, 0, "leftover kept for compounding");
        assertEq(tok.balanceOf(address(lockedLP)), 0, "no idle token in LockedLP");
        assertGt(qAmt, 0);
        assertGt(tAmt, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("GraduationLeftover(address,uint256,uint256)");
        bool seen;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == sig && logs[i].emitter == address(lockedLP)) {
                (uint256 qLeft,) = abi.decode(logs[i].data, (uint256, uint256));
                assertEq(qLeft, bQuote, "leftover quote -> compound bucket");
                seen = true;
            }
        }
        assertTrue(seen, "GraduationLeftover emitted");
    }

    // ── #5 deposit notifier (real contract; deploy wiring covered by DeployConfig.t.sol) ──
    function test_audit5_usdgDepositNotifierFinalizesReferral() public {
        UsdgDepositNotifier n = new UsdgDepositNotifier(owner, referrals, quote);
        vm.prank(owner);
        referrals.setDepositHook(address(n));
        vm.prank(trader1);
        referrals.tryAttribute(trader1, kol);
        vm.startPrank(trader2); // third-party payer (self-deposits are rejected: DISCIPLE audit #7)
        quote.approve(address(n), 10 ether);
        n.deposit(trader1, 10 ether);
        vm.stopPrank();
        assertEq(referrals.referrerOf(trader1), kol);
        vm.expectRevert(UsdgDepositNotifier.OnlyAttestor.selector);
        n.attest(trader2, 10 ether);
    }

    // ── #6 one-tick-spacing bands ──
    function test_audit6_bandMustBeOneTickSpacing() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _graduate(curve);
        TrampWallManager twm = new TrampWallManager(manager, lockedLP, address(hook));
        hook.setLiquidityManager(address(twm), true);
        (int24 tick,, int24 ts, bool tIs0) = twm.poolState(address(tok));
        int24 a = tick / ts;
        if (tick < 0 && tick % ts != 0) a--;
        a *= ts;
        // tramp = quote side
        (int24 lo, int24 hi) = tIs0 ? (a - 2 * ts, a - ts) : (a + 2 * ts, a + 3 * ts);
        vm.startPrank(trader1);
        quote.approve(address(twm), type(uint256).max);
        if (tIs0) {
            vm.expectRevert(TrampWallManager.BadRange.selector);
            twm.placeTramp(address(tok), lo - ts, hi, 10 ether, 0, block.timestamp + 1);
        } else {
            vm.expectRevert(TrampWallManager.BadRange.selector);
            twm.placeTramp(address(tok), lo, hi + ts, 10 ether, 0, block.timestamp + 1);
        }
        twm.placeTramp(address(tok), lo, hi, 10 ether, 0, block.timestamp + 1);
        vm.stopPrank();
    }

    // ── #9 graduation final buy refunds unused quote ──
    function test_audit9_graduationBuyRefundsExcess() public {
        (BondingCurve curve,) = _launch(0, 0);
        _warpPastSnipe();
        uint256 big = 1_000_000 ether;
        quote.mint(trader1, big);
        uint256 b0 = quote.balanceOf(trader1);
        BondingCurve.BuyQuote memory q = curve.quoteBuy(big);
        assertGt(q.refund, 0, "quote reports refund");
        _buy(curve, trader1, big, 0);
        assertTrue(curve.graduated());
        uint256 spent = b0 - quote.balanceOf(trader1);
        assertEq(spent, big - q.refund, "only the needed quote is charged");
        assertLt(spent, big / 10, "refund is most of the order");
    }

    // ── #11 TradeFeeRouted carries payees + fee token ──
    function test_audit11_tradeFeeRoutedHasKolPayee() public {
        _bindReferral(creator, kol, 10 ether);
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _warpPastSnipe();
        vm.recordLogs();
        _buy(curve, trader1, 100 ether, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256(
            "TradeFeeRouted(address,address,address,bool,address,uint256,uint256,uint256,uint256,address,uint256,address,uint256)"
        );
        bool seen;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] != sig) continue;
            assertEq(address(uint160(uint256(logs[i].topics[1]))), address(tok));
            assertEq(address(uint160(uint256(logs[i].topics[2]))), address(quote), "feeToken");
            (bool feeIsQuote, address cr,,,,, address refPayee, uint256 refShare, address kolPayee, uint256 kolShare) = abi
                .decode(logs[i].data, (bool, address, uint256, uint256, uint256, uint256, address, uint256, address, uint256));
            assertTrue(feeIsQuote);
            assertEq(cr, creator);
            assertEq(refPayee, kol);
            assertGt(refShare, 0);
            assertEq(kolPayee, kol);
            assertGt(kolShare, 0);
            seen = true;
        }
        assertTrue(seen);
    }

    // ── #12 hook.setMigration front-run ──
    function test_audit12_setMigrationAdminOnlyAndOnce() public {
        vm.prank(attacker);
        vm.expectRevert(AscensionHook.OnlyAdmin.selector);
        hook.setMigration(attacker);
        vm.expectRevert(bytes("AscensionHook: mig"));
        hook.setMigration(attacker); // admin, but already wired
    }

    // ── #13 quoteExactIn mcap == mcap derived from Trade.sqrtPriceAfter at the live price (G-1) ──
    function test_audit13_quoteMcapMatchesTradeEvent() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _graduate(curve);
        FixedPricer fp = new FixedPricer(3e18); // live price differs from launch-time 1e18
        hook.setPricer(address(fp));
        PoolId pid = PoolIdLibrary.toId(_poolKey(tok));
        bool tokenIsC0 = uint160(address(tok)) < uint160(address(quote));
        (uint256 out,, uint256 qMcap) = router.quoteExactIn(address(tok), true, 100 ether);
        uint256 liveQ = hook.quoteUsdOf(pid);
        assertEq(liveQ, 3e18);
        vm.startPrank(trader1);
        quote.approve(address(router), 100 ether);
        vm.recordLogs();
        // G-1 (expectCall counts every later call in this test, so no pricer reads after this line): the swap path never calls the pricer
        vm.expectCall(address(fp), abi.encodeWithSelector(FixedPricer.quotePriceUsd.selector), 0);
        router.buyExactIn(address(tok), 100 ether, out, trader1, block.timestamp + 1);
        vm.stopPrank();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig =
            keccak256("Trade(address,address,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint160)");
        bool seen;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == sig && logs[i].emitter == address(hook)) {
                (,,,,,,,, uint160 sqrtAfter) = abi.decode(
                    logs[i].data, (bool, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint160)
                );
                (uint160 sp,,,) = StateLibrary.getSlot0(manager, pid);
                assertEq(sqrtAfter, sp, "Trade.sqrtPriceAfter == slot0");
                assertEq(qMcap, hook.mcapUsdFromSqrt(sqrtAfter, tokenIsC0, liveQ));
                seen = true;
            }
        }
        assertTrue(seen);
    }
}
