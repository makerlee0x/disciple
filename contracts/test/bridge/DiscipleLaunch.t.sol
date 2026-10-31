// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {BridgeStorage} from "../../src/bridge/BridgeStorage.sol";
import {BridgeCurve} from "../../src/bridge/libraries/BridgeCurve.sol";
import {BridgeFee} from "../../src/bridge/libraries/BridgeFee.sol";
import {BridgeConstants as C} from "../../src/bridge/libraries/BridgeConstants.sol";
import {IV4OracleHook} from "../../src/bridge/interfaces/IV4OracleHook.sol";
import {V4SlotReader} from "../../src/bridge/V4SlotReader.sol";
import {BridgeFixture} from "./BridgeFixture.sol";
import {MockERC20, MockV4Oracle} from "./mocks/BridgeMocks.sol";

/// @notice Dutch quotes, the progress-only fee, the 77-minute graduation window, and v4 anchors.
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

        // Ask is 0.90, still above the 0.67 curve, so a buy walks the curve. The clock still resets.
        usdg.mint(address(this), 2e18);
        uint256 spotBefore = hook.spotPrice(id);
        _buy(key, address(coin), 1e18);
        assertGt(hook.spotPrice(id), spotBefore);
        (uint256 afterBuy,,,,,) = hook.dutchQuote(id);
        assertEq(afterBuy, 0, "a buy closes the bid and the ask");

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
        (uint256 closed,,,,,) = hook.dutchQuote(id);
        assertEq(closed, 0, "the sell-side quote resets on a buy too");
        // The slice is retargeted back onto the curve, so one Dutch fill does not walk the spot to the ask.
        assertApproxEqRel(hook.spotPrice(id), spot, 0.02e18);
        assertGe(hook.curve(id).x, hook.curve(id).seedFloor, "the seed guard still binds");
    }

    function test_graduationLatchesAndReferenceGrowthReopensIncentives() public {
        _fresh(10_000e18);
        _climb();
        usdg.mint(address(this), 3_000e18);
        hook.deposit(id, 0, 2_500e18);
        // The first observation starts the window. It does not graduate.
        hook.poke(id);
        assertFalse(hook.bridgeQuote(id).graduated);
        uint256 lowFee = hook.bridgeQuote(id).suggestedFeeBps;
        assertLt(lowFee, 80, "over the line, the fee is already the low end");

        skip(76 minutes);
        hook.poke(id);
        assertFalse(hook.bridgeQuote(id).graduated, "76 minutes does not flip status");
        skip(1 minutes);
        hook.poke(id);
        assertTrue(hook.bridgeQuote(id).graduated);
        assertGt(hook.curve(id).y, 0);
        uint256 shares = _vaultShares();
        assertGt(shares, 0, "graduation puts idle USDG in the vault");

        // Same one-hour gap, measured at the target and again after the reference has grown.
        _buy(key, address(coin), 1e18);
        skip(1 hours);
        (,,, uint256 tight,,) = hook.dutchQuote(id);
        uint256 tightFee = hook.bridgeQuote(id).suggestedFeeBps;

        // Six hours is twelve half-lives, so the smooth sits on the new $2M reading.
        skip(6 hours);
        _price(id, hook.curve(id).anchor, 2_000_000e18);
        assertTrue(hook.bridgeQuote(id).graduated, "a larger reference does not turn status off");
        uint256 highFee = hook.bridgeQuote(id).suggestedFeeBps;
        assertGt(highFee, 150, "falling back through the target raises the fee immediately");
        assertGt(highFee, lowFee);
        assertGt(highFee, tightFee);

        _buy(key, address(coin), 1e18);
        skip(1 hours);
        (,,, uint256 reopened,,) = hook.dutchQuote(id);
        assertGt(reopened, tight, "lower progress reopens the Dutch slice");

        vault.setRedeemLive(false);
        skip(77 minutes);
        hook.poke(id);
        assertTrue(hook.bridgeQuote(id).graduated, "status stays on with no vault redeem");
        // Later pokes keep depositing idle USDG. The position may grow. It is not redeemed.
        assertGe(_vaultShares(), shares, "the vault position is not redeemed");
        assertGe(hook.bridgeQuote(id).suggestedFeeBps, highFee);
    }

    function test_crossingBackResetsTheGraduationTimer() public {
        _fresh(10_000e18);
        _climb();
        usdg.mint(address(this), 3_000e18);
        hook.deposit(id, 0, 2_500e18);
        hook.poke(id);
        skip(30 minutes);
        hook.poke(id);
        assertFalse(hook.bridgeQuote(id).graduated);

        // Wall-clock from the first over-observation passes 77 minutes while the pool is under.
        skip(6 hours);
        _price(id, 1e18, 2_000_000e18);
        assertFalse(hook.bridgeQuote(id).graduated);
        skip(6 hours);
        _price(id, 1e18, 10_000e18);
        assertFalse(hook.bridgeQuote(id).graduated, "re-crossing starts a new window");
        skip(76 minutes);
        hook.poke(id);
        assertFalse(hook.bridgeQuote(id).graduated);
        skip(1 minutes);
        hook.poke(id);
        assertTrue(hook.bridgeQuote(id).graduated);
    }

    function test_v4OracleHookIsSameChain() public {
        MockERC20 c = _newCoin("AI", 18);
        MockV4Oracle oracle = new MockV4Oracle();
        oracle.set(2e18, 500_000e18);
        c.mint(address(this), 10e18);
        c.approve(address(hook), type(uint256).max);
        bytes32 refId = bytes32(uint256(42));
        (, PoolId pid) = hook.createPool(_anchor(address(c), 10e18, C.ANCHOR_V4_ORACLE, address(oracle), refId, false));
        assertEq(hook.curve(pid).anchor, 2e18);
        assertEq(hook.spotPrice(pid), 1.34e18);
        assertFalse(hook.bridgeQuote(pid).stale);
        assertFalse(hook.bridgeQuote(pid).graduated);
        vm.expectRevert(BridgeStorage.SameChain.selector);
        hook.updatePrice(pid);
        skip(3 hours);
        assertFalse(hook.bridgeQuote(pid).stale);
        uint256 grad = (500_000e18 * C.GRAD_NUM) / C.GRAD_DEN;
        assertEq(hook.bridgeQuote(pid).suggestedFeeBps, BridgeFee.baseFeeBps(BridgeCurve.tvl(hook.curve(pid)), grad));
        (uint256 price, uint256 tvl) = hook.liveAnchor(pid);
        assertEq(price, 2e18);
        assertEq(tvl, 500_000e18);
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
        (, PoolId pid) = hook.createPool(
            _anchor(address(c), 10e18, C.ANCHOR_V4_SAMPLE, address(0), PoolId.unwrap(ref.toId()), coin0)
        );
        assertEq(hook.curve(pid).anchor, 0, "one sample is not a 30-minute TWAP");
        vm.expectRevert(BridgeStorage.SameChain.selector);
        hook.updatePrice(pid);

        skip(30 minutes);
        hook.poke(pid);
        assertEq(hook.curve(pid).anchor, 1e18);
        assertEq(hook.spotPrice(pid), 0.67e18);
        (uint256 price, uint256 tvl) = hook.liveAnchor(pid);
        assertEq(price, 1e18);
        assertGt(tvl, 0);
        assertFalse(hook.bridgeQuote(pid).stale);
    }

    function test_lzReadOfV4OracleAndSlot() public {
        MockERC20 c = _newCoin("REMOTE", 18);
        c.mint(address(this), 20e18);
        c.approve(address(hook), type(uint256).max);
        bytes32 refId = bytes32(uint256(7));
        (, PoolId oracleId) =
            hook.createPool(_anchor(address(c), 10e18, C.ANCHOR_LZ_V4_ORACLE, address(0xBEEF), refId, true));
        vm.deal(address(this), 1 ether);
        hook.updatePrice{value: lz.fee()}(oracleId);
        assertEq(lz.lastTarget(), address(0xBEEF));
        assertEq(
            lz.lastCallData(), abi.encodeWithSelector(IV4OracleHook.consult.selector, refId, uint32(C.TWAP_WINDOW))
        );
        lz.fulfill(lz.lastGuid(), 1e18, 100_000e18);
        assertEq(hook.spotPrice(oracleId), 0.67e18);

        MockERC20 s = _newCoin("SLOT", 18);
        s.mint(address(this), 10e18);
        s.approve(address(hook), type(uint256).max);
        bool coin0 = address(s) < address(usdg);
        (, PoolId slotId) =
            hook.createPool(_anchor(address(s), 10e18, C.ANCHOR_LZ_V4_SLOT, address(0x51), refId, coin0));
        hook.updatePrice{value: lz.fee()}(slotId);
        assertEq(lz.lastCallData(), abi.encodeWithSelector(V4SlotReader.read.selector, refId));
        uint160 sqrtP = TickMath.getSqrtPriceAtTick(0);
        lz.fulfillBytes(lz.lastGuid(), abi.encode(sqrtP, int24(0), uint128(1e18)));
        assertEq(hook.curve(slotId).anchor, 0, "the first remote slot does not invent a TWAP");

        skip(30 minutes);
        hook.updatePrice{value: lz.fee()}(slotId);
        lz.fulfillBytes(lz.lastGuid(), abi.encode(sqrtP, int24(0), uint128(1e18)));
        assertEq(hook.curve(slotId).anchor, 1e18);
        assertEq(hook.spotPrice(slotId), 0.67e18);
        (uint256 slotPrice,) = hook.liveAnchor(slotId);
        assertEq(slotPrice, 1e18);
    }

    function _anchor(address c, uint256 seed, uint8 kind, address refHook, bytes32 refPool, bool coin0)
        internal
        view
        returns (BridgeStorage.CreateParams memory p)
    {
        bool lz = kind == C.ANCHOR_LZ || kind == C.ANCHOR_LZ_V4_ORACLE || kind == C.ANCHOR_LZ_V4_SLOT;
        p.coin = c;
        p.creator = address(this);
        p.floorBps = C.FLOOR_BPS;
        p.discountBps = C.DISCOUNT_BPS;
        p.remoteEid = lz ? 30101 : 0;
        p.remoteOracle = lz ? refHook : address(0);
        p.anchorKind = kind;
        p.coinSeed = seed;
        p.morphoCapBps = 10_000;
        p.refPoolId = refPool;
        p.refHook = kind == C.ANCHOR_V4_ORACLE ? refHook : address(0);
        p.refCoinIs0 = coin0;
    }

    function _target() internal view returns (uint256) {
        return (725_000e18 * C.GRAD_NUM) / C.GRAD_DEN;
    }

    function _vaultShares() internal view returns (uint256) {
        return hook.curve(id).y == 0 ? 0 : _shares();
    }

    function _shares() internal view returns (uint256 shares) {
        // vaultShares is not a view on the hook. Read it through the vault's balance of the hook
        // after graduation; before that it is zero. The hook holds the shares.
        shares = vault.balanceOf(address(hook));
    }

    function _fresh(uint256 refTvl) internal {
        coin = _newCoin("GRAD", 18);
        (key, id) = _create(coin, 77e18, 0, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        _price(id, 1e18, refTvl);
    }

    function _climb() internal {
        usdg.mint(address(this), 80e18);
        for (uint256 i; i < 40 && hook.spotPrice(id) < 1e18; ++i) {
            _buy(key, address(coin), 2e18);
        }
        assertGe(hook.spotPrice(id), 1e18);
    }
}
