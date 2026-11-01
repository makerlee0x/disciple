// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IERC6909Claims} from "@uniswap/v4-core/src/interfaces/external/IERC6909Claims.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {DiscipleHook} from "../../src/bridge/DiscipleHook.sol";
import {DiscipleMath} from "../../src/bridge/DiscipleMath.sol";
import {DiscipleAnchor} from "../../src/bridge/DiscipleAnchor.sol";
import {DiscipleBook} from "../../src/bridge/DiscipleBook.sol";
import {DiscipleLp} from "../../src/bridge/DiscipleLp.sol";
import {BridgeStorage} from "../../src/bridge/BridgeStorage.sol";
import {BridgeCurve} from "../../src/bridge/libraries/BridgeCurve.sol";
import {BridgeFee} from "../../src/bridge/libraries/BridgeFee.sol";
import {BridgeConstants as C} from "../../src/bridge/libraries/BridgeConstants.sol";
import {BridgeFixture} from "./BridgeFixture.sol";
import {MockERC20, MockV2Pair, MockV3Pool} from "./mocks/BridgeMocks.sol";

contract DiscipleHookTest is BridgeFixture {
    using CurrencyLibrary for Currency;

    function setUp() public {
        _deployStack(18);
        coin = _newCoin("JESUS", 18);
        (key, id) = _create(coin, 77e18, 5e18, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        _price(id, 1e18, 725_000e18);
    }

    function test_runtimeFitsEip170() public view {
        assertLe(address(hook).code.length, 24_576);
        assertLe(address(DiscipleMath).code.length, 24_576);
        assertLe(address(DiscipleAnchor).code.length, 24_576);
        assertLe(address(DiscipleBook).code.length, 24_576);
        assertLe(address(DiscipleLp).code.length, 24_576);
        assertGt(address(hook).code.length, 0);
        assertGt(address(DiscipleBook).code.length, 0);
    }

    function test_startsAtDiscountWithNoUsdg() public view {
        assertEq(hook.spotPrice(id), 0.67e18);
        assertEq(hook.curve(id).y, 0);
        assertEq(hook.curve(id).x, 77e18);
        BridgeStorage.BridgeQuote memory q = hook.bridgeQuote(id);
        assertLt(q.priceGapBps, 0);
        // $77 against 12% of the smoothed reference is still the top of the slide, not the 0.3% end.
        uint256 expect = BridgeFee.baseFeeBps(BridgeCurve.tvl(hook.curve(id)), _target());
        assertEq(q.suggestedFeeBps, expect);
        assertGt(q.suggestedFeeBps, 190);
        assertLt(q.suggestedFeeBps, C.FEE_TINY_BPS);
        assertFalse(q.stale);
        assertFalse(q.graduated);
        assertEq(hook.anchorKind(id), C.ANCHOR_V3);
        _solvent(id, address(coin));
    }

    function test_externalInitAndLiquidityRevert() public {
        vm.expectRevert();
        manager.initialize(key, TickMath.getSqrtPriceAtTick(0));
        PoolModifyLiquidityTest liq = new PoolModifyLiquidityTest(manager);
        vm.expectRevert();
        liq.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({tickLower: -60, tickUpper: 60, liquidityDelta: 1e6, salt: bytes32(0)}),
            ""
        );
    }

    function test_swapBeforeAnchorReverts() public {
        MockERC20 c = _newCoin("PRE", 18);
        MockV2Pair pair = new MockV2Pair(address(c), address(usdg));
        pair.setReserves(1_000_000e18, 1_000_000e18);
        usdg.mint(address(pair), 50_000e18);
        v2Factory.setPair(address(c), address(usdg), address(pair));
        hook.witnessSource(hook.sourceKey(C.ANCHOR_V2, address(pair), bytes32(0)));
        skip(C.MIN_REF_AGE);
        c.mint(address(this), 10e18);
        c.approve(address(hook), type(uint256).max);
        (PoolKey memory k, PoolId pid) = hook.createPool(
            BridgeStorage.CreateParams({
                coin: address(c),
                creator: address(this),
                floorBps: C.FLOOR_BPS,
                discountBps: C.DISCOUNT_BPS,
                outflowCapBps: 0,
                outflowWindow: 0,
                anchorKind: C.ANCHOR_V2,
                refPool: address(pair),
                coinSeed: 10e18,
                dutchDrift: 0,
                refPoolId: bytes32(0),
                tickSpacing: 0,
                refFee: 0,
                refTickSpacing: 0,
                refHooks: address(0)
            })
        );
        assertEq(hook.curve(pid).anchor, 0, "a cold v2 ring is not an anchor");
        usdg.mint(address(this), 1e18);
        usdg.approve(address(swapper), type(uint256).max);
        vm.expectRevert();
        this.execSwap(k, Currency.unwrap(k.currency0) != address(c), 1e18);
    }

    function test_stalePokeReadsThePoolAndPaysNothing() public {
        uint256 before = usdg.balanceOf(address(this));
        vm.warp(block.timestamp + 30 minutes + 1);
        assertTrue(hook.bridgeQuote(id).stale);
        usdg.mint(address(this), 1e18);
        _buy(key, address(coin), 1e18);
        assertFalse(hook.bridgeQuote(id).stale, "a healthy source refreshes before the stale check");
        assertEq(usdg.balanceOf(address(this)), before, "the swap spends the payment and pays no keeper");

        vm.warp(block.timestamp + 30 minutes + 1);
        v3Of[id].setBroken(true);
        usdg.mint(address(this), 1e18);
        usdg.approve(address(swapper), type(uint256).max);
        vm.expectRevert();
        swapper.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: _buyZfo(),
                amountSpecified: -int256(1e18),
                sqrtPriceLimitX96: _buyZfo() ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        assertTrue(hook.bridgeQuote(id).stale);
        v3Of[id].setBroken(false);
        uint256 spotBefore = hook.spotPrice(id);
        uint256 anchorBefore = hook.curve(id).anchor;
        _price(id, 1.1e18, 725_000e18);
        // The buy already moved spot. The anchor change scales that spot; it does not rewind to 0.67.
        uint256 scaled = Math.mulDiv(spotBefore, hook.curve(id).anchor, anchorBefore);
        assertApproxEqRel(hook.spotPrice(id), scaled, 0.02e18);
        _solvent(id, address(coin));
    }

    function test_firstUpdateWithEmptyBudgetPaysZero() public {
        MockERC20 c = _newCoin("NOTIP", 18);
        (PoolKey memory k, PoolId pid) = _create(c, 10e18, 0, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        uint256 before = usdg.balanceOf(address(this));
        _price(pid, 1e18, 725_000e18);
        assertEq(usdg.balanceOf(address(this)), before);
        assertEq(hook.spotPrice(pid), 0.67e18);
        assertGt(k.fee, 0);
    }

    function test_buyClimbsAndFeeDoesNotRiseWithVolume() public {
        (, uint256 buyFee,,) = hook.quoteExactIn(key, _buyZfo(), 10e18);
        uint256 tiny = (10e18 * C.FEE_TINY_BPS) / 10_000;
        assertGt(buyFee, (10e18 * C.FEE_FLOOR_BPS) / 10_000);
        assertLt(buyFee, tiny, "the seed is nowhere near the live target");

        usdg.mint(address(this), 20e18);
        _buy(key, address(coin), 10e18);
        assertGt(hook.spotPrice(id), 0.67e18);
        assertLt(hook.spotPrice(id), 1e18);

        (, uint256 second,,) = hook.quoteExactIn(key, _buyZfo(), 10e18);
        assertLe(second, buyFee, "a second clip in the same block does not pay more");

        coin.mint(address(this), 5e18);
        (uint256 sellOut, uint256 sellFee,, uint256 used) = hook.quoteExactIn(key, _sellZfo(), 2e18);
        assertGt(used, 0);
        uint256 sellBps = (sellFee * 10_000) / (sellOut + sellFee);
        uint256 buyBps = (buyFee * 10_000) / 10e18;
        assertApproxEqAbs(sellBps, buyBps, 3, "direction is not a discount");
        _solvent(id, address(coin));
    }

    function test_washDoesNotRaiseTheFee() public {
        uint256 before = hook.bridgeQuote(id).suggestedFeeBps;
        usdg.mint(address(this), 15e18);
        _buy(key, address(coin), 10e18);
        uint256 got = coin.balanceOf(address(this));
        assertGt(got, 0);
        uint256 piece = got / 5;
        (,, bool capped, uint256 used) = hook.quoteExactIn(key, _sellZfo(), piece);
        uint256 sellAmt = capped ? used : piece;
        assertGt(sellAmt, 0);
        _sell(key, address(coin), sellAmt);
        uint256 afterFee = hook.bridgeQuote(id).suggestedFeeBps;
        assertLe(afterFee, before, "volume cannot raise the progress fee");
        assertGt(afterFee, C.FEE_FLOOR_BPS);
        _solvent(id, address(coin));
    }

    function test_sameBlockDepositDoesNotCheapenTheFee() public {
        (, uint256 feeA,,) = hook.quoteExactIn(key, _buyZfo(), 10e18);
        MockERC20 c2 = _newCoin("TWO", 18);
        (PoolKey memory k2, PoolId id2) = _create(c2, 77e18, 0, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        _price(id2, 1e18, 725_000e18);
        usdg.mint(address(this), 40e18);
        hook.deposit(id2, 0, 40e18);
        bool zfo = Currency.unwrap(k2.currency0) != address(c2);
        (, uint256 feeB,,) = hook.quoteExactIn(k2, zfo, 10e18);
        // A $40 deposit moves the progress slide a few bps. It does not cut the fee in half.
        assertApproxEqAbs(feeB, feeA, 0.01e18);
        assertGt(feeB, 0.15e18);
    }

    function test_dutchDriftIsFixedAtCreation() public {
        (uint256 bid, uint256 ask, uint64 at) = hook.dutchState(id);
        assertEq(bid, 0);
        assertEq(ask, 0);
        assertEq(at, uint64(this.clock()));
        skip(1 hours);
        (uint256 bidAged, uint256 askAged,) = hook.dutchState(id);
        uint256 hourGap = C.DUTCH_RATE * 1 hours;
        assertEq(bidAged, hourGap);
        assertEq(askAged, hourGap);
        usdg.mint(address(this), 5e18);
        _buy(key, address(coin), 5e18);
        (uint256 bid2, uint256 ask2, uint64 at2) = hook.dutchState(id);
        assertEq(bid2, 0, "a buy restarts the bid");
        assertLt(ask2, askAged, "a buy consumes the ask");
        assertEq(at2, uint64(this.clock()));

        MockERC20 custom = _newCoin("CUSTOM", 18);
        custom.mint(address(this), 10e18);
        custom.approve(address(hook), type(uint256).max);
        (, PoolId cid) = hook.createPool(_params(address(custom), 10e18, uint64(C.DUTCH_DRIFT_DEFAULT) * 2));
        (uint256 ch, uint256 ca,) = hook.dutchState(cid);
        assertEq(ch, 0, "a passed drift is ignored");
        assertEq(ca, 0);
    }

    function test_noDirectionDiscountOnceAboveTheAnchor() public {
        _climb();
        assertGe(hook.spotPrice(id), 1e18);
        vm.warp(block.timestamp + 8 hours);
        // Refresh the anchor so the stale multiplier is not what this test is measuring.
        _price(id, hook.curve(id).anchor, 725_000e18);
        BridgeStorage.BridgeQuote memory q = hook.bridgeQuote(id);
        assertGe(q.poolPriceWad, q.anchorPriceWad);
        // The book is still far under the live target, so the fee stays near 2%. Eight hours of
        // silence, and the Dutch gap those hours open, do not change it.
        uint256 expect = BridgeFee.baseFeeBps(BridgeCurve.tvl(hook.curve(id)), _target());
        assertEq(q.suggestedFeeBps, expect);
        assertGt(expect, 150);
        (uint256 sellOut, uint256 sellFee,,) = hook.quoteExactIn(key, _sellZfo(), 1e18);
        (, uint256 buyFee,,) = hook.quoteExactIn(key, _buyZfo(), 10e18);
        uint256 buyBps = (buyFee * 10_000) / 10e18;
        assertApproxEqAbs(buyBps, expect, 3, "eight hours of Dutch gap does not change the buy fee");
        // Sell proceeds are net of the arb fee, so fee/(out+fee) is not the schedule.
        assertGt(sellOut, 0);
        assertGt(sellFee, 0);
        assertLt(sellFee, sellOut);
    }

    function test_staleFeedDoesNotRaiseTheFee() public {
        (, uint256 freshFee,,) = hook.quoteExactIn(key, _buyZfo(), 10e18);
        vm.warp(block.timestamp + 30 minutes + 2 hours);
        (, uint256 staleFee,,) = hook.quoteExactIn(key, _buyZfo(), 10e18);
        assertLt(staleFee, (freshFee * 12) / 10, "staleness is not a fee multiplier");
        assertGt(staleFee, 0);
        assertTrue(hook.bridgeQuote(id).stale);
        assertEq(hook.bridgeQuote(id).suggestedFeeBps, BridgeFee.baseFeeBps(BridgeCurve.tvl(hook.curve(id)), _target()));
    }

    function test_oversizedSellIsCappedByPrincipal() public {
        usdg.mint(address(this), 40e18);
        hook.deposit(id, 0, 30e18);
        coin.mint(address(this), 500e18);
        uint256 dump = 200e18;
        uint256 principal = hook.curve(id).protoY + hook.curve(id).lpY;
        (uint256 out,, bool capped, uint256 used) = hook.quoteExactIn(key, _sellZfo(), dump);
        assertLe(out, principal, "a sell cannot pay more than principal");
        assertGt(used, 0);
        assertGt(out, 0);
        (uint256 out2,, bool capped2, uint256 used2) = hook.quoteExactIn(key, _sellZfo(), used);
        assertFalse(capped2, "the quoted size is re-executable");
        assertEq(used2, used);
        assertEq(out2, out);
        if (capped) {
            assertLt(used, dump);
            vm.expectRevert();
            this.execSwap(key, _sellZfo(), dump);
        }

        _sell(key, address(coin), used);
        assertLt(hook.curve(id).protoY + hook.curve(id).lpY, 1e18, "principal can be spent down");
        _solvent(id, address(coin));
    }

    function test_seedGuardDoesNotTrapTheLaunchClimb() public {
        _climb();
        assertGe(hook.spotPrice(id), 1e18);
        assertGt(hook.curve(id).x, hook.curve(id).seedFloor);
    }

    function test_depositPreservesSpotAndCannotMintVirtualCoin() public {
        uint256 p = hook.spotPrice(id);
        usdg.mint(address(this), 2_000e18);
        uint256 sh = hook.deposit(id, 0, 20e18);
        assertEq(hook.spotPrice(id), p);
        assertEq(hook.curve(id).vx, 0);
        assertEq(hook.curve(id).lpX, 0);

        hook.deposit(id, 0, 1_000e18);
        assertEq(hook.spotPrice(id), p, "a large USDG deposit keeps the quote");

        uint256 coinBefore = coin.balanceOf(address(this));
        uint256 usdgBefore = usdg.balanceOf(address(this));
        (uint256 cOut, uint256 uOut) = hook.redeem(id, sh / 2);
        assertEq(cOut, 0, "redeem does not pay seed coin");
        assertLt(uOut, 20e18, "redeem fee comes out of principal, not a 5x boost");
        assertEq(coin.balanceOf(address(this)), coinBefore);
        assertLt(usdg.balanceOf(address(this)), usdgBefore + 20e18);
        _solvent(id, address(coin));
    }

    function test_boostIsFeesOnlyAndLoopDoesNotDrain() public {
        address lp = address(0xB0B);
        usdg.mint(lp, 30e18);
        vm.startPrank(lp);
        usdg.approve(address(hook), type(uint256).max);
        hook.deposit(id, 0, 20e18);
        vm.stopPrank();
        // Fees land on shares that existed at the open of the block. A same-block mint earns nothing.
        this.nextBlock();

        BridgeCurve.S memory pre = hook.curve(id);
        uint256 lVal = pre.lpY + Math.mulDiv(pre.lpX, pre.anchor, C.WAD);
        uint256 pVal = pre.protoY + Math.mulDiv(pre.protoX, pre.anchor, C.WAD);
        (, uint256 fee,,) = hook.quoteExactIn(key, _buyZfo(), 10e18);
        usdg.mint(address(this), 10e18);
        _buy(key, address(coin), 10e18);
        uint256 credit = hook.pendingFee(id, lp);
        uint256 lw = Math.mulDiv(lVal, C.BOOST_START_WAD, C.WAD);
        // Before graduation the whole fee is what the boost splits.
        uint256 compound = fee;
        uint256 boosted = Math.mulDiv(compound, lw, lw + pVal);
        uint256 unboosted = Math.mulDiv(compound, lVal, lVal + pVal);
        assertGt(credit, unboosted);
        assertApproxEqAbs(credit, boosted, 0.01e18);
        assertLt(credit, 20e18, "fee credit is not a multiple of principal");

        address attacker = address(0xA77);
        usdg.mint(attacker, 40e18);
        vm.startPrank(attacker);
        usdg.approve(address(hook), type(uint256).max);
        usdg.approve(address(swapper), type(uint256).max);
        coin.approve(address(swapper), type(uint256).max);
        uint256 start = usdg.balanceOf(attacker);
        // Only the coin the pool itself pays out. External coin sold above the anchor is the intended arb.
        uint256 sh = hook.deposit(id, 0, 15e18);
        _buy(key, address(coin), 8e18);
        uint256 held = coin.balanceOf(attacker);
        if (held > 0) {
            (,,, uint256 sellUsed) = hook.quoteExactIn(key, _sellZfo(), held);
            if (sellUsed > 0) _sell(key, address(coin), sellUsed);
        }
        (uint256 rc,) = hook.redeem(id, sh);
        if (rc > 0) {
            (,,, uint256 used) = hook.quoteExactIn(key, _sellZfo(), rc);
            if (used > 0) _sell(key, address(coin), used);
        }
        uint256 leftover = coin.balanceOf(attacker);
        uint256 bid;
        if (leftover > 0) (bid,,,) = hook.quoteExactIn(key, _sellZfo(), leftover);
        uint256 end = usdg.balanceOf(attacker) + bid;
        vm.stopPrank();
        assertLe(end, start, "round trip including the 5x fee weight loses money");
        _solvent(id, address(coin));
    }

    function test_swapCanParkProceedsAsLp() public {
        usdg.mint(address(this), 10e18);
        uint256 coinBefore = coin.balanceOf(address(this));
        uint256 usdgBefore = usdg.balanceOf(address(this));
        _buyLp(key, address(coin), 10e18);
        assertEq(coin.balanceOf(address(this)), coinBefore, "proceeds stayed in the pool");
        assertLt(usdg.balanceOf(address(this)), usdgBefore);
        assertGt(hook.sharesOf(id, address(this)), 0);
        _solvent(id, address(coin));
    }

    function test_roundTripDoesNotProfit() public {
        usdg.mint(address(this), 12e18);
        uint256 before = usdg.balanceOf(address(this));
        _buy(key, address(coin), 4e18);
        uint256 got = coin.balanceOf(address(this));
        assertGt(got, 0);
        (,,, uint256 used) = hook.quoteExactIn(key, _sellZfo(), got);
        if (used > 0) _sell(key, address(coin), used);
        // USDG coming back is strictly less. Leftover coin was paid for at the discount.
        assertLt(usdg.balanceOf(address(this)), before);
        _solvent(id, address(coin));
    }

    /// forge-config: default.fuzz.runs = 16
    function testFuzz_hookRoundTrip(uint256 amt) public {
        amt = bound(amt, 1e16, 5e18);
        usdg.mint(address(this), amt);
        uint256 beforeBal = usdg.balanceOf(address(this));
        _buy(key, address(coin), amt);
        uint256 got = coin.balanceOf(address(this));
        if (got == 0) return;
        (,,, uint256 used) = hook.quoteExactIn(key, _sellZfo(), got);
        if (used > 0) _sell(key, address(coin), used);
        assertLe(usdg.balanceOf(address(this)), beforeBal);
    }

    /// @dev ERC-6909 claims are one balance on the hook. `usdgHeld` is what keeps a redeem or a
    ///      swap in one pool from spending the other pool's USDG.
    function test_twoPoolsDoNotShareReserves() public {
        MockERC20 other = _newCoin("OTHER", 18);
        (, PoolId id2) = _create(other, 40e18, 0, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        _price(id2, 1e18, 725_000e18);

        usdg.mint(address(this), 40e18);
        uint256 sharesA = hook.deposit(id, 0, 15e18);
        uint256 sharesB = hook.deposit(id2, 0, 20e18);
        _buy(key, address(coin), 5e18);

        uint256 heldA = hook.usdgHeld(id);
        uint256 heldB = hook.usdgHeld(id2);
        uint256 yB = hook.curve(id2).y;
        uint256 xB = hook.curve(id2).x;
        assertGt(heldA, 0);
        assertGt(heldB, 0);
        assertGt(yB, 0);
        assertEq(heldA + heldB, hook.usdgClaimsNorm());

        uint256 bal = usdg.balanceOf(address(this));
        (uint256 coinOut, uint256 usdgOut) = hook.redeem(id, sharesA / 2);
        assertEq(coinOut, 0, "the deposit was USDG");
        assertGt(usdgOut, 0);
        assertLe(usdg.balanceOf(address(this)) - bal, heldA, "A's redeem cannot pay more than A holds");
        assertEq(hook.usdgHeld(id2), heldB);
        assertEq(hook.curve(id2).y, yB);
        assertEq(hook.curve(id2).x, xB);

        coin.mint(address(this), 30e18);
        (uint256 quoted,, bool capped, uint256 used) = hook.quoteExactIn(key, _sellZfo(), 30e18);
        uint256 heldAfterRedeem = hook.usdgHeld(id);
        if (used == 0) {
            vm.expectRevert();
            this.execSwap(key, _sellZfo(), 30e18);
        } else {
            assertLe(quoted, heldAfterRedeem, "the quote cannot promise the other pool's USDG");
            uint256 beforeSell = usdg.balanceOf(address(this));
            _sell(key, address(coin), used);
            assertLe(usdg.balanceOf(address(this)) - beforeSell, heldAfterRedeem);
            if (capped) {
                vm.expectRevert();
                this.execSwap(key, _sellZfo(), 30e18);
            }
        }
        assertEq(hook.usdgHeld(id2), heldB, "a sell in A does not draw B");
        assertEq(hook.curve(id2).y, yB);
        assertEq(hook.curve(id2).x, xB);
        assertTrue(hook.reserveOk(id));
        assertTrue(hook.reserveOk(id2));

        uint256 beforeB = usdg.balanceOf(address(this));
        (, uint256 paidB) = hook.redeem(id2, sharesB / 2);
        assertGt(paidB, 0, "B can still pay its own USDG");
        assertGt(usdg.balanceOf(address(this)), beforeB);
        assertLt(hook.usdgHeld(id2), heldB);
        assertTrue(hook.reserveOk(id2));
        _solvent(id, address(coin));
        _solvent(id2, address(other));
    }

    function test_creatorCutOnlyAfterGraduationAndWalletIsFixed() public {
        (bool moved,) = address(hook)
            .call(abi.encodeWithSignature("setCreator(bytes32,address)", PoolId.unwrap(id), address(0xCAFE)));
        assertFalse(moved, "there is no admin setter; transferCreator is the only path");

        _graduate();
        address stranger = address(0xBAD);
        usdg.mint(address(this), 20e18);
        _buy(key, address(coin), 20e18);
        assertGt(hook.creatorFees(id), 0);

        vm.prank(stranger);
        vm.expectRevert(BridgeStorage.OnlyCreator.selector);
        hook.claimCreatorFees(id);

        uint256 bal = usdg.balanceOf(address(this));
        hook.claimCreatorFees(id);
        assertGt(usdg.balanceOf(address(this)), bal);
        _solvent(id, address(coin));
    }

    function test_outflowParametersDoNotCapSells() public {
        MockERC20 c = _newCoin("CAP", 18);
        (PoolKey memory k, PoolId pid) =
            _create(c, 77e18, 1e18, C.FLOOR_BPS, C.DISCOUNT_BPS, 1_000, C.OUTFLOW_PER_BLOCK);
        _price(pid, 1e18, 725_000e18);
        usdg.mint(address(this), 40e18);
        hook.deposit(pid, 0, 30e18);
        c.mint(address(this), 100e18);
        bool zfo = Currency.unwrap(k.currency0) == address(c);
        (,,, uint256 used) = hook.quoteExactIn(k, zfo, 3e18);
        _swap(k, zfo, used, false);
        (,,, uint256 used2) = hook.quoteExactIn(k, zfo, 3e18);
        assertGt(used2, 0);
        _swap(k, zfo, used2, false);
    }

    function test_hookTakesNoEth() public {
        (bool ok,) = address(hook).call{value: 1}("");
        assertFalse(ok);
        assertEq(address(hook).balance, 0);
    }

    function execSwap(PoolKey calldata k, bool zeroForOne, uint256 amountIn) external {
        _swap(k, zeroForOne, amountIn, false);
    }

    function _buyZfo() internal view returns (bool) {
        return Currency.unwrap(key.currency0) != address(coin);
    }

    function _sellZfo() internal view returns (bool) {
        return Currency.unwrap(key.currency0) == address(coin);
    }

    function _params(address c, uint256 coinSeed, uint64 drift) internal returns (BridgeStorage.CreateParams memory) {
        MockV3Pool pool = _registerV3(MockERC20(c));
        pool.pin(0);
        pool.setLiquidity(_liqFor(20_000e18, TickMath.getSqrtPriceAtTick(0), c < address(usdg), 18));
        return BridgeStorage.CreateParams({
            coin: c,
            creator: address(this),
            floorBps: C.FLOOR_BPS,
            discountBps: C.DISCOUNT_BPS,
            outflowCapBps: 0,
            outflowWindow: 0,
            anchorKind: C.ANCHOR_V3,
            refPool: address(pool),
            coinSeed: coinSeed,
            dutchDrift: drift,
            refPoolId: bytes32(0),
            tickSpacing: 0,
            refFee: V3_FEE,
            refTickSpacing: 0,
            refHooks: address(0)
        });
    }

    function clock() external view returns (uint256) {
        return block.timestamp;
    }

    function _target() internal view returns (uint256) {
        if (hook.curve(id).anchor == 0) return 0;
        return (hook.smoothedReference(id) * C.GRAD_NUM) / C.GRAD_DEN;
    }

    function _climb() internal {
        usdg.mint(address(this), 80e18);
        for (uint256 i; i < 40 && hook.spotPrice(id) < 1e18; ++i) {
            _buy(key, address(coin), 2e18);
        }
        assertGe(hook.spotPrice(id), 1e18);
    }

    function _graduate() internal {
        assertFalse(_graduated());
        usdg.mint(address(this), 100_000e18);
        hook.deposit(id, 0, 100_000e18);
        assertTrue(_graduated(), "LP deposits count, and status flips in this call");
    }

    function _inventoryOver() internal view returns (bool) {
        BridgeCurve.S memory s = hook.curve(id);
        uint256 v = Math.mulDiv(s.protoX, s.anchor, C.WAD) + s.protoY + s.lockedY + s.feePot;
        uint256 target = (hook.smoothedReference(id) * C.GRAD_NUM) / C.GRAD_DEN;
        return target != 0 && v >= target;
    }

    function _floorAmt() internal view returns (uint256) {
        BridgeCurve.S memory s = hook.curve(id);
        return ((s.protoY + s.lpY) * C.FLOOR_BPS) / C.BPS;
    }

    function _graduated() internal view returns (bool) {
        return hook.bridgeQuote(id).graduated;
    }

    function _solvent(PoolId poolId, address c) internal view {
        assertTrue(hook.reserveOk(poolId));
        BridgeCurve.S memory s = hook.curve(poolId);
        assertEq(IERC6909Claims(address(manager)).balanceOf(address(hook), Currency.wrap(c).toId()), s.x);
        assertEq(
            IERC6909Claims(address(manager)).balanceOf(address(hook), Currency.wrap(address(usdg)).toId()),
            hook.usdgClaimsNorm()
        );
    }
}

contract DiscipleHookDec6Test is BridgeFixture {
    function test_sixDecimalUsdg() public {
        _deployStack(6);
        coin = _newCoin("JESUS", 18);
        (key, id) = _create(coin, 77e18, 5e6, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        _price(id, 1e18, 725_000e18);
        // Six-decimal quote prices land on a tick, so the anchor is within one tick of $1.
        assertApproxEqRel(hook.spotPrice(id), 0.67e18, 0.0002e18);
        usdg.mint(address(this), 20e6);
        _buy(key, address(coin), 10e6);
        assertGt(coin.balanceOf(address(this)), 0);
        assertGt(hook.spotPrice(id), 0.67e18);
        assertTrue(hook.reserveOk(id));
    }
}
