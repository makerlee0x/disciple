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

    function test_graduationReversesAndIncentivesFollowProgress() public {
        _openBook();
        uint256 lowFee = hook.bridgeQuote(id).suggestedFeeBps;
        assertLt(lowFee, 80, "over the line, the fee is already the low end");
        _finishWindow(true);
        assertTrue(hook.bridgeQuote(id).graduated);
        assertGt(_shares(), 0, "graduation puts idle USDG in the vault");

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
        // The hour that opens the Dutch quote is part of the off-window. 60 minutes does not flip.
        skip(1 hours);
        (,,, uint256 reopened,,) = hook.dutchQuote(id);
        assertGt(reopened, tight, "lower progress reopens the Dutch slice");
        hook.poke(id);
        assertTrue(hook.bridgeQuote(id).graduated, "one hour under the target does not flip");

        skip(16 minutes);
        hook.poke(id);
        assertTrue(hook.bridgeQuote(id).graduated, "76 minutes under the target does not flip");
        skip(1 minutes);
        uint256 poker = usdg.balanceOf(address(this));
        hook.poke(id);
        assertFalse(hook.bridgeQuote(id).graduated, "77 minutes under the target turns status off");
        assertEq(_shares(), 0, "status off returns the vault position to idle");
        assertEq(usdg.balanceOf(address(this)), poker, "the unwind pays the pool, not the caller");
        uint256 paused = hook.creatorFees(id);
        _buy(key, address(coin), 1e18);
        assertEq(hook.creatorFees(id), paused, "the creator cut pauses while status is off");

        // A deposit that crosses the target in this block only starts the 77-minute clock.
        usdg.mint(address(this), 300_000e18);
        hook.deposit(id, 0, 250_000e18);
        hook.poke(id);
        assertFalse(hook.bridgeQuote(id).graduated, "the first reading back over the target does not flip");
        skip(76 minutes);
        hook.poke(id);
        assertFalse(hook.bridgeQuote(id).graduated, "76 minutes over the target does not re-graduate");
        skip(1 minutes);
        hook.poke(id);
        assertTrue(hook.bridgeQuote(id).graduated, "77 minutes over the target turns status back on");
        assertGt(_shares(), 0, "re-graduation deposits idle USDG again");
    }

    function test_timeBufferResetsWhenThePoolCrossesBack() public {
        _openBook();
        _finishWindow(true);
        uint256 v = BridgeCurve.tvl(hook.curve(id));
        // Any amount under the target is the other side. There is no percent cushion.
        skip(6 hours);
        _price(id, hook.curve(id).anchor, _refFor(v, 0.99e18));
        assertTrue(hook.bridgeQuote(id).graduated, "the first reading under the target starts the off-window");
        skip(76 minutes);
        hook.poke(id);
        assertTrue(hook.bridgeQuote(id).graduated, "76 minutes under the target does not flip");

        v = BridgeCurve.tvl(hook.curve(id));
        skip(6 hours);
        _price(id, hook.curve(id).anchor, _refFor(v, 1.01e18));
        skip(77 minutes);
        hook.poke(id);
        assertTrue(hook.bridgeQuote(id).graduated, "crossing back above the target clears the off-window");

        v = BridgeCurve.tvl(hook.curve(id));
        skip(6 hours);
        _price(id, hook.curve(id).anchor, _refFor(v, 0.99e18));
        skip(77 minutes);
        hook.poke(id);
        assertFalse(hook.bridgeQuote(id).graduated, "77 continuous minutes under the target turns status off");
    }

    function test_illiquidVaultUnwindsInPiecesAndADeadVaultRetries() public {
        _openBook();
        _finishWindow(true);
        uint256 shares = _shares();
        uint256 assets = vault.convertToAssets(shares);
        vault.setCash(assets / 2);
        _dropUnder();
        assertFalse(hook.bridgeQuote(id).graduated);
        uint256 left = _shares();
        assertGt(left, 0, "cash the vault will not release stays in shares");
        assertLt(left, shares);
        vault.setCash(type(uint256).max);
        hook.poke(id);
        assertEq(_shares(), 0, "the next poke takes the rest");
        assertFalse(hook.bridgeQuote(id).graduated);

        skip(6 hours);
        _price(id, hook.curve(id).anchor, 10_000e18);
        _finishWindow(true);
        assertTrue(hook.bridgeQuote(id).graduated);
        shares = _shares();
        assertGt(shares, 0);
        vault.setLive(false);
        _dropUnder();
        assertFalse(hook.bridgeQuote(id).graduated, "status turns off even when withdraw reverts");
        assertEq(_shares(), shares, "a reverting vault keeps the shares");
        vault.setLive(true);
        hook.poke(id);
        assertEq(_shares(), 0, "a later poke retries the unwind");
    }

    function test_unwindLossFreezesDepositsLikeTheLossPull() public {
        _openBook();
        _finishWindow(true);
        uint256 inVault = usdg.balanceOf(address(vault));
        vault.slash(inVault / 2);
        _dropUnder();
        assertFalse(hook.bridgeQuote(id).graduated);
        assertEq(_shares(), 0, "the remaining cash is withdrawn");

        // Back over the line. A frozen vault does not take the idle USDG again.
        skip(6 hours);
        _price(id, 1e18, 10_000e18);
        _finishWindow(true);
        assertTrue(hook.bridgeQuote(id).graduated);
        assertEq(_shares(), 0, "a loss on the unwind freezes new vault deposits");
        assertGt(hook.curve(id).y, 0, "the idle USDG is back in the book");
    }

    function test_regraduationRestoresTheCreatorCut() public {
        _openBook();
        _finishWindow(true);
        _dropUnder();
        assertFalse(hook.bridgeQuote(id).graduated);
        uint256 paused = hook.creatorFees(id);
        skip(6 hours);
        _price(id, 1e18, 10_000e18);
        _finishWindow(true);
        assertTrue(hook.bridgeQuote(id).graduated, "crossing back above the target re-graduates");
        assertGt(_shares(), 0, "re-graduation deposits idle USDG again");
        usdg.mint(address(this), 2e18);
        _buy(key, address(coin), 1e18);
        assertGt(hook.creatorFees(id), paused, "the creator cut resumes");
    }

    function test_crossingBackResetsTheGraduationTimer() public {
        _fresh(10_000e18);
        _climb();
        usdg.mint(address(this), 3_000e18);
        hook.deposit(id, 0, 2_500e18);
        _catchUp();
        assertFalse(hook.bridgeQuote(id).graduated, "the catch-up starts the window");
        skip(30 minutes);
        hook.poke(id);
        assertFalse(hook.bridgeQuote(id).graduated);

        // The next reading is already under the line, so the elapsed 77 minutes do not graduate.
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

    function _target() internal pure returns (uint256) {
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

    /// @dev Six hours is twelve half-lives, so the reference smooth sits on the latest reading and
    ///      the on-window starts if spot pool TVL is over the target. It does not graduate in this call.
    function _catchUp() internal {
        skip(6 hours);
        hook.poke(id);
    }

    function _openBook() internal {
        _fresh(10_000e18);
        _climb();
        usdg.mint(address(this), 3_000e18);
        hook.deposit(id, 0, 2_500e18);
        _catchUp();
        assertFalse(hook.bridgeQuote(id).graduated, "the first over-reading starts the window");
    }

    /// @dev The window is already running. `turningOn` is the side this wait should reach.
    function _finishWindow(bool turningOn) internal {
        skip(76 minutes);
        hook.poke(id);
        assertEq(hook.bridgeQuote(id).graduated, !turningOn, "76 minutes does not flip status");
        skip(1 minutes);
        hook.poke(id);
        assertEq(hook.bridgeQuote(id).graduated, turningOn);
    }

    function _dropUnder() internal {
        skip(6 hours);
        _price(id, hook.curve(id).anchor, 2_000_000e18);
        assertTrue(hook.bridgeQuote(id).graduated, "the off-window starts on the first under-reading");
        skip(77 minutes);
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
