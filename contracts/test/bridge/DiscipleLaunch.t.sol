// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {BridgeStorage} from "../../src/bridge/BridgeStorage.sol";
import {BridgeCurve} from "../../src/bridge/libraries/BridgeCurve.sol";
import {BridgeFee} from "../../src/bridge/libraries/BridgeFee.sol";
import {BridgeConstants as C} from "../../src/bridge/libraries/BridgeConstants.sol";
import {BridgeFixture} from "./BridgeFixture.sol";
import {MockERC20, MockV2Pair} from "./mocks/BridgeMocks.sol";

/// @notice Dutch quotes, the progress-only fee, the status time window, and v4 anchors.
contract DiscipleLaunchTest is BridgeFixture {
    using PoolIdLibrary for PoolKey;

    function setUp() public {
        _deployStack(18);
        coin = _newCoin("JESUS", 18);
        (key, id) = _create(coin, 77e18, 5e18, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        _price(id, 1e18, 725_000e18);
    }

    function test_gapZeroLeavesTheLaunchDiscount() public view {
        (uint256 gap, uint256 bid, uint256 ask, uint256 bidUsdg,, uint256 feeBps) = hook.dutchQuote(id);
        assertEq(gap, 0);
        assertEq(bid, 1e18);
        assertEq(ask, 1e18);
        assertEq(bidUsdg, 0, "a fresh quote does not override the curve");
        assertEq(hook.spotPrice(id), 0.67e18);
        assertEq(feeBps, hook.bridgeQuote(id).suggestedFeeBps);
    }

    function test_dutchDriftsBothWaysAndResetsTogether() public {
        skip(1 hours);
        (uint256 gap, uint256 bid, uint256 ask, uint256 size1,, uint256 fee1) = hook.dutchQuote(id);
        assertApproxEqAbs(gap, 0.01e18, 1e12, "default drift is 1% of the anchor per hour");
        assertApproxEqAbs(bid, 1.01e18, 1e6);
        assertApproxEqAbs(ask, 0.99e18, 1e6);
        assertGt(size1, 1e18);
        assertLe(size1, 77e18 / 20 + 1, "the slice is capped at 5% of TVL");
        assertEq(fee1, BridgeFee.baseFeeBps(BridgeCurve.tvl(hook.curve(id)), _target()));

        skip(9 hours);
        (uint256 gap2,,, uint256 size2,, uint256 fee2) = hook.dutchQuote(id);
        assertGt(gap2, gap);
        assertLt(size2, size1, "a wider gap offers less");
        assertEq(fee2, fee1, "the fee does not rise with the gap");

        // Ask is 0.90, still above the 0.67 curve, so a buy walks the curve. Only the ask clock resets.
        usdg.mint(address(this), 2e18);
        uint256 spotBefore = hook.spotPrice(id);
        _buy(key, address(coin), 1e18);
        assertGt(hook.spotPrice(id), spotBefore);
        (uint256 afterBuy, uint256 bidAfter, uint256 askAfter,,,) = hook.dutchQuote(id);
        assertEq(afterBuy, 0, "a buy closes the ask");
        assertGt(bidAfter, hook.curve(id).anchor, "the bid keeps drifting");
        assertEq(askAfter, hook.curve(id).anchor);

        skip(40 hours);
        (uint256 wide, uint256 bidW, uint256 askW, uint256 sizeW,,) = hook.dutchQuote(id);
        assertGt(wide, 0.33e18, "the ask has fallen through the launch price");
        assertGt(bidW, hook.curve(id).anchor);
        assertLt(askW, hook.spotPrice(id));
        assertLt(sizeW, size2);

        uint256 spot = hook.spotPrice(id);
        uint256 coinBefore = coin.balanceOf(address(this));
        usdg.mint(address(this), sizeW);
        _buy(key, address(coin), sizeW);
        assertGt(coin.balanceOf(address(this)), coinBefore);
        (uint256 closed, uint256 bidClosed,,,,) = hook.dutchQuote(id);
        if (sizeW >= C.DUTCH_MIN_SLICE) {
            assertEq(closed, 0, "a buy at the minimum notional closes the ask");
        } else {
            assertGt(closed, 0, "a fill under the minimum notional leaves the ask clock running");
        }
        assertGt(bidClosed, hook.curve(id).anchor, "the bid clock was not the side that filled");
        // The slice is retargeted back onto the curve, so one Dutch fill does not walk the spot to the ask.
        assertApproxEqRel(hook.spotPrice(id), spot, 0.02e18);
        assertGe(hook.curve(id).x, hook.curve(id).seedFloor, "the seed guard still binds");
    }

    function test_graduationReversesAndIncentivesFollowProgress() public {
        _openBook();
        uint256 lowFee = hook.bridgeQuote(id).suggestedFeeBps;
        assertLt(lowFee, 80, "over the line, the fee is already the low end");
        _finishWindow(true);
        assertTrue(hook.bridgeQuote(id).graduated);

        usdg.mint(address(this), 5e18);
        _buy(key, address(coin), 1e18);
        uint256 cut = hook.creatorFees(id);
        assertGt(cut, 0, "the creator cut is on while status is on");
        skip(1 hours);
        (,,, uint256 tight,,) = hook.dutchQuote(id);

        // Twelve half-lives put the reference smooth on $2M. Status is still on: this call only
        // starts the off-window. The fee and the Dutch slice have already stepped back up.
        skip(6 hours);
        _price(id, hook.curve(id).anchor, 2_000_000e18);
        assertTrue(hook.bridgeQuote(id).graduated, "the first reading under the target does not flip");
        uint256 highFee = hook.bridgeQuote(id).suggestedFeeBps;
        assertGt(highFee, 150, "progress raises the fee before status turns off");
        assertGt(highFee, lowFee);
        _buy(key, address(coin), 1e18);
        // The hour that opens the Dutch quote is inside the 77-minute off-window.
        skip(1 hours);
        (,,, uint256 reopened,,) = hook.dutchQuote(id);
        assertGt(reopened, tight, "lower progress reopens the Dutch slice");
        hook.poke(id);
        assertTrue(hook.bridgeQuote(id).graduated, "one hour under the target does not flip");
        assertGt(hook.bridgeQuote(id).suggestedFeeBps, 150, "the fee stays stepped up while status is still on");

        skip(C.GRADUATION_WINDOW - 1 hours - 1 minutes);
        hook.poke(id);
        assertTrue(hook.bridgeQuote(id).graduated, "inside the window, status stays on");
        skip(1 minutes);
        uint256 poker = usdg.balanceOf(address(this));
        hook.poke(id);
        assertFalse(hook.bridgeQuote(id).graduated, "a full window under the target turns status off");
        assertEq(usdg.balanceOf(address(this)), poker, "poke pays the caller nothing");
        uint256 paused = hook.creatorFees(id);
        _buy(key, address(coin), 1e18);
        assertEq(hook.creatorFees(id), paused, "the creator cut pauses while status is off");

        // Protocol inventory has to be over the target. An LP deposit is not inventory.
        coin.mint(address(this), 250_000e18);
        hook.deposit(id, 250_000e18, 0);
        hook.poke(id);
        assertFalse(hook.bridgeQuote(id).graduated, "a deposit is not graduation TVL");
        _easeTo(400e18);
        hook.poke(id);
        assertFalse(hook.bridgeQuote(id).graduated, "the first reading back over the target does not flip");
        uint256 roundTrip = usdg.balanceOf(address(this));
        hook.poke(id);
        assertEq(usdg.balanceOf(address(this)), roundTrip, "a second poke in the block pays nothing");
        skip(C.GRADUATION_WINDOW - 1 minutes);
        hook.poke(id);
        assertFalse(hook.bridgeQuote(id).graduated, "inside the window, a deposit cannot re-graduate");
        skip(1 minutes);
        hook.poke(id);
        assertTrue(hook.bridgeQuote(id).graduated, "a full window over the target turns status back on");
    }

    function test_dipInsideTheWindowDoesNotChangeStatus() public {
        _openBook();
        _finishWindow(true);
        uint256 feeOn = hook.bridgeQuote(id).suggestedFeeBps;
        skip(6 hours);
        // One smooth step is capped, so the reference has to move far enough that this step alone
        // puts the target above pool TVL, and the way back has to fit in the same 77 minutes.
        _price(id, hook.curve(id).anchor, 2_000e18);
        assertTrue(hook.bridgeQuote(id).graduated, "the first reading under the target starts the off-window");
        assertGt(hook.bridgeQuote(id).suggestedFeeBps, feeOn, "the fee steps up before status turns off");
        skip(30 minutes);
        _price(id, hook.curve(id).anchor, 1e18);
        assertTrue(hook.bridgeQuote(id).graduated, "crossing back inside the window clears the clock");
        skip(C.GRADUATION_WINDOW);
        hook.poke(id);
        assertTrue(hook.bridgeQuote(id).graduated, "a cleared clock does not flip on a later poke");
    }

    function test_regraduationRestoresTheCreatorCut() public {
        _openBook();
        _finishWindow(true);
        _dropUnder();
        assertFalse(hook.bridgeQuote(id).graduated);
        uint256 paused = hook.creatorFees(id);
        _easeTo(400e18);
        _finishWindow(true);
        assertTrue(hook.bridgeQuote(id).graduated, "crossing back above the target re-graduates");
        usdg.mint(address(this), 2e18);
        _buy(key, address(coin), 1e18);
        assertGt(hook.creatorFees(id), paused, "the creator cut resumes");
    }

    function test_preGraduationFeeStaysWithLps() public {
        assertFalse(hook.bridgeQuote(id).graduated);
        uint256 amount = 1e18;
        (, uint256 fee,,) = hook.quoteExactIn(key, _buyZfo(), amount);
        uint256 yBefore = hook.curve(id).y;
        usdg.mint(address(this), amount);
        _buy(key, address(coin), amount);
        assertEq(hook.creatorFees(id), 0);
        assertEq(hook.curve(id).lockedY, 0);
        assertGt(fee, 0);
        assertEq(hook.curve(id).y - yBefore, amount, "before graduation the whole payment stays in the book");
    }

    function test_graduatedSplitLocksLiquidityAndRevertsWhenStatusTurnsOff() public {
        _openBook();
        _finishWindow(true);
        assertTrue(hook.bridgeQuote(id).graduated);

        uint256 amount = 1e18;
        (, uint256 fee,,) = hook.quoteExactIn(key, _buyZfo(), amount);
        (uint256 creator, uint256 lp, uint256 locked) = _graduatedSlices(fee);
        assertEq(creator + locked + lp, fee);
        assertEq(creator, (fee * C.FEE_CREATOR_BPS) / C.BPS);
        assertEq(locked, (fee * C.FEE_LOCKED_BPS) / C.BPS);
        assertGe(lp, locked, "the remainder, including dust, stays with LPs");

        uint256 yBefore = hook.curve(id).y;
        usdg.mint(address(this), amount);
        _buy(key, address(coin), amount);
        assertEq(hook.creatorFees(id), creator);
        assertEq(hook.curve(id).lockedY, locked);
        assertEq(hook.curve(id).y - yBefore, amount - creator, "only the creator share leaves the book");

        uint256 lockedAfterBuy = hook.curve(id).lockedY;
        uint256 held = coin.balanceOf(address(this));
        assertGt(held, 0);
        (,, bool capped, uint256 used) = hook.quoteExactIn(key, _sellZfo(), held);
        uint256 sellAmt = capped ? used : held;
        assertGt(sellAmt, 0);
        (, uint256 sellFee,,) = hook.quoteExactIn(key, _sellZfo(), sellAmt);
        (,, uint256 sellLocked) = _graduatedSlices(sellFee);
        _sell(key, address(coin), sellAmt);
        assertEq(hook.curve(id).lockedY, lockedAfterBuy + sellLocked, "a sell adds locked fees and cannot spend them");

        _dropUnder();
        assertFalse(hook.bridgeQuote(id).graduated);
        uint256 pausedCreator = hook.creatorFees(id);
        uint256 pausedLocked = hook.curve(id).lockedY;
        usdg.mint(address(this), amount);
        _buy(key, address(coin), amount);
        assertEq(hook.creatorFees(id), pausedCreator, "ungraduation stops the creator share");
        assertEq(hook.curve(id).lockedY, pausedLocked, "ungraduation stops new locked liquidity");

        // A swap does not mint shares. Deposit coin, then exit, and the locked fees stay.
        coin.mint(address(this), 10e18);
        uint256 shares = hook.deposit(id, 10e18, 0);
        assertGt(shares, 0);
        hook.redeem(id, shares);
        assertEq(hook.sharesOf(id, address(this)), 0);
        BridgeCurve.S memory s = hook.curve(id);
        assertEq(s.lockedY, pausedLocked, "redeeming every LP share leaves locked liquidity");
        assertEq(s.protoY + s.lpY + s.feePot + s.lockedY, s.y);
        assertGe(s.y, s.lockedY);
    }

    function test_noBuilderRoleAndCreatorStaysPut() public {
        _openBook();
        _finishWindow(true);
        usdg.mint(address(this), 1e18);
        _buy(key, address(coin), 1e18);
        uint256 locked = hook.curve(id).lockedY;
        assertGt(hook.creatorFees(id), 0);
        assertGt(locked, 0);

        bytes32 raw = PoolId.unwrap(id);
        assertFalse(_call("builder()"));
        assertFalse(_call("proposeBuilder(address)", address(0xBEEF)));
        assertFalse(_call("acceptBuilder()"));
        assertFalse(_call("claimBuilderFees(bytes32)", raw));
        assertFalse(_call("setCreator(bytes32,address)", raw, address(0xCAFE)));
        assertFalse(_call("rescueEth(address)", address(this)));

        uint256 before = usdg.balanceOf(address(this));
        hook.claimCreatorFees(id);
        assertGt(usdg.balanceOf(address(this)), before);
        assertEq(hook.curve(id).lockedY, locked, "a creator claim does not touch locked liquidity");
    }

    function _call(string memory sig) internal returns (bool ok) {
        (ok,) = address(hook).call(abi.encodeWithSignature(sig));
    }

    function _call(string memory sig, address a) internal returns (bool ok) {
        (ok,) = address(hook).call(abi.encodeWithSignature(sig, a));
    }

    function _call(string memory sig, bytes32 a) internal returns (bool ok) {
        (ok,) = address(hook).call(abi.encodeWithSignature(sig, a));
    }

    function _call(string memory sig, bytes32 a, address b) internal returns (bool ok) {
        (ok,) = address(hook).call(abi.encodeWithSignature(sig, a, b));
    }

    function test_crossingBackResetsTheGraduationTimer() public {
        _openBook();
        assertFalse(hook.bridgeQuote(id).graduated, "the catch-up starts the window");
        skip(30 minutes);
        hook.poke(id);
        assertFalse(hook.bridgeQuote(id).graduated);

        // The next reading is already under the line, so time spent over the target does not graduate.
        skip(6 hours);
        _price(id, 1e18, 2_000_000e18);
        assertFalse(hook.bridgeQuote(id).graduated);
        _easeTo(400e18);
        assertFalse(hook.bridgeQuote(id).graduated, "re-crossing starts a new window");
        skip(C.GRADUATION_WINDOW - 1 minutes);
        hook.poke(id);
        assertFalse(hook.bridgeQuote(id).graduated);
        skip(1 minutes);
        hook.poke(id);
        assertTrue(hook.bridgeQuote(id).graduated);
    }

    function test_v2ReservesFeedTheRing() public {
        MockERC20 c = _newCoin("V2", 18);
        MockV2Pair pair = new MockV2Pair(address(c), address(usdg));
        pair.setReserves(1_000_000e18, 1_000_000e18);
        usdg.mint(address(pair), 50_000e18);
        v2Factory.setPair(address(c), address(usdg), address(pair));
        c.mint(address(this), 10e18);
        c.approve(address(hook), type(uint256).max);
        (, PoolId pid) = hook.createPool(_v2(address(c), address(pair), 10e18));
        assertEq(hook.anchorKind(pid), C.ANCHOR_V2);
        assertEq(hook.curve(pid).anchor, 0, "a cold ring is not a 30-minute TWAP");
        _warmSample(pid);
        assertEq(hook.curve(pid).anchor, 1e18);
        assertEq(hook.spotPrice(pid), 0.67e18);
        (uint256 price, uint256 tvl) = hook.liveAnchor(pid);
        assertEq(price, 1e18);
        assertGt(tvl, 40_000e18);
        skip(3 hours);
        assertTrue(hook.bridgeQuote(pid).stale, "a same-chain anchor ages out too");
    }

    function test_v4SelfSampleWaitsForItsOwnRing() public {
        MockERC20 c = _newCoin("SAMPLE", 18);
        bool coin0 = address(c) < address(usdg);
        PoolKey memory ref = PoolKey({
            currency0: Currency.wrap(coin0 ? address(c) : address(usdg)),
            currency1: Currency.wrap(coin0 ? address(usdg) : address(c)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        manager.initialize(ref, TickMath.getSqrtPriceAtTick(0));
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(manager);
        c.mint(address(this), 1e24);
        usdg.mint(address(this), 1e24);
        c.approve(address(lp), type(uint256).max);
        usdg.approve(address(lp), type(uint256).max);
        lp.modifyLiquidity(
            ref, IPoolManager.ModifyLiquidityParams({tickLower: -60, tickUpper: 60, liquidityDelta: 1e18, salt: 0}), ""
        );

        c.mint(address(this), 10e18);
        c.approve(address(hook), type(uint256).max);
        (, PoolId pid) = hook.createPool(_v4(address(c), 10e18, PoolId.unwrap(ref.toId()), address(0)));
        assertEq(hook.curve(pid).anchor, 0, "one sample is not a 30-minute TWAP");
        _warmSample(pid);
        assertEq(hook.curve(pid).anchor, 1e18);
        assertEq(hook.spotPrice(pid), 0.67e18);
        (uint256 price, uint256 tvl) = hook.liveAnchor(pid);
        assertEq(price, 1e18);
        assertGt(tvl, 0);
        assertFalse(hook.bridgeQuote(pid).stale);
    }

    /// @dev A push, poke, and push-back in one transaction must not weight the TWAP. The ring
    ///      accrues the tick that was already observed in a previous block, and only keeps a new
    ///      tick when the next block still shows it.
    function test_v4SelfSampleIgnoresAnInTxPush() public {
        MockERC20 c = _newCoin("PUSH", 18);
        bool coin0 = address(c) < address(usdg);
        PoolKey memory ref = PoolKey({
            currency0: Currency.wrap(coin0 ? address(c) : address(usdg)),
            currency1: Currency.wrap(coin0 ? address(usdg) : address(c)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        manager.initialize(ref, TickMath.getSqrtPriceAtTick(0));
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(manager);
        c.mint(address(this), 1e24);
        usdg.mint(address(this), 1e24);
        c.approve(address(lp), type(uint256).max);
        usdg.approve(address(lp), type(uint256).max);
        c.approve(address(swapper), type(uint256).max);
        usdg.approve(address(swapper), type(uint256).max);
        lp.modifyLiquidity(
            ref, IPoolManager.ModifyLiquidityParams({tickLower: -60, tickUpper: 60, liquidityDelta: 1e18, salt: 0}), ""
        );

        c.mint(address(this), 10e18);
        c.approve(address(hook), type(uint256).max);
        (, PoolId pid) = hook.createPool(_v4(address(c), 10e18, PoolId.unwrap(ref.toId()), address(0)));
        _warmSample(pid);
        assertEq(hook.curve(pid).anchor, 1e18);

        // New timestamp, same block. The poke while the price is pushed stores a candidate only.
        skip(1 minutes);
        _swapRef(ref, true, TickMath.MIN_SQRT_PRICE + 1);
        (, int24 pushed,,) = StateLibrary.getSlot0(manager, ref.toId());
        assertTrue(pushed < -60, "the in-tx swap moved the reference");
        hook.poke(pid);
        _swapRef(ref, false, TickMath.getSqrtPriceAtTick(0));
        (, int24 restored,,) = StateLibrary.getSlot0(manager, ref.toId());
        assertEq(restored, 0, "the price is back where the window started");
        hook.poke(pid);
        assertEq(hook.curve(pid).anchor, 1e18, "the same-transaction spike is not the anchor");

        // The next block still shows the restored price, so the spike is never promoted into the TWAP.
        vm.roll(block.number + 1);
        skip(30 minutes);
        hook.poke(pid);
        assertEq(hook.curve(pid).anchor, 1e18, "a later sample does not accrue the reverted tick");
    }

    function test_nonCanonicalV2AndUnknownKindRevert() public {
        MockERC20 c = _newCoin("FAKEV2", 18);
        MockV2Pair pair = new MockV2Pair(address(c), address(usdg));
        pair.setReserves(1e18, 1e18);
        c.mint(address(this), 10e18);
        c.approve(address(hook), type(uint256).max);
        vm.expectRevert(BridgeStorage.BadCreate.selector);
        hook.createPool(_v2(address(c), address(pair), 10e18));

        v2Factory.setPair(address(c), address(usdg), address(pair));
        BridgeStorage.CreateParams memory bad = _v2(address(c), address(pair), 10e18);
        bad.anchorKind = 9;
        vm.expectRevert(BridgeStorage.BadCreate.selector);
        hook.createPool(bad);
    }

    function _v2(address c, address pair, uint256 seed) internal view returns (BridgeStorage.CreateParams memory p) {
        p.coin = c;
        p.creator = address(this);
        p.floorBps = C.FLOOR_BPS;
        p.discountBps = C.DISCOUNT_BPS;
        p.anchorKind = C.ANCHOR_V2;
        p.refPool = pair;
        p.coinSeed = seed;
    }

    function _v4(address c, uint256 seed, bytes32 refPool, address refHooks)
        internal
        view
        returns (BridgeStorage.CreateParams memory p)
    {
        p.coin = c;
        p.creator = address(this);
        p.floorBps = C.FLOOR_BPS;
        p.discountBps = C.DISCOUNT_BPS;
        p.anchorKind = C.ANCHOR_V4;
        p.coinSeed = seed;
        p.refPoolId = refPool;
        p.refFee = 3000;
        p.refTickSpacing = 60;
        p.refHooks = refHooks;
    }

    /// @dev Several later blocks, then a 30-minute span, before the self-sample mean is trusted.
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

    function _target() internal pure returns (uint256) {
        return (725_000e18 * C.GRAD_NUM) / C.GRAD_DEN;
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

    function _buyZfo() internal view returns (bool) {
        return Currency.unwrap(key.currency0) != address(coin);
    }

    function _sellZfo() internal view returns (bool) {
        return Currency.unwrap(key.currency0) == address(coin);
    }

    /// @dev Graduated split of a gross fee. 3,333 creator, 3,333 locked, remainder LPs.
    function _graduatedSlices(uint256 fee) internal pure returns (uint256 creator, uint256 lp, uint256 locked) {
        creator = (fee * C.FEE_CREATOR_BPS) / C.BPS;
        locked = (fee * C.FEE_LOCKED_BPS) / C.BPS;
        lp = fee - creator - locked;
    }

    function _fresh(uint256 refTvl) internal {
        coin = _newCoin("GRAD", 18);
        (key, id) = _create(coin, 77e18, 0, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        _price(id, 1e18, refTvl);
    }

    /// @dev Six hours is twelve half-lives, so the reference smooth sits on the latest reading and
    ///      the on-window starts if spot pool TVL is over the target. It does not graduate in this call.
    function _catchUp() internal {
        skip(6 hours);
        hook.poke(id);
    }

    function _openBook() internal {
        // 12% of $400 is $48. The $77 seed is already over it. The price update starts the clock.
        _fresh(400e18);
        assertFalse(hook.bridgeQuote(id).graduated, "the first over-reading starts the window");
    }

    /// @dev Walk the capped smooth toward `refTvl`. Stop on the write that puts protocol inventory
    ///      back over the target, so the on-clock starts at that timestamp and a later 77-minute wait
    ///      is measured from the crossing. Continuing would itself run the window out.
    function _easeTo(uint256 refTvl) internal {
        uint256 px = hook.curve(id).anchor;
        if (px == 0) px = 1e18;
        for (uint256 i; i < 64; ++i) {
            if (hook.bridgeQuote(id).stale || hook.curve(id).anchor == 0) _price(id, px, refTvl);
            if (_inventoryOver()) return;
            uint256 smooth = hook.smoothedReference(id);
            uint256 gap = smooth > refTvl ? smooth - refTvl : refTvl - smooth;
            if (refTvl != 0 && gap * 20 <= refTvl) return;
            skip(30 minutes);
        }
    }

    function _inventoryOver() internal view returns (bool) {
        BridgeCurve.S memory s = hook.curve(id);
        uint256 v = Math.mulDiv(s.protoX, s.anchor, C.WAD) + s.protoY + s.lockedY + s.feePot;
        uint256 target = (hook.smoothedReference(id) * C.GRAD_NUM) / C.GRAD_DEN;
        return target != 0 && v >= target;
    }

    /// @dev The window is already running. `turningOn` is the side this wait should reach.
    function _finishWindow(bool turningOn) internal {
        skip(C.GRADUATION_WINDOW - 1 minutes);
        hook.poke(id);
        assertEq(hook.bridgeQuote(id).graduated, !turningOn, "inside the window, status does not flip");
        skip(1 minutes);
        hook.poke(id);
        assertEq(hook.bridgeQuote(id).graduated, turningOn);
    }

    function _dropUnder() internal {
        skip(6 hours);
        _price(id, hook.curve(id).anchor, 2_000_000e18);
        assertTrue(hook.bridgeQuote(id).graduated, "the off-window starts on the first under-reading");
        skip(C.GRADUATION_WINDOW);
        hook.poke(id);
        assertFalse(hook.bridgeQuote(id).graduated);
    }

    /// @dev Reference TVL that puts `poolTvl / target` at `ratioWad` (1e18 = right on the target).
    function _refFor(uint256 poolTvl, uint256 ratioWad) internal pure returns (uint256) {
        uint256 target = (poolTvl * 1e18) / ratioWad;
        return (target * 100) / 12;
    }

    function _climb() internal {
        usdg.mint(address(this), 80e18);
        for (uint256 i; i < 40 && hook.spotPrice(id) < 1e18; ++i) {
            _buy(key, address(coin), 2e18);
        }
        assertGe(hook.spotPrice(id), 1e18);
    }
}
