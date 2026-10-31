// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {BridgeStorage} from "../../src/bridge/BridgeStorage.sol";
import {BridgeV4Anchor} from "../../src/bridge/libraries/BridgeV4Anchor.sol";
import {BridgeConstants as C} from "../../src/bridge/libraries/BridgeConstants.sol";
import {DiscipleHook} from "../../src/bridge/DiscipleHook.sol";
import {DiscipleEngine} from "../../src/bridge/DiscipleEngine.sol";
import {DiscipleAdminFacet} from "../../src/bridge/DiscipleAdminFacet.sol";
import {DiscipleLpFacet} from "../../src/bridge/DiscipleLpFacet.sol";
import {DiscipleCreateFacet} from "../../src/bridge/DiscipleCreateFacet.sol";
import {DiscipleSwapFacet} from "../../src/bridge/DiscipleSwapFacet.sol";
import {BridgeFixture} from "./BridgeFixture.sol";
import {MockERC20, MockV3Pool, MockV4Oracle} from "./mocks/BridgeMocks.sol";

/// @dev Storage for the self-sample ring. The hook uses the same library.
contract RingHarness {
    BridgeV4Anchor.Ring internal ring;
    mapping(uint16 => uint256) internal obs;

    function record(int24 tick) external {
        BridgeV4Anchor.record(ring, obs, tick);
    }

    function read() external view returns (bool ready, uint256 priceWad) {
        (ready, priceWad,) = BridgeV4Anchor.read(ring, obs, TickMath.getSqrtPriceAtTick(0), 1e18, true, 18, 18);
    }
}

/// @notice Internal review 1 C-1 / M-3 and internal review 2 C. The ring tracks a trend, ignores a
///         pushed first sample, and ignores an in-transaction push that is put back before the block ends.
contract RingAuditTest is BridgeFixture {
    function test_monotoneWalkMovesTheTwap() public {
        RingHarness h = new RingHarness();
        _prime(h);
        (bool ready, uint256 start) = h.read();
        assertTrue(ready);
        assertEq(start, 1e18);
        int24 tick;
        for (uint256 i; i < 8; ++i) {
            tick -= 200;
            this.nextBlock();
            skip(5 minutes);
            h.record(tick);
        }
        uint256 price;
        (ready, price) = h.read();
        assertTrue(ready);
        assertLt(price, 1e18, "a trend that never repeats a tick still moves the mean");
        assertGt(price, 0);
    }

    function testFuzz_monotoneWalk(uint8 steps, uint16 pace) public {
        steps = uint8(bound(steps, 4, 12));
        pace = uint16(bound(pace, 60, 600));
        RingHarness h = new RingHarness();
        _prime(h);
        int24 tick;
        for (uint256 i; i < steps; ++i) {
            tick -= 50;
            this.nextBlock();
            skip(pace);
            h.record(tick);
        }
        (bool ready, uint256 price) = h.read();
        assertTrue(ready);
        assertLt(price, 1e18);
    }

    function test_firstSamplePushIsNotTheAnchor() public {
        RingHarness h = new RingHarness();
        h.record(-6000);
        this.nextBlock();
        h.record(0);
        this.nextBlock();
        skip(1);
        h.record(0);
        skip(30 minutes);
        this.nextBlock();
        h.record(0);
        (bool ready, uint256 price) = h.read();
        assertTrue(ready);
        assertApproxEqRel(price, 1e18, 0.01e18, "the unconfirmed first tick is discarded");
    }

    function test_inTxPushDoesNotEnterTheMean() public {
        RingHarness h = new RingHarness();
        _prime(h);
        skip(1 minutes);
        h.record(-6000);
        h.record(0);
        (, uint256 mid) = h.read();
        assertEq(mid, 1e18, "the same-block spike is only a candidate");
        this.nextBlock();
        skip(30 minutes);
        h.record(0);
        (, uint256 price) = h.read();
        assertEq(price, 1e18, "the next block accrues the restored tick");
    }

    function _prime(RingHarness h) internal {
        h.record(0);
        this.nextBlock();
        h.record(0);
        this.nextBlock();
        skip(1);
        h.record(0);
        skip(30 minutes);
        this.nextBlock();
        h.record(0);
    }
}

/// @notice Floors, redeems, references, staleness, graduation, and the deploy-script guards.
contract DiscipleAuditFixesTest is BridgeFixture {
    using PoolIdLibrary for PoolKey;

    function setUp() public {
        _deployStack(18);
        coin = _newCoin("JESUS", 18);
        (key, id) = _create(coin, 77e18, 5e18, C.FLOOR_BPS, C.DISCOUNT_BPS, 10_000, C.OUTFLOW_PER_BLOCK);
        _price(id, 1e18, 725_000e18);
    }

    function test_multiSellHoldsTheFloor() public {
        usdg.mint(address(this), 40e18);
        _buy(key, address(coin), 8e18);
        (uint256 markBefore, uint256 principalBefore) = hook.floorState(id);
        assertGt(principalBefore, 0);
        assertGe(principalBefore, markBefore);
        coin.mint(address(this), 1_000e18);
        uint256 slice = _maxSell();
        assertGt(slice, 0);
        assertLt(slice, 1_000e18, "the floor caps the sell");
        this.execSell(slice);
        vm.roll(block.number + 1);
        vm.expectRevert();
        this.execRawSell(1e18);
        skip(1 hours);
        _freshen(id);
        try this.execSell(1e18) {} catch {}
        (uint256 mark, uint256 principal) = hook.floorState(id);
        assertGe(principal, (mark * C.FLOOR_BPS) / C.BPS, "a later block still respects the baseline");
        assertGt(principal, principalBefore / 10, "they do not drain to a few percent");
    }

    function test_multiSellInOneTransactionHoldsTheFloor() public {
        usdg.mint(address(this), 40e18);
        _buy(key, address(coin), 8e18);
        coin.mint(address(this), 1_000e18);
        uint256 slice = _maxSell();
        this.execSell(slice);
        vm.expectRevert();
        this.execSell(1e18);
        (uint256 mark, uint256 principal) = hook.floorState(id);
        assertGe(principal, (mark * C.FLOOR_BPS) / C.BPS);
    }

    function test_sellThenSameBlockRedeemHoldsTheFloor() public {
        usdg.mint(address(this), 40e18);
        _buy(key, address(coin), 8e18);
        uint256 sh = hook.deposit(id, 0, 6e18);
        coin.mint(address(this), 1_000e18);
        uint256 slice = _maxSell();
        this.execSell(slice);
        vm.expectRevert(BridgeStorage.ExceedsCap.selector);
        hook.redeem(id, sh);
        (uint256 mark, uint256 principal) = hook.floorState(id);
        assertGe(principal, (mark * C.FLOOR_BPS) / C.BPS);
    }

    function test_redeemSurvivesARevertingOracle() public {
        (PoolId pid,) = _oraclePool();
        usdg.mint(address(this), 20e18);
        uint256 sh = hook.deposit(pid, 0, 4e18);
        _lastOracle.setBroken(true);
        (uint256 cOut, uint256 uOut) = hook.redeem(pid, sh / 2);
        assertGt(cOut + uOut, 0);
    }

    MockV4Oracle internal _lastOracle;

    function test_redeemSurvivesAZeroOracle() public {
        (PoolId pid,) = _oraclePool();
        usdg.mint(address(this), 20e18);
        uint256 sh = hook.deposit(pid, 0, 4e18);
        _lastOracle.set(0, 0);
        (uint256 cOut, uint256 uOut) = hook.redeem(pid, sh / 2);
        assertGt(cOut + uOut, 0);
    }

    function test_lowCardinalityV3CannotBeAReference() public {
        MockERC20 c = _newCoin("YOUNG", 18);
        MockV3Pool young = new MockV3Pool(address(c), address(usdg), 0);
        skip(1);
        young.setTick(0);
        v3Factory.setPool(address(c), address(usdg), 3000, address(young));
        c.mint(address(this), 10e18);
        c.approve(address(hook), type(uint256).max);
        vm.expectRevert(MockV3Pool.OldObservation.selector);
        hook.createPool(_v3(c, young, 10e18));
    }

    function test_fakeV3PoolIsRejected() public {
        MockERC20 c = _newCoin("FAKE", 18);
        MockV3Pool pool = new MockV3Pool(address(c), address(usdg), 0);
        skip(30 minutes);
        pool.setTick(0);
        c.mint(address(this), 10e18);
        c.approve(address(hook), type(uint256).max);
        vm.expectRevert(BridgeStorage.BadCreate.selector);
        hook.createPool(_v3(c, pool, 10e18));
    }

    function test_hostileHookAndWrongPairAreRejected() public {
        MockERC20 c = _newCoin("REF", 18);
        bool coin0 = address(c) < address(usdg);
        PoolKey memory ref = _refPool(c, coin0);
        c.mint(address(this), 20e18);
        c.approve(address(hook), type(uint256).max);
        BridgeStorage.CreateParams memory badHook = _sample(c, PoolId.unwrap(ref.toId()), coin0);
        badHook.refHooks = address(0xBEEF);
        vm.expectRevert(BridgeStorage.BadCreate.selector);
        hook.createPool(badHook);

        MockERC20 other = _newCoin("OTHER", 18);
        bool other0 = address(other) < address(usdg);
        PoolKey memory wrong = _refPool(other, other0);
        other.mint(address(this), 10e18);
        other.approve(address(hook), type(uint256).max);
        vm.expectRevert(BridgeStorage.BadCreate.selector);
        hook.createPool(_sample(c, PoolId.unwrap(wrong.toId()), coin0));
    }

    function test_frontRunCreateDoesNotBlockTheCoin() public {
        MockERC20 c = _newCoin("SALT", 18);
        c.mint(address(this), 30e18);
        c.approve(address(hook), type(uint256).max);
        hook.createPool(_plain(c, 10e18, 0));
        hook.createPool(_plain(c, 10e18, 120));
    }

    function test_staleAnchorBlocksTheSwapAndNotTheRedeem() public {
        usdg.mint(address(this), 30e18);
        uint256 sh = hook.deposit(id, 0, 10e18);
        skip(31 minutes);
        assertTrue(hook.bridgeQuote(id).stale);
        vm.expectRevert();
        this.execRawSell(1e18);
        (uint256 cOut, uint256 uOut) = hook.redeem(id, sh / 2);
        assertGt(cOut + uOut, 0);
    }

    function test_depositWaitPokeWithdrawDoesNotGraduate() public {
        coin.mint(address(this), 1_000_000e18);
        uint256 sh = hook.deposit(id, 1_000_000e18, 0);
        hook.poke(id);
        skip(C.GRADUATION_WINDOW + 1 minutes);
        hook.poke(id);
        assertFalse(hook.bridgeQuote(id).graduated);
        hook.redeem(id, sh);
        assertFalse(hook.bridgeQuote(id).graduated);
    }

    function test_zeroTargetIsBelowOnceGraduated() public view {
        (bool on,, uint64 below,) = engine.stepGrad(100e18, 0, true, 0, 0, 1_000);
        assertTrue(on);
        assertEq(below, 1_000);
        (bool off,,,) = engine.stepGrad(100e18, 0, true, 0, 1_000, 1_000 + C.GRADUATION_WINDOW);
        assertFalse(off);
        (bool still,,,) = engine.stepGrad(100e18, 0, false, 0, 0, 1_000);
        assertFalse(still);
    }

    function test_oneReadingCannotJumpTheSmooth() public {
        skip(31 minutes);
        _price(id, 1e18, 1_000e18);
        uint256 smooth = hook.smoothedReference(id);
        assertGt(smooth, 1_000e18);
        assertLt(smooth, 725_000e18, "one step cannot snap onto a donated reading");
    }

    function test_dustFillDoesNotResetTheOtherClock() public {
        skip(2 hours);
        (uint64 drift, uint64 bidAt, uint64 askAt) = hook.dutchState(id);
        assertEq(drift, uint64(C.DUTCH_DRIFT_DEFAULT));
        usdg.mint(address(this), 1e18);
        _buy(key, address(coin), 0.5e18);
        (, uint64 bidAfter, uint64 askAfter) = hook.dutchState(id);
        assertEq(bidAfter, bidAt);
        assertEq(askAfter, askAt, "under the minimum notional, neither clock resets");
    }

    function test_onlyTheBuilderCanRescueStrayEth() public {
        vm.deal(address(hook), 1 ether);
        vm.prank(address(0xBAD));
        vm.expectRevert(BridgeStorage.OnlyBuilder.selector);
        hook.rescueEth(address(0xBAD));
        uint256 before = address(this).balance;
        hook.rescueEth(address(this));
        assertEq(address(this).balance, before + 1 ether);
        assertEq(address(hook).balance, 0);
    }

    function test_quoteMatchesTheSwap() public {
        usdg.mint(address(this), 20e18);
        bool zfo = Currency.unwrap(key.currency0) != address(coin);
        (uint256 quoted,, bool capped, uint256 used) = hook.quoteExactIn(key, zfo, 5e18);
        assertFalse(capped);
        assertEq(used, 5e18);
        uint256 before = coin.balanceOf(address(this));
        _buy(key, address(coin), 5e18);
        assertEq(coin.balanceOf(address(this)) - before, quoted);
    }

    function test_lzUnsetRejectsCrossChainKinds() public {
        DiscipleEngine eng = engine;
        DiscipleAdminFacet adminC =
            new DiscipleAdminFacet(manager, address(usdg), address(0), 18, eng, address(v3Factory));
        DiscipleLpFacet lpC = new DiscipleLpFacet(manager, address(usdg), address(0), 18, eng, address(v3Factory));
        DiscipleCreateFacet createC =
            new DiscipleCreateFacet(manager, address(usdg), address(0), 18, eng, address(v3Factory));
        DiscipleSwapFacet swapC = new DiscipleSwapFacet(manager, address(usdg), address(0), 18, eng, address(v3Factory));
        bytes memory args = abi.encode(
            manager,
            address(usdg),
            address(0),
            uint8(18),
            address(eng),
            address(swapC),
            address(lpC),
            address(createC),
            address(adminC),
            address(this),
            address(v3Factory)
        );
        (address predicted, bytes32 salt) = _mineHook(args);
        DiscipleHook bare = new DiscipleHook{salt: salt}(
            manager,
            address(usdg),
            address(0),
            18,
            eng,
            address(swapC),
            address(lpC),
            address(createC),
            address(adminC),
            address(this),
            address(v3Factory)
        );
        require(address(bare) == predicted, "hook addr");
        MockERC20 c = _newCoin("NOLZ", 18);
        c.mint(address(this), 10e18);
        c.approve(address(bare), type(uint256).max);
        vm.expectRevert(BridgeStorage.BadCreate.selector);
        bare.createPool(_plain(c, 10e18, 0));
    }

    function _maxSell() internal view returns (uint256 used) {
        bool zfo = Currency.unwrap(key.currency0) == address(coin);
        (,,, used) = hook.quoteExactIn(key, zfo, 1_000e18);
    }

    function execSell(uint256 amt) external {
        _sell(key, address(coin), amt);
    }

    function execRawSell(uint256 amt) external {
        bool zfo = Currency.unwrap(key.currency0) == address(coin);
        coin.mint(address(this), amt);
        coin.approve(address(swapper), type(uint256).max);
        swapper.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zfo,
                amountSpecified: -int256(amt),
                sqrtPriceLimitX96: zfo ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _oraclePool() internal returns (PoolId pid, PoolKey memory k) {
        MockERC20 c = _newCoin("ORACLE", 18);
        _lastOracle = new MockV4Oracle();
        _lastOracle.set(1e18, 100_000e18);
        hook.setOracleAllowed(address(_lastOracle), true);
        c.mint(address(this), 20e18);
        c.approve(address(hook), type(uint256).max);
        BridgeStorage.CreateParams memory p = _plain(c, 10e18, 0);
        p.anchorKind = C.ANCHOR_V4_ORACLE;
        p.remoteEid = 0;
        p.remoteOracle = address(0);
        p.v3Pool = address(0);
        p.tipSeed = 0;
        p.refHook = address(_lastOracle);
        p.refPoolId = bytes32(uint256(9));
        (k, pid) = hook.createPool(p);
    }

    function _refPool(MockERC20 c, bool coin0) internal returns (PoolKey memory ref) {
        ref = PoolKey({
            currency0: Currency.wrap(coin0 ? address(c) : address(usdg)),
            currency1: Currency.wrap(coin0 ? address(usdg) : address(c)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        manager.initialize(ref, TickMath.getSqrtPriceAtTick(0));
    }

    function _sample(MockERC20 c, bytes32 refId, bool coin0)
        internal
        view
        returns (BridgeStorage.CreateParams memory p)
    {
        p = _plain(c, 10e18, 0);
        p.anchorKind = C.ANCHOR_V4_SAMPLE;
        p.remoteEid = 0;
        p.remoteOracle = address(0);
        p.v3Pool = address(0);
        p.tipSeed = 0;
        p.refPoolId = refId;
        p.refCoinIs0 = coin0;
        p.refFee = 3000;
        p.refTickSpacing = 60;
    }

    function _v3(MockERC20 c, MockV3Pool pool, uint256 seed)
        internal
        view
        returns (BridgeStorage.CreateParams memory p)
    {
        p = _plain(c, seed, 0);
        p.anchorKind = C.ANCHOR_V3;
        p.remoteEid = 0;
        p.remoteOracle = address(0);
        p.v3Pool = address(pool);
        p.tipSeed = 0;
        p.v3Fee = 3000;
    }

    function _plain(MockERC20 c, uint256 seed, int24 spacing)
        internal
        view
        returns (BridgeStorage.CreateParams memory p)
    {
        p.coin = address(c);
        p.creator = address(this);
        p.floorBps = C.FLOOR_BPS;
        p.discountBps = C.DISCOUNT_BPS;
        p.outflowCapBps = 10_000;
        p.outflowWindow = C.OUTFLOW_PER_BLOCK;
        p.remoteEid = 30101;
        p.remoteOracle = address(0xE7E7);
        p.anchorKind = 0;
        p.v3Pool = address(0xB333);
        p.coinSeed = seed;
        p.tickSpacing = spacing;
    }
}
