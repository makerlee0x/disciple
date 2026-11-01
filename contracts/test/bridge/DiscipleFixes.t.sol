// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {BridgeStorage} from "../../src/bridge/BridgeStorage.sol";
import {BridgeCurve} from "../../src/bridge/libraries/BridgeCurve.sol";
import {BridgeConstants as C} from "../../src/bridge/libraries/BridgeConstants.sol";
import {DiscipleMath} from "../../src/bridge/DiscipleMath.sol";
import {BridgeFixture} from "./BridgeFixture.sol";
import {MockERC20, MockV2Pair, MockV3Pool} from "./mocks/BridgeMocks.sol";

/// @notice Locked behavior from the Oct 31 review: both fees before graduation, past-block
///         anchors, Dutch consumption, and the deposit clock.
contract DiscipleFixesTest is BridgeFixture {
    using PoolIdLibrary for PoolKey;

    function setUp() public {
        _deployStack(18);
        coin = _newCoin("JESUS", 18);
        (key, id) = _create(coin, 77e18, 0, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        _price(id, 1e18, 725_000e18);
    }

    function test_preGradBuyPaysBothFeesAndArbRaisesLpRedeem() public {
        usdg.mint(address(this), 40e18);
        uint256 sh = hook.deposit(id, 0, 20e18);
        this.nextBlock();
        uint256 lpX = hook.curve(id).lpX;
        uint256 amount = 5e18;
        (uint256 quoted, uint256 fee,,) = hook.quoteExactIn(key, _buyZfo(), amount);
        assertGt(fee, (amount * C.FEE_GRAD_BPS) / C.BPS, "the sliding fee is still on");
        uint256 anchor = hook.curve(id).anchor;
        uint256 mark = Math.mulDiv(quoted, anchor, C.WAD);
        assertGt(mark, amount, "the quote is still better than the anchor after the arb fee");
        uint256 left = mark - amount;
        uint256 improvement = Math.mulDiv(left, C.BPS, C.BPS - C.ARB_FEE_BPS);
        uint256 arb = improvement - left;
        assertGt(arb, 0, "the arb fee is charged on top of the sliding fee");
        assertLe(arb, improvement, "the arb portion alone cannot exceed the improvement");

        uint256 before = coin.balanceOf(address(this));
        _buy(key, address(coin), amount);
        assertEq(coin.balanceOf(address(this)) - before, quoted);
        assertGt(hook.curve(id).lpX, lpX, "retained arb coins are credited to LPs");
        assertEq(hook.creatorFees(id), 0);
        assertEq(hook.curve(id).lockedY, 0);

        this.nextBlock();
        (uint256 cOut, uint256 uOut) = hook.redeem(id, sh);
        assertGt(cOut, 0.1e18, "an LP redeems part of the arb coins");
        assertGt(uOut, 0);
    }

    function test_preGradSellPaysBothFeesAndKeepsArbInThePool() public {
        usdg.mint(address(this), 80e18);
        for (uint256 i; i < 40 && hook.spotPrice(id) < 1.2e18; ++i) {
            _buy(key, address(coin), 2e18);
        }
        assertGe(hook.spotPrice(id), 1.2e18, "the sale has to clear the anchor after the sliding fee");
        address lp = address(0xB0B);
        usdg.mint(lp, 30e18);
        vm.startPrank(lp);
        usdg.approve(address(hook), type(uint256).max);
        uint256 sh = hook.deposit(id, 0, 20e18);
        vm.stopPrank();
        this.nextBlock();

        // A small clip stays above the anchor, so 77% of the improvement is still an improvement.
        uint256 sellAmt = 0.1e18;
        (uint256 quoted, uint256 fee,,) = hook.quoteExactIn(key, _sellZfo(), sellAmt);
        assertGt(fee, 0, "the sliding fee is still on");
        uint256 anchor = hook.curve(id).anchor;
        uint256 cost = Math.mulDiv(sellAmt, anchor, C.WAD);
        assertGt(quoted, cost, "the sell still beats the anchor after the arb fee");
        uint256 left = quoted - cost;
        uint256 improvement = Math.mulDiv(left, C.BPS, C.BPS - C.ARB_FEE_BPS);
        uint256 arb = improvement - left;
        assertGt(arb, 0, "the arb fee is charged on top of the sliding fee");
        assertLe(arb, improvement);

        uint256 yBefore = hook.curve(id).y;
        _sell(key, address(coin), sellAmt);
        assertApproxEqAbs(yBefore - hook.curve(id).y, quoted, 2, "the arb USDG stays in the book");
        assertEq(hook.creatorFees(id), 0);
        assertEq(hook.curve(id).lockedY, 0);
        uint256 credited = hook.pendingFee(id, lp);
        assertGt(credited, fee, "the LP credit is larger than the sliding fee, so it includes the arb");

        this.nextBlock();
        vm.prank(lp);
        (uint256 cOut, uint256 uOut) = hook.redeem(id, sh);
        assertGt(uOut, 5e18, "the LP redeems USDG, including the compounded arb");
        assertGt(cOut, 0);
    }

    function test_combinedFeesCanExceedTheImprovement() public pure {
        BridgeCurve.S memory s = DiscipleMath.init(77e18, uint256(C.DISCOUNT_BPS) * 1e14);
        s = DiscipleMath.onAnchor(s, 1e18);
        // Close to the anchor: the ~2% sliding fee is larger than the leftover improvement.
        s = DiscipleMath.retarget(s, 0.97e18);
        BridgeCurve.Ctx memory ctx;
        ctx.gradTvl = 100_000e18;
        ctx.maxUsdgOut = type(uint256).max;
        ctx.boostWad = C.BOOST_START_WAD;
        uint256 usdgIn = 0.05e18;
        (, BridgeCurve.Fill memory f) = DiscipleMath.trade(s, ctx, usdgIn, false, 0);
        assertEq(f.usdgIn, usdgIn);
        assertGt(f.fee, 0);
        assertGt(f.arb, 0);
        uint256 mark = Math.mulDiv(f.coinOut, s.anchor, C.WAD);
        assertGt(mark, usdgIn);
        uint256 improvement = (mark - usdgIn) + f.arb;
        assertLe(f.arb, improvement, "the arb portion alone stays inside the improvement");
        assertGt(f.fee + f.arb, improvement, "the sliding fee is not capped against the improvement");
    }

    function test_arbFeeIsOffWhileGraduatedAndReturnsAfterDropout() public {
        usdg.mint(address(this), 300_000e18);
        for (uint256 i; i < 40 && hook.spotPrice(id) < 1.2e18; ++i) {
            _buy(key, address(coin), 2e18);
        }
        assertGe(hook.spotPrice(id), 1.2e18);
        hook.deposit(id, 0, 100_000e18);
        assertTrue(hook.bridgeQuote(id).graduated, "the deposit graduates on full-book TVL");
        assertGe(hook.spotPrice(id), 1.2e18, "a deposit does not move spot");

        uint256 sellAmt = 0.1e18;
        (uint256 sellQuoted,,,) = hook.quoteExactIn(key, _sellZfo(), sellAmt);
        (uint256 sellOn, uint256 arbOn) = _sim(id, sellAmt, true, false);
        (uint256 sellOff, uint256 arbOff) = _sim(id, sellAmt, true, true);
        assertEq(arbOff, 0, "no arb while graduated");
        assertGt(arbOn, 0, "the same sell would pay arb before graduation");
        assertGt(sellOff, sellOn, "arb keeps USDG");
        assertEq(sellQuoted, sellOff, "a graduated sell pays only the base fee");
        _sell(key, address(coin), sellAmt);
        assertGt(hook.creatorFees(id), 0, "the 0.30% fee still splits in thirds");

        // A deep USDG deposit pins spot, so the below-anchor case is a second book.
        MockERC20 c2 = _newCoin("BACK", 18);
        (PoolKey memory k2, PoolId id2) = _create(c2, 77e18, 0, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        _price(id2, 1e18, 725_000e18);
        hook.deposit(id2, 0, 100_000e18);
        assertTrue(hook.bridgeQuote(id2).graduated);
        assertLt(hook.spotPrice(id2), hook.curve(id2).anchor);

        bool buyZfo = Currency.unwrap(k2.currency0) != address(c2);
        uint256 buyAmt = 1e18;
        (uint256 buyQuoted,,,) = hook.quoteExactIn(k2, buyZfo, buyAmt);
        (uint256 buyOn, uint256 buyArbOn) = _sim(id2, buyAmt, false, false);
        (uint256 buyOff, uint256 buyArbOff) = _sim(id2, buyAmt, false, true);
        assertEq(buyArbOff, 0, "no arb on a graduated buy");
        assertGt(buyArbOn, 0);
        assertGt(buyOff, buyOn);
        assertEq(buyQuoted, buyOff, "a graduated buy pays only the base fee");

        hook.redeem(id2, hook.sharesOf(id2, address(this)));
        assertFalse(hook.bridgeQuote(id2).graduated, "dropping under the target turns the arb fee back on");
        (uint256 again,,,) = hook.quoteExactIn(k2, buyZfo, buyAmt);
        (uint256 againOn, uint256 againArb) = _sim(id2, buyAmt, false, false);
        (uint256 againOff,) = _sim(id2, buyAmt, false, true);
        assertGt(againArb, 0, "the arb fee is back");
        assertEq(again, againOn, "the quote charges the arb fee again");
        assertGt(againOff, again, "the arb fee keeps coins the buyer would otherwise take");
        uint256 before = c2.balanceOf(address(this));
        _buy(k2, address(c2), buyAmt);
        assertEq(c2.balanceOf(address(this)) - before, again);
    }

    function test_usdgDepositMovesDutchLikeABuy() public {
        MockERC20 other = _newCoin("TWIN", 18);
        (PoolKey memory keyB, PoolId idB) = _create(other, 77e18, 0, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        _price(idB, 1e18, 725_000e18);
        skip(2 hours);
        (uint256 bidA, uint256 askA,) = hook.dutchState(id);
        (uint256 bidB, uint256 askB,) = hook.dutchState(idB);
        assertEq(bidA, bidB);
        assertEq(askA, askB);
        assertGt(askA, 0);

        uint256 amount = 1e18;
        usdg.mint(address(this), amount * 2);
        uint256 sh = hook.deposit(id, 0, amount);
        _buy(keyB, address(other), amount);
        (uint256 bidDep, uint256 askDep, uint64 atDep) = hook.dutchState(id);
        (uint256 bidBuy, uint256 askBuy, uint64 atBuy) = hook.dutchState(idB);
        assertEq(bidDep, bidBuy, "a USDG deposit restarts the bid the way a buy does");
        assertEq(askDep, askBuy, "a USDG deposit consumes the ask the way a buy does");
        assertEq(atDep, atBuy);
        assertEq(bidDep, 0);
        assertLt(askDep, askA);

        hook.redeem(id, sh);
        (uint256 bidBack, uint256 askBack, uint64 atBack) = hook.dutchState(id);
        assertEq(bidBack, bidDep, "a redeem does not restore the bid");
        assertEq(askBack, askDep, "a redeem does not restore the ask");
        assertEq(atBack, atDep);
    }

    function test_splittingDoesNotRepeatTheDutchGap() public {
        MockERC20 other = _newCoin("ONCE", 18);
        (PoolKey memory keyB, PoolId idB) = _create(other, 77e18, 0, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        _price(idB, 1e18, 725_000e18);
        skip(6 hours);
        (uint256 askBefore,,) = hook.dutchState(id);
        (uint256 askTwin,,) = hook.dutchState(idB);
        assertEq(askBefore, askTwin, "both books accrued the same gap");
        assertGt(askBefore, 0.3e18, "the ask is through the launch discount");

        uint256 slice = 0.2e18;
        uint256 n = 25;
        usdg.mint(address(this), slice * n * 2);
        uint256 spent;
        uint256 got;
        uint256 first;
        uint256 last;
        for (uint256 i; i < n; ++i) {
            uint256 b = coin.balanceOf(address(this));
            _buy(key, address(coin), slice);
            uint256 out = coin.balanceOf(address(this)) - b;
            if (i == 0) first = out;
            last = out;
            got += out;
            spent += slice;
        }
        (uint256 askAfter,,) = hook.dutchState(id);
        assertLt(askAfter, askBefore, "each fill consumes the ask");
        assertLt(last, first, "a later slice does not see the full gap");
        assertLe(got, spent * 2, "repeating the gap does not buy coin at a double discount");

        uint256 before = other.balanceOf(address(this));
        _buy(keyB, address(other), spent);
        uint256 once = other.balanceOf(address(this)) - before;
        // Successive chords are a hair richer than one chord of the same total. A repeated full gap is not.
        assertLe(got, once + once / 20, "splitting does not repeat the full gap");
    }

    function test_inTxPushDoesNotMoveTheAnchor() public {
        MockERC20 c = _newCoin("PUSH", 18);
        bool coin0 = address(c) < address(usdg);
        PoolKey memory ref = _openV4Ref(c, address(0), 3000);
        c.approve(address(swapper), type(uint256).max);
        usdg.approve(address(swapper), type(uint256).max);
        c.mint(address(this), 10e18);
        c.approve(address(hook), type(uint256).max);
        (PoolKey memory k, PoolId pid) =
            hook.createPool(_v4(address(c), 10e18, PoolId.unwrap(ref.toId()), address(0), 3000));
        _warmSample(pid);
        assertEq(hook.curve(pid).anchor, 1e18);

        this.nextBlock();
        skip(1 minutes);
        int24 pushTick = coin0 ? int24(-23040) : int24(23040);
        _swapRef(ref, coin0, TickMath.getSqrtPriceAtTick(pushTick));
        hook.poke(pid);
        _swapRef(ref, !coin0, TickMath.getSqrtPriceAtTick(0));
        (, int24 restored,,) = StateLibrary.getSlot0(manager, ref.toId());
        assertEq(restored, 0, "the reference is restored in the same transaction");
        assertEq(hook.curve(pid).anchor, 1e18, "the poke does not adopt the in-transaction tick");

        this.nextBlock();
        skip(29 minutes);
        (uint256 live,) = hook.liveAnchor(pid);
        assertGe(live, 0.2e18, "one in-transaction push is not the 30-minute TWAP");
        assertApproxEqRel(live, 1e18, 0.02e18);

        uint256 usdgIn = 0.5e18;
        usdg.mint(address(this), usdgIn);
        uint256 before = c.balanceOf(address(this));
        _buy(k, address(c), usdgIn);
        uint256 got = c.balanceOf(address(this)) - before;
        assertLe(got, usdgIn * 4, "the buy is not filled at a crushed anchor");
    }

    function test_v3CreateRequiresARealObserve() public {
        MockERC20 c = _newCoin("SHORT", 18);
        MockV3Pool young = new MockV3Pool(address(c), address(usdg), 0);
        young.dropToOne();
        young.setLiquidity(20_000e18);
        v3Factory.setPool(address(c), address(usdg), 3000, address(young));
        c.mint(address(this), 10e18);
        c.approve(address(hook), type(uint256).max);
        vm.expectRevert(BridgeStorage.BadCreate.selector);
        hook.createPool(_v3(c, young, 10e18, 3000));

        young.pin(0);
        (, PoolId pid) = hook.createPool(_v3(c, young, 10e18, 3000));
        assertGt(hook.curve(pid).anchor, 0);
    }

    function test_sourceRulesArePermissionless() public {
        MockERC20 c = _newCoin("RULES", 18);
        c.mint(address(this), 40e18);
        c.approve(address(hook), type(uint256).max);

        BridgeStorage.CreateParams memory self = _v4(address(c), 10e18, bytes32(uint256(1)), address(hook), 3000);
        vm.expectRevert(BridgeStorage.BadCreate.selector);
        hook.createPool(self);

        address afterOnly = address(uint160(Hooks.AFTER_SWAP_FLAG));
        assertTrue((uint160(afterOnly) & Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG) == 0);
        PoolKey memory okRef = _openV4Ref(c, afterOnly, 0);
        hook.createPool(_v4(address(c), 10e18, PoolId.unwrap(okRef.toId()), afterOnly, 0));

        MockERC20 thin = _newCoin("THIN", 18);
        PoolKey memory thinRef = _v4Pool(thin, address(0), 3000, 1e18);
        hook.witnessSource(hook.sourceKey(C.ANCHOR_V4, address(0), PoolId.unwrap(thinRef.toId())));
        skip(C.MIN_REF_AGE);
        thin.mint(address(this), 10e18);
        thin.approve(address(hook), type(uint256).max);
        vm.expectRevert(BridgeStorage.BadCreate.selector);
        hook.createPool(_v4(address(thin), 10e18, PoolId.unwrap(thinRef.toId()), address(0), 3000));

        MockERC20 young = _newCoin("NEW", 18);
        PoolKey memory youngRef = _v4Pool(young, address(0), 3000, 20_000e18);
        young.mint(address(this), 10e18);
        young.approve(address(hook), type(uint256).max);
        vm.expectRevert(BridgeStorage.BadCreate.selector);
        hook.createPool(_v4(address(young), 10e18, PoolId.unwrap(youngRef.toId()), address(0), 3000));

        MockV3Pool zero = new MockV3Pool(address(c), address(usdg), 0);
        zero.pin(0);
        zero.setLiquidity(20_000e18);
        v3Factory.setPool(address(c), address(usdg), 0, address(zero));
        vm.expectRevert(BridgeStorage.BadCreate.selector);
        hook.createPool(_v3(c, zero, 10e18, 0));

        MockV3Pool wide = new MockV3Pool(address(c), address(usdg), 0);
        wide.pin(0);
        wide.setLiquidity(20_000e18);
        v3Factory.setPool(address(c), address(usdg), 10_000, address(wide));
        BridgeStorage.CreateParams memory hi = _v3(c, wide, 10e18, 10_000);
        hi.tickSpacing = 120;
        hook.createPool(hi);
    }

    function test_discountIsFixedAndCreatorCanBeTransferred() public {
        MockERC20 c = _newCoin("DISC", 18);
        (, PoolId pid) = _create(c, 10e18, 0, 500, 1_000, 9_000, 3600);
        _price(pid, 1e18, 725_000e18);
        assertApproxEqRel(hook.spotPrice(pid), 0.67e18, 0.001e18, "discountBps on create is ignored");

        vm.expectRevert(BridgeStorage.BadCreate.selector);
        hook.transferCreator(id, address(0));
        vm.prank(address(0xBAD));
        vm.expectRevert(BridgeStorage.OnlyCreator.selector);
        hook.transferCreator(id, address(0xCAFE));
        vm.expectEmit(true, true, true, true);
        emit BridgeStorage.CreatorTransferred(id, address(this), address(0xCAFE));
        hook.transferCreator(id, address(0xCAFE));
        vm.expectRevert(BridgeStorage.OnlyCreator.selector);
        hook.claimCreatorFees(id);
        vm.prank(address(0xCAFE));
        hook.claimCreatorFees(id);
    }

    function test_redeemIsProRataWithNoFloor() public {
        usdg.mint(address(this), 30e18);
        coin.mint(address(this), 10e18);
        uint256 sh = hook.deposit(id, 10e18, 10e18);
        this.nextBlock();
        (uint256 cOut, uint256 uOut) = hook.redeem(id, sh);
        assertGt(cOut, 0);
        assertGt(uOut, 0);
        (uint256 mark,) = hook.floorState(id);
        assertEq(mark, 0);
    }

    function _buyZfo() internal view returns (bool) {
        return Currency.unwrap(key.currency0) != address(coin);
    }

    function _sellZfo() internal view returns (bool) {
        return Currency.unwrap(key.currency0) == address(coin);
    }

    /// @dev Same curve the hook quotes, with the graduation flag forced. Fee bps does not depend on that flag.
    function _sim(PoolId pid, uint256 amount, bool sellCoin, bool graduated)
        internal
        view
        returns (uint256 amountOut, uint256 arb)
    {
        BridgeCurve.S memory s = hook.curve(pid);
        BridgeCurve.Ctx memory ctx;
        ctx.gradTvl = Math.mulDiv(hook.smoothedReference(pid), C.GRAD_NUM, C.GRAD_DEN);
        ctx.graduated = graduated;
        ctx.maxUsdgOut = type(uint256).max;
        ctx.boostWad = C.BOOST_END_WAD;
        (, BridgeCurve.Fill memory f) = DiscipleMath.trade(s, ctx, amount, sellCoin, 0);
        amountOut = sellCoin ? f.usdgOut : f.coinOut;
        arb = f.arb;
    }

    function _v3(MockERC20 c, MockV3Pool pool, uint256 seed, uint24 fee)
        internal
        view
        returns (BridgeStorage.CreateParams memory p)
    {
        p.coin = address(c);
        p.creator = address(this);
        p.anchorKind = C.ANCHOR_V3;
        p.refPool = address(pool);
        p.refFee = fee;
        p.coinSeed = seed;
    }

    function _v4(address c, uint256 seed, bytes32 refPool, address refHooks, uint24 fee)
        internal
        view
        returns (BridgeStorage.CreateParams memory p)
    {
        p.coin = c;
        p.creator = address(this);
        p.anchorKind = C.ANCHOR_V4;
        p.coinSeed = seed;
        p.refPoolId = refPool;
        p.refFee = fee;
        p.refTickSpacing = 60;
        p.refHooks = refHooks;
    }

    function _openV4Ref(MockERC20 c, address refHooks, uint24 fee) internal returns (PoolKey memory ref) {
        ref = _v4Pool(c, refHooks, fee, 20_000e18);
        hook.witnessSource(hook.sourceKey(C.ANCHOR_V4, address(0), PoolId.unwrap(ref.toId())));
        skip(C.MIN_REF_AGE);
    }

    function _v4Pool(MockERC20 c, address refHooks, uint24 fee, uint256 liquidity)
        internal
        returns (PoolKey memory ref)
    {
        bool coin0 = address(c) < address(usdg);
        ref = PoolKey({
            currency0: Currency.wrap(coin0 ? address(c) : address(usdg)),
            currency1: Currency.wrap(coin0 ? address(usdg) : address(c)),
            fee: fee,
            tickSpacing: 60,
            hooks: IHooks(refHooks)
        });
        manager.initialize(ref, TickMath.getSqrtPriceAtTick(0));
        if (liquidity == 0) return ref;
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(manager);
        c.mint(address(this), 1e24);
        usdg.mint(address(this), 1e24);
        c.approve(address(lp), type(uint256).max);
        usdg.approve(address(lp), type(uint256).max);
        lp.modifyLiquidity(
            ref,
            IPoolManager.ModifyLiquidityParams({
                tickLower: -60, tickUpper: 60, liquidityDelta: int256(liquidity), salt: 0
            }),
            ""
        );
    }

    function _warmSample(PoolId pid) internal {
        this.nextBlock();
        hook.poke(pid);
        this.nextBlock();
        skip(1);
        hook.poke(pid);
        skip(30 minutes);
        this.nextBlock();
        hook.poke(pid);
    }

    function _swapRef(PoolKey memory ref, bool zeroForOne, uint160 limit) internal {
        swapper.swap(
            ref,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne, amountSpecified: -int256(1_000e18), sqrtPriceLimitX96: limit
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }
}
