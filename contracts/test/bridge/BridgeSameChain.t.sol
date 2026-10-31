// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BridgeLaunchHook} from "../../src/bridge/BridgeLaunchHook.sol";
import {BridgeStorage} from "../../src/bridge/BridgeStorage.sol";
import {BridgeV3Anchor} from "../../src/bridge/libraries/BridgeV3Anchor.sol";
import {BridgeConstants as C} from "../../src/bridge/libraries/BridgeConstants.sol";
import {BridgeFixture} from "./BridgeFixture.sol";
import {MockERC20, MockV3Pool} from "./mocks/BridgeMocks.sol";

/// @notice Same-chain anchor: v3 `observe` over 30 minutes, no keeper, no stale fee, no tip.
contract BridgeSameChainTest is BridgeFixture {
    MockV3Pool internal v3;
    int24 internal constant MOVED = 6932; // 1.0001^6932 ≈ 2

    function setUp() public {
        _deployStack(18);
        coin = _newCoin("JESUS", 18);
        // Coin is token0 when its address sorts below USDG. Tick 0 is price 1 either way.
        v3 = new MockV3Pool(address(coin), address(usdg), 0);
        vm.warp(block.timestamp + 30 minutes);
        (key, id) = _createV3(coin, v3, 77e18, 1_000_000e18);
    }

    function test_launchesAtDiscountWithoutAKeeper() public {
        (uint256 price, uint256 tvl) = hook.liveAnchor(id);
        assertEq(price, 1e18, "tick 0 is one quote token per coin");
        assertEq(hook.spotPrice(id), 0.67e18);
        assertEq(hook.curve(id).anchor, 1e18);
        assertGt(tvl, 0);
        assertFalse(hook.bridgeQuote(id).stale);
        assertFalse(hook.bridgeQuote(id).graduated);

        vm.expectRevert(BridgeStorage.SameChain.selector);
        hook.updatePrice(id);
        vm.expectRevert(BridgeStorage.SameChain.selector);
        hook.fundTip(id, 1e18);
    }

    function test_spotSpikeDoesNotMoveTheTwap() public {
        v3.setTick(MOVED);
        (uint160 sqrtSpot, int24 spot) = v3.slot0();
        assertEq(spot, MOVED);
        assertGt(sqrtSpot, 0);
        (uint256 price,) = hook.liveAnchor(id);
        assertEq(price, 1e18, "a same-block spot move has no duration");

        vm.warp(block.timestamp + 60);
        (uint256 nudged,) = hook.liveAnchor(id);
        assertGt(nudged, 1e18);
        assertLt(nudged, 1.05e18, "one minute of a 2x print is a small TWAP move");

        vm.warp(block.timestamp + 30 minutes);
        (uint256 moved,) = hook.liveAnchor(id);
        assertGt(moved, 1.9e18);
        assertLt(moved, 2.1e18, "a print held for the whole window becomes the anchor");
        // The book recenters on the next trade, keeping the discount ratio. 0.67 * ~2.
        usdg.mint(address(this), 1e18);
        _buy(key, address(coin), 1e18);
        assertGt(hook.spotPrice(id), 1.2e18);
        assertLt(hook.spotPrice(id), 1.5e18);
    }

    function test_donationMovesTvlNotPrice() public {
        (uint256 priceBefore, uint256 tvlBefore) = hook.liveAnchor(id);
        usdg.mint(address(v3), 500_000e18);
        (uint256 priceAfter, uint256 tvlAfter) = hook.liveAnchor(id);
        assertEq(priceAfter, priceBefore);
        assertGt(tvlAfter, tvlBefore + 400_000e18);
    }

    function test_noStaleFeeAndNoTipSkim() public {
        (, uint256 fresh,,) = hook.quoteExactIn(key, _buyZfo(), 10e18);
        vm.warp(block.timestamp + 3 hours);
        (, uint256 later,,) = hook.quoteExactIn(key, _buyZfo(), 10e18);
        assertEq(later, fresh, "same-chain quotes do not get more expensive with time");

        uint256 yBefore = hook.curve(id).y;
        usdg.mint(address(this), 10e18);
        _buy(key, address(coin), 10e18);
        assertEq(hook.creatorFees(id), 0);
        assertEq(hook.curve(id).y - yBefore, 10e18, "the whole payment stays in the book");
        assertFalse(hook.bridgeQuote(id).stale);
    }

    function test_graduationUsesReferenceTvlAndOnlyTheCreatorCut() public {
        MockERC20 c = _newCoin("GRAD", 18);
        MockV3Pool small = new MockV3Pool(address(c), address(usdg), 0);
        usdg.mint(address(small), 100e18);
        c.mint(address(small), 100e18);
        vm.warp(block.timestamp + 30 minutes);
        (PoolKey memory k, PoolId pid) = _createV3(c, small, 77e18, 0);
        // Reference TVL = 200. Graduation is 12% = 24. The $77 seed is already over that.
        assertTrue(hook.bridgeQuote(pid).graduated);

        uint256 yBefore = hook.curve(pid).y;
        usdg.mint(address(this), 10e18);
        _buy(k, address(c), 10e18);
        uint256 creator = hook.creatorFees(pid);
        assertGt(creator, 0);
        assertLt(creator, 0.3e18, "10% of a ~2% fee, not a protocol cut of the notional");
        assertEq(hook.curve(pid).y - yBefore + creator, 10e18, "creator is the only skim");
    }

    function test_inversePairAndYoungPool() public {
        // token0 = USDG, token1 = coin. A positive tick makes the coin cheaper in USDG.
        MockERC20 flippedCoin = _newCoin("FLIP", 18);
        MockV3Pool flipped = new MockV3Pool(address(usdg), address(flippedCoin), 0);
        // `skip` reads the clock inside another call. Repeating `vm.warp(block.timestamp + 30 minutes)`
        // in this function gets constant-folded to the first timestamp under via_ir.
        skip(30 minutes);
        (, PoolId pid) = _createV3(flippedCoin, flipped, 10e18, 1_000_000e18);
        assertEq(hook.curve(pid).anchor, 1e18);

        flipped.setTick(MOVED);
        skip(30 minutes);
        (uint256 price,) = hook.liveAnchor(pid);
        assertGt(price, 0.45e18);
        assertLt(price, 0.55e18);

        MockERC20 youngCoin = _newCoin("YOUNG", 18);
        MockV3Pool young = new MockV3Pool(address(youngCoin), address(usdg), 0);
        youngCoin.mint(address(this), 10e18);
        youngCoin.approve(address(hook), type(uint256).max);
        vm.expectRevert(MockV3Pool.OldObservation.selector);
        hook.createPool(
            BridgeStorage.CreateParams({
                coin: address(youngCoin),
                creator: address(this),
                floorBps: C.FLOOR_BPS,
                discountBps: C.DISCOUNT_BPS,
                outflowCapBps: 0,
                outflowWindow: 0,
                remoteEid: 0,
                remoteOracle: address(0),
                anchorKind: C.ANCHOR_V3,
                v3Pool: address(young),
                coinSeed: 10e18,
                tipSeed: 0,
                morphoCapBps: 10_000,
                vaultAdmin: address(0)
            })
        );

        MockERC20 other = _newCoin("NOPE", 18);
        MockERC20 fresh = _newCoin("FRESH", 18);
        MockV3Pool wrong = new MockV3Pool(address(other), address(usdg), 0);
        skip(30 minutes);
        fresh.mint(address(this), 10e18);
        fresh.approve(address(hook), type(uint256).max);
        vm.expectRevert(BridgeV3Anchor.BadPair.selector);
        hook.createPool(
            BridgeStorage.CreateParams({
                coin: address(fresh),
                creator: address(this),
                floorBps: C.FLOOR_BPS,
                discountBps: C.DISCOUNT_BPS,
                outflowCapBps: 0,
                outflowWindow: 0,
                remoteEid: 0,
                remoteOracle: address(0),
                anchorKind: C.ANCHOR_V3,
                v3Pool: address(wrong),
                coinSeed: 10e18,
                tipSeed: 0,
                morphoCapBps: 10_000,
                vaultAdmin: address(0)
            })
        );
    }

    function _createV3(MockERC20 c, MockV3Pool pool, uint256 coinSeed, uint256 referenceUsdg)
        internal
        returns (PoolKey memory k, PoolId poolId)
    {
        if (referenceUsdg > 0) usdg.mint(address(pool), referenceUsdg);
        c.mint(address(this), coinSeed);
        c.approve(address(hook), type(uint256).max);
        (k, poolId) = hook.createPool(
            BridgeStorage.CreateParams({
                coin: address(c),
                creator: address(this),
                floorBps: C.FLOOR_BPS,
                discountBps: C.DISCOUNT_BPS,
                outflowCapBps: 0,
                outflowWindow: 0,
                remoteEid: 0,
                remoteOracle: address(0),
                anchorKind: C.ANCHOR_V3,
                v3Pool: address(pool),
                coinSeed: coinSeed,
                tipSeed: 0,
                morphoCapBps: 10_000,
                vaultAdmin: address(0)
            })
        );
    }

    function _buyZfo() internal view returns (bool) {
        return Currency.unwrap(key.currency0) != address(coin);
    }
}
