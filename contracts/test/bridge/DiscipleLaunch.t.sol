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

/// @notice Dutch quotes, the progress-only fee, immediate graduation, and v2/v4 anchors.
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
        uint256 hourGap = C.DUTCH_RATE * 1 hours;
        assertEq(gap, hourGap, "both sides reach 77% in 12 hours");
        assertApproxEqAbs(bid, Math.mulDiv(1e18, C.WAD + hourGap, C.WAD), 1e12);
        assertApproxEqAbs(ask, Math.mulDiv(1e18, C.WAD - hourGap, C.WAD), 1e12);
        assertApproxEqAbs(size1, BridgeCurve.tvl(hook.curve(id)), 1, "the quoted size is pool depth");
        assertEq(fee1, BridgeFee.baseFeeBps(BridgeCurve.tvl(hook.curve(id)), _target()));

        skip(5 hours);
        (uint256 gap2,,, uint256 size2,, uint256 fee2) = hook.dutchQuote(id);
        assertGt(gap2, gap);
        assertEq(size2, size1, "a wider gap is not a smaller slice");
        assertEq(fee2, fee1, "the fee does not rise with the gap");
        assertLt(gap2, C.DUTCH_GAP_CAP);

        usdg.mint(address(this), 2e18);
        uint256 spotBefore = hook.spotPrice(id);
        _buy(key, address(coin), 1e18);
        (uint256 afterBuy, uint256 bidAfter, uint256 askAfter,,,) = hook.dutchQuote(id);
        assertEq(bidAfter, hook.curve(id).anchor, "a buy restarts the bid");
        assertLt(afterBuy, gap2, "a buy consumes the ask in proportion to size");
        // Less remaining discount means a higher ask, closer to the anchor.
        assertGt(askAfter, Math.mulDiv(hook.curve(id).anchor, C.WAD - gap2, C.WAD));
        // Six hours puts the ask under the 0.67 launch price, so the fill is Dutch and spot is put back.
        if (gap2 > 0.33e18) assertApproxEqRel(hook.spotPrice(id), spotBefore, 0.02e18);

        skip(12 hours);
        (uint256 wide, uint256 bidW, uint256 askW,,,) = hook.dutchQuote(id);
        assertEq(wide, C.DUTCH_GAP_CAP, "the ask gap stops at 77%");
        assertGt(bidW, hook.curve(id).anchor);
        assertLt(askW, hook.spotPrice(id));
        uint256 twelve = C.DUTCH_RATE * 12 hours;
        assertLt(twelve, C.DUTCH_GAP_CAP, "integer division lands a few wei under 77% at exactly 12 hours");
    }

    function test_graduationReversesAndIncentivesFollowProgress() public {
        _openBook();
        assertTrue(hook.bridgeQuote(id).graduated);
        assertEq(hook.bridgeQuote(id).suggestedFeeBps, C.FEE_GRAD_BPS);

        usdg.mint(address(this), 5e18);
        _buy(key, address(coin), 1e18);
        uint256 cut = hook.creatorFees(id);
        assertGt(cut, 0, "the creator cut is on while status is on");

        uint256 poker = usdg.balanceOf(address(this));
        hook.poke(id);
        assertEq(usdg.balanceOf(address(this)), poker, "poke pays the caller nothing");

        _dropUnder();
        assertFalse(hook.bridgeQuote(id).graduated, "dropping under the target turns status off in this call");
        assertGt(hook.bridgeQuote(id).suggestedFeeBps, C.FEE_GRAD_BPS, "the fee steps up with progress");
        uint256 paused = hook.creatorFees(id);
        usdg.mint(address(this), 1e18);
        _buy(key, address(coin), 1e18);
        assertEq(hook.creatorFees(id), paused, "the creator cut pauses while status is off");

        usdg.mint(address(this), 2_000e18);
        hook.deposit(id, 0, 2_000e18);
        assertTrue(hook.bridgeQuote(id).graduated, "an LP deposit that crosses the target graduates immediately");
    }

    function test_dipTurnsStatusOffImmediately() public {
        _openBook();
        uint256 feeOn = hook.bridgeQuote(id).suggestedFeeBps;
        assertEq(feeOn, C.FEE_GRAD_BPS);
        _dropUnder();
        assertFalse(hook.bridgeQuote(id).graduated);
        assertGt(hook.bridgeQuote(id).suggestedFeeBps, feeOn);
        hook.poke(id);
        assertFalse(hook.bridgeQuote(id).graduated, "a later poke does not turn status back on");
    }

    function test_regraduationRestoresTheCreatorCut() public {
        _openBook();
        _dropUnder();
        assertFalse(hook.bridgeQuote(id).graduated);
        uint256 paused = hook.creatorFees(id);
        usdg.mint(address(this), 2_000e18);
        hook.deposit(id, 0, 2_000e18);
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

    function test_crossingBackFlipsInTheSameCall() public {
        _fresh(12_000e18);
        assertFalse(hook.bridgeQuote(id).graduated, "the seed is under 12% of a $12k reference");
        usdg.mint(address(this), 2_000e18);
        hook.deposit(id, 0, 2_000e18);
        assertTrue(hook.bridgeQuote(id).graduated, "crossing up flips in this call");
        hook.redeem(id, hook.sharesOf(id, address(this)));
        assertFalse(hook.bridgeQuote(id).graduated, "crossing back down flips in this call");
        hook.poke(id);
        assertFalse(hook.bridgeQuote(id).graduated);
    }

    function test_v2ReservesFeedTheRing() public {
        MockERC20 c = _newCoin("V2", 18);
        MockV2Pair pair = new MockV2Pair(address(c), address(usdg));
        pair.setReserves(1_000_000e18, 1_000_000e18);
        usdg.mint(address(pair), 50_000e18);
        v2Factory.setPair(address(c), address(usdg), address(pair));
        hook.witnessSource(hook.sourceKey(C.ANCHOR_V2, address(pair), bytes32(0)));
        skip(C.MIN_REF_AGE);
        c.mint(address(this), 10e18);
        c.approve(address(hook), type(uint256).max);
        (, PoolId pid) = hook.createPool(_v2(address(c), address(pair), 10e18));
        assertEq(hook.anchorKind(pid), C.ANCHOR_V2);
        assertEq(hook.curve(pid).anchor, 0, "a cold ring is not a 30-minute TWAP");
        _warmV2(pid);
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
        PoolKey memory ref = _openV4Ref(c, address(0), 3000);
        c.mint(address(this), 10e18);
        c.approve(address(hook), type(uint256).max);
        (, PoolId pid) = hook.createPool(_v4(address(c), 10e18, PoolId.unwrap(ref.toId()), address(0)));
        assertEq(hook.curve(pid).anchor, 0, "one sample is not a 30-minute TWAP");
        _warmSample(pid);
        assertEq(hook.curve(pid).anchor, 1e18);
        assertEq(hook.spotPrice(pid), 0.67e18);
        (uint256 price, uint256 tvl) = hook.liveAnchor(pid);
        assertEq(price, 1e18);
        assertGt(tvl, C.MIN_REF_TVL);
        assertFalse(hook.bridgeQuote(pid).stale);
    }

    /// @dev A push, poke, and push-back in one transaction must not weight the TWAP. The ring
    ///      accrues the tick that was already observed in a previous block, and only keeps a new
    ///      tick when the next block still shows it.
    function test_v4SelfSampleIgnoresAnInTxPush() public {
        MockERC20 c = _newCoin("PUSH", 18);
        PoolKey memory ref = _openV4Ref(c, address(0), 3000);
        c.approve(address(swapper), type(uint256).max);
        usdg.approve(address(swapper), type(uint256).max);

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

    /// @dev v4 create already stored a pending tick. Three later samples make the ring ready.
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

    /// @dev v2 create stores a cumulative and does not record a tick. Four later timestamps are required.
    function _warmV2(PoolId pid) internal {
        this.nextBlock();
        skip(1);
        hook.poke(pid);
        this.nextBlock();
        skip(1);
        hook.poke(pid);
        this.nextBlock();
        skip(1);
        hook.poke(pid);
        this.nextBlock();
        skip(30 minutes);
        hook.poke(pid);
    }

    /// @dev In-range liquidity worth at least $12k, witnessed, then aged 7 days.
    function _openV4Ref(MockERC20 c, address refHooks, uint24 fee) internal returns (PoolKey memory ref) {
        bool coin0 = address(c) < address(usdg);
        ref = PoolKey({
            currency0: Currency.wrap(coin0 ? address(c) : address(usdg)),
            currency1: Currency.wrap(coin0 ? address(usdg) : address(c)),
            fee: fee,
            tickSpacing: 60,
            hooks: IHooks(refHooks)
        });
        manager.initialize(ref, TickMath.getSqrtPriceAtTick(0));
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(manager);
        c.mint(address(this), 1e24);
        usdg.mint(address(this), 1e24);
        c.approve(address(lp), type(uint256).max);
        usdg.approve(address(lp), type(uint256).max);
        lp.modifyLiquidity(
            ref,
            IPoolManager.ModifyLiquidityParams({tickLower: -60, tickUpper: 60, liquidityDelta: 20_000e18, salt: 0}),
            ""
        );
        hook.witnessSource(hook.sourceKey(C.ANCHOR_V4, address(0), PoolId.unwrap(ref.toId())));
        skip(C.MIN_REF_AGE);
    }

    function _target() internal view returns (uint256) {
        return (hook.smoothedReference(id) * C.GRAD_NUM) / C.GRAD_DEN;
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
        // The first poke is the smooth reading. Set it here; a later same-block `_price` cannot.
        createRefTvl = refTvl;
        (key, id) = _create(coin, 77e18, 0, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        createRefTvl = 20_000e18;
        _price(id, 1e18, refTvl);
    }

    /// @dev Six hours is twelve half-lives, so the reference smooth sits on the latest reading and
    ///      the on-window starts if spot pool TVL is over the target. It does not graduate in this call.
    function _catchUp() internal {
        skip(6 hours);
        hook.poke(id);
    }

    function _openBook() internal {
        // $12k reference, target $1,440. The $77 seed is under it. A $2k deposit crosses and flips.
        _fresh(12_000e18);
        assertFalse(hook.bridgeQuote(id).graduated);
        usdg.mint(address(this), 2_000e18);
        hook.deposit(id, 0, 2_000e18);
        assertTrue(hook.bridgeQuote(id).graduated);
    }

    function _dropUnder() internal {
        uint256 sh = hook.sharesOf(id, address(this));
        if (sh > 0) hook.redeem(id, sh);
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
