// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {DiscipleHook} from "../../src/bridge/DiscipleHook.sol";
import {BridgeStorage} from "../../src/bridge/BridgeStorage.sol";
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
        v3.setTick(0);
        v3Factory.setPool(address(coin), address(usdg), 3000, address(v3));
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
        (bool priced,) = address(hook).call(abi.encodeWithSignature("updatePrice(bytes32)", PoolId.unwrap(id)));
        assertFalse(priced);
        (bool tipped,) =
            address(hook).call(abi.encodeWithSignature("fundTip(bytes32,uint256)", PoolId.unwrap(id), 1e18));
        assertFalse(tipped);
    }

    function test_spotSpikeDoesNotMoveTheTwap() public {
        v3.setTick(MOVED);
        (uint160 sqrtSpot, int24 spot,,,,,) = v3.slot0();
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
        uint256 bps = hook.bridgeQuote(id).suggestedFeeBps;
        vm.warp(block.timestamp + 3 hours);
        (, uint256 later,,) = hook.quoteExactIn(key, _buyZfo(), 10e18);
        assertLt(later, (fresh * 12) / 10, "same-chain time does not multiply the fee");
        assertEq(hook.bridgeQuote(id).suggestedFeeBps, bps);

        uint256 yBefore = hook.curve(id).y;
        usdg.mint(address(this), 10e18);
        _buy(key, address(coin), 10e18);
        assertEq(hook.creatorFees(id), 0);
        assertEq(hook.curve(id).lockedY, 0);
        assertEq(hook.curve(id).y - yBefore, 10e18, "the whole payment stays in the book");
        assertFalse(hook.bridgeQuote(id).stale);
    }

    function test_graduationUsesReferenceTvlAndSplitsTheFee() public {
        MockERC20 c = _newCoin("GRAD", 18);
        MockV3Pool small = new MockV3Pool(address(c), address(usdg), 0);
        usdg.mint(address(small), 100e18);
        c.mint(address(small), 100e18);
        vm.warp(block.timestamp + 30 minutes);
        small.setTick(0);
        v3Factory.setPool(address(c), address(usdg), 3000, address(small));
        (PoolKey memory k, PoolId pid) = _createV3(c, small, 77e18, 0);
        // Reference TVL = 200. Graduation is 12% = 24. The $77 seed is already over that,
        // but status waits out the pool's window and a poke.
        assertFalse(hook.bridgeQuote(pid).graduated);
        skip(C.GRADUATION_WINDOW);
        hook.poke(pid);
        assertTrue(hook.bridgeQuote(pid).graduated);

        uint256 yBefore = hook.curve(pid).y;
        usdg.mint(address(this), 10e18);
        _buy(k, address(c), 10e18);
        uint256 creator = hook.creatorFees(pid);
        assertGt(creator, 0);
        assertGt(hook.curve(pid).lockedY, 0);
        assertLt(creator, 0.4e18, "creator cut is a slice of the fee, not the notional");
        assertEq(hook.curve(pid).y - yBefore + creator, 10e18, "only the creator share leaves the book");
        assertEq(hook.curve(pid).lockedY, creator, "locked matches the creator third");
    }

    function test_inversePairAndYoungPool() public {
        // token0 = USDG, token1 = coin. A positive tick makes the coin cheaper in USDG.
        MockERC20 flippedCoin = _newCoin("FLIP", 18);
        MockV3Pool flipped = new MockV3Pool(address(usdg), address(flippedCoin), 0);
        // `skip` reads the clock inside another call. Repeating `vm.warp(block.timestamp + 30 minutes)`
        // in this function gets constant-folded to the first timestamp under via_ir.
        skip(30 minutes);
        flipped.setTick(0);
        v3Factory.setPool(address(flippedCoin), address(usdg), 3000, address(flipped));
        (, PoolId pid) = _createV3(flippedCoin, flipped, 10e18, 1_000_000e18);
        assertEq(hook.curve(pid).anchor, 1e18);

        flipped.setTick(MOVED);
        skip(30 minutes);
        (uint256 price,) = hook.liveAnchor(pid);
        assertGt(price, 0.45e18);
        assertLt(price, 0.55e18);

        MockERC20 youngCoin = _newCoin("YOUNG", 18);
        MockV3Pool young = new MockV3Pool(address(youngCoin), address(usdg), 0);
        young.dropToOne();
        v3Factory.setPool(address(youngCoin), address(usdg), 3000, address(young));
        youngCoin.mint(address(this), 10e18);
        youngCoin.approve(address(hook), type(uint256).max);
        vm.expectRevert(BridgeStorage.BadCreate.selector);
        hook.createPool(
            BridgeStorage.CreateParams({
                coin: address(youngCoin),
                creator: address(this),
                floorBps: C.FLOOR_BPS,
                discountBps: C.DISCOUNT_BPS,
                outflowCapBps: 0,
                outflowWindow: 0,
                anchorKind: C.ANCHOR_V3,
                refPool: address(young),
                coinSeed: 10e18,
                dutchDrift: 0,
                refPoolId: bytes32(0),
                tickSpacing: 0,
                refFee: 3000,
                refTickSpacing: 0,
                refHooks: address(0)
            })
        );

        MockERC20 other = _newCoin("NOPE", 18);
        MockERC20 fresh = _newCoin("FRESH", 18);
        MockV3Pool wrong = new MockV3Pool(address(other), address(usdg), 0);
        skip(30 minutes);
        wrong.setTick(0);
        v3Factory.setPool(address(fresh), address(usdg), 3000, address(wrong));
        fresh.mint(address(this), 10e18);
        fresh.approve(address(hook), type(uint256).max);
        vm.expectRevert(BridgeStorage.BadCreate.selector);
        hook.createPool(
            BridgeStorage.CreateParams({
                coin: address(fresh),
                creator: address(this),
                floorBps: C.FLOOR_BPS,
                discountBps: C.DISCOUNT_BPS,
                outflowCapBps: 0,
                outflowWindow: 0,
                anchorKind: C.ANCHOR_V3,
                refPool: address(wrong),
                coinSeed: 10e18,
                dutchDrift: 0,
                refPoolId: bytes32(0),
                tickSpacing: 0,
                refFee: 3000,
                refTickSpacing: 0,
                refHooks: address(0)
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
                anchorKind: C.ANCHOR_V3,
                refPool: address(pool),
                coinSeed: coinSeed,
                dutchDrift: 0,
                refPoolId: bytes32(0),
                tickSpacing: 0,
                refFee: 3000,
                refTickSpacing: 0,
                refHooks: address(0)
            })
        );
    }

    function _buyZfo() internal view returns (bool) {
        return Currency.unwrap(key.currency0) != address(coin);
    }
}
