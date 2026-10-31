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
import {IEthAnchor} from "../../src/bridge/interfaces/IEthAnchor.sol";
import {BridgeLaunchHook} from "../../src/bridge/BridgeLaunchHook.sol";
import {BridgeStorage} from "../../src/bridge/BridgeStorage.sol";
import {BridgeCurve} from "../../src/bridge/libraries/BridgeCurve.sol";
import {BridgeConstants as C} from "../../src/bridge/libraries/BridgeConstants.sol";
import {BridgeFixture} from "./BridgeFixture.sol";
import {MockERC20} from "./mocks/BridgeMocks.sol";

contract BridgeLaunchHookTest is BridgeFixture {
    using CurrencyLibrary for Currency;

    function setUp() public {
        _deployStack(18);
        coin = _newCoin("JESUS", 18);
        (key, id) = _create(coin, 77e18, 5e18, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        _price(id, 1e18, 725_000e18);
    }

    function test_runtimeFitsEip170() public view {
        assertLe(address(hook).code.length, 24_576);
        assertLe(address(engine).code.length, 24_576);
        assertLe(address(lpFacet).code.length, 24_576);
        assertLe(address(adminFacet).code.length, 24_576);
        assertLe(address(swapFacet).code.length, 24_576);
    }

    function test_startsAtDiscountWithNoUsdg() public view {
        assertEq(hook.spotPrice(id), 0.67e18);
        assertEq(hook.curve(id).y, 0);
        assertEq(hook.curve(id).x, 77e18);
        BridgeStorage.BridgeQuote memory q = hook.bridgeQuote(id);
        assertLt(q.priceGapBps, 0);
        assertGt(q.suggestedFeeBps, 0);
        assertFalse(q.stale);
        assertFalse(q.graduated);
        assertEq(bytes4(lz.lastCallData()), IEthAnchor.latest.selector);
        assertEq(lz.lastTarget(), address(0xE7E7));
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
        (PoolKey memory k,) = _create(c, 10e18, 0, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        usdg.mint(address(this), 1e18);
        usdg.approve(address(swapper), type(uint256).max);
        vm.expectRevert();
        this.execSwap(k, Currency.unwrap(k.currency0) != address(c), 1e18);
    }

    function test_keeperTipOnlyWhenStaleAndCallerDoesNotSetPrice() public {
        // setUp already consumed the first (missing) quote and paid $1 of the $5 tip seed.
        assertEq(usdg.balanceOf(address(this)), 1e18);

        uint256 lzFee = lz.fee();
        vm.expectRevert(BridgeStorage.Fresh.selector);
        hook.updatePrice{value: lzFee}(id);
        assertEq(usdg.balanceOf(address(this)), 1e18, "fresh update pays nothing");

        vm.warp(block.timestamp + 30 minutes + 1);
        uint256 before = usdg.balanceOf(address(this));
        hook.updatePrice{value: lz.fee()}(id);
        // The keeper still does not choose the number. The endpoint does.
        lz.fulfill(lz.lastGuid(), 1.1e18, 725_000e18);
        assertEq(usdg.balanceOf(address(this)), before + 1e18);
        // 10% anchor move, same discount ratio: 0.67 * 1.1
        assertApproxEqAbs(hook.spotPrice(id), 0.737e18, 2);
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

    function test_buyClimbsAndDirectionalFee() public {
        (, uint256 buyFee,,) = hook.quoteExactIn(key, _buyZfo(), 10e18);
        assertApproxEqAbs(buyFee, 0.1e18, 0.02e18); // ~1% toward the anchor (half of 2%)

        usdg.mint(address(this), 10e18);
        _buy(key, address(coin), 10e18);
        assertGt(hook.spotPrice(id), 0.67e18);
        assertLt(hook.spotPrice(id), 1e18);

        coin.mint(address(this), 5e18);
        (, uint256 sellFee,, uint256 used) = hook.quoteExactIn(key, _sellZfo(), 2e18);
        uint256 sellBps = (sellFee * 10_000) / used;
        uint256 buyBps = (buyFee * 10_000) / 10e18;
        assertGt(sellBps, buyBps, "selling away from the anchor pays more");
        _solvent(id, address(coin));
    }

    function test_staleFeedRaisesTheFee() public {
        (, uint256 freshFee,,) = hook.quoteExactIn(key, _buyZfo(), 10e18);
        vm.warp(block.timestamp + 30 minutes + 2 hours);
        (, uint256 staleFee,,) = hook.quoteExactIn(key, _buyZfo(), 10e18);
        assertGt(staleFee, freshFee * 4);
        assertLe(staleFee, 2e18); // 20% cap on a $10 trade
    }

    function test_floorCutsHugeSellAndOversizedSwapReverts() public {
        // Stay inside the launch virtuals so the book is still shallow and the floor, not the tail, binds.
        usdg.mint(address(this), 40e18);
        hook.deposit(id, 0, 30e18);
        coin.mint(address(this), 500e18);
        uint256 dump = 200e18;
        (uint256 out,, bool capped, uint256 used) = hook.quoteExactIn(key, _sellZfo(), dump);
        assertTrue(capped, "a large enough sell is cut by the floor or the tail");
        assertGt(used, 0);
        assertLt(used, dump);
        assertGt(out, 0);
        // The quoted size has to be swappable. A second quote of that size is not capped.
        (uint256 out2,, bool capped2, uint256 used2) = hook.quoteExactIn(key, _sellZfo(), used);
        assertFalse(capped2);
        assertEq(used2, used);
        assertEq(out2, out);
        vm.expectRevert();
        this.execSwap(key, _sellZfo(), dump);

        uint256 floorBefore = _floorAmt();
        _sell(key, address(coin), used);
        assertGe(hook.curve(id).protoY + hook.curve(id).lpY, floorBefore - 1);
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

        vm.expectRevert(BridgeCurve.DiscountDeposit.selector);
        hook.deposit(id, 0, 1_000e18);

        uint256 coinBefore = coin.balanceOf(address(this));
        uint256 usdgBefore = usdg.balanceOf(address(this));
        (uint256 cOut, uint256 uOut) = hook.redeem(id, sh);
        assertEq(cOut, 0, "redeem does not pay seed coin");
        assertLt(uOut, 20e18, "redeem fee comes out of principal, not a 3.3x boost");
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
        // 10% of the fee is the keeper slice. The rest is what the boost splits.
        uint256 compound = fee - (fee * C.TIP_SLICE_BPS) / C.BPS;
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
        assertLe(end, start, "round trip including the 3.3x fee weight loses money");
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

    function test_twoPoolsDoNotShareReserves() public {
        MockERC20 other = _newCoin("OTHER", 18);
        (PoolKey memory k2, PoolId id2) = _create(other, 40e18, 0, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        _price(id2, 2e18, 725_000e18);
        uint256 y2 = hook.curve(id2).y;
        uint256 x2 = hook.curve(id2).x;
        usdg.mint(address(this), 5e18);
        _buy(key, address(coin), 5e18);
        assertEq(hook.curve(id2).y, y2);
        assertEq(hook.curve(id2).x, x2);
        _solvent(id, address(coin));
        _solvent(id2, address(other));
        k2;
    }

    function test_creatorCutOnlyAfterGraduationAndWalletIsRotatable() public {
        address creator = address(0xCAFE);
        vm.prank(address(0xBAD));
        vm.expectRevert(BridgeStorage.OnlyCreator.selector);
        hook.setCreator(id, creator);

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

        hook.setCreator(id, creator);
        vm.prank(creator);
        hook.setCreator(id, address(this));
        _solvent(id, address(coin));
    }

    function test_graduationAndMorphoIncludingAVaultThatFails() public {
        _graduate();
        assertTrue(_graduated());
        uint256 inVault = usdg.balanceOf(address(vault));
        assertGt(inVault, 500e18, "idle USDG above the floor and buffer is deposited");

        BridgeCurve.S memory s = hook.curve(id);
        uint256 principal = s.protoY + s.lpY;
        uint256 inVaultNorm = usdg.balanceOf(address(vault));
        uint256 liquid = principal - inVaultNorm;
        assertGe(liquid, (principal * C.FLOOR_BPS) / C.BPS, "floor stays liquid");

        coin.mint(address(this), 5_000e18);
        (uint256 smallOut,, bool smallCap, uint256 smallUsed) = hook.quoteExactIn(key, _sellZfo(), 20e18);
        assertFalse(smallCap);
        assertLt(smallOut, liquid);

        uint256 bigIn = 2_500e18;
        (uint256 bigOut,, bool bigCap, uint256 bigUsed) = hook.quoteExactIn(key, _sellZfo(), bigIn);
        if (bigCap) bigIn = bigUsed;
        assertGt(bigOut, liquid, "this sell has to pull from the vault");

        uint256 snap = vm.snapshotState();
        uint256 vaultBefore = usdg.balanceOf(address(vault));
        _sell(key, address(coin), bigIn);
        assertLt(usdg.balanceOf(address(vault)), vaultBefore, "live vault paid the sell");

        vm.revertToState(snap);
        vault.setLive(false);
        vm.expectRevert();
        this.execSwap(key, _sellZfo(), bigIn);
        _sell(key, address(coin), smallUsed);
        _solvent(id, address(coin));
    }

    function test_vaultYieldGoesToProtocolNotLpBoost() public {
        _graduate();
        uint256 proto = hook.curve(id).protoY;
        uint256 lpY = hook.curve(id).lpY;
        usdg.mint(address(this), 100e18);
        usdg.transfer(address(vault), 100e18);
        hook.rebalance(id);
        assertGt(hook.curve(id).protoY, proto);
        assertEq(hook.curve(id).lpY, lpY);
        _solvent(id, address(coin));
    }

    function test_outflowCapPerBlockAndDefaultOff() public {
        MockERC20 c = _newCoin("CAP", 18);
        (PoolKey memory k, PoolId pid) =
            _create(c, 77e18, 1e18, C.FLOOR_BPS, C.DISCOUNT_BPS, 1_000, C.OUTFLOW_PER_BLOCK);
        _price(pid, 1e18, 725_000e18);
        usdg.mint(address(this), 40e18);
        // Fit inside the virtual gap so the deposit does not freeze the discount.
        hook.deposit(pid, 0, 30e18);
        c.mint(address(this), 100e18);
        bool zfo = Currency.unwrap(k.currency0) == address(c);
        (,,, uint256 used) = hook.quoteExactIn(k, zfo, 3e18);
        _swap(k, zfo, used, false);
        vm.expectRevert();
        this.execSwap(k, zfo, 20e18);
        vm.roll(block.number + 1);
        (,,, uint256 used2) = hook.quoteExactIn(k, zfo, 3e18);
        _swap(k, zfo, used2, false);

        // Default pool has no outflow window: two sells in one block both clear.
        _climb();
        usdg.mint(address(this), 80e18);
        hook.deposit(id, 0, 50e18);
        coin.mint(address(this), 20e18);
        _sell(key, address(coin), 2e18);
        _sell(key, address(coin), 2e18);
    }

    function test_onlyLzCanDeliverTheRead() public {
        vm.expectRevert(BridgeStorage.OnlyLz.selector);
        hook.onLzRead(bytes32(uint256(1)), abi.encode(uint256(1e18), uint256(1)));
        vm.prank(address(lz));
        vm.expectRevert(BridgeStorage.UnknownRead.selector);
        hook.onLzRead(bytes32(uint256(99)), abi.encode(uint256(1e18), uint256(1)));
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

    function _climb() internal {
        usdg.mint(address(this), 80e18);
        for (uint256 i; i < 40 && hook.spotPrice(id) < 1e18; ++i) {
            _buy(key, address(coin), 2e18);
        }
        assertGe(hook.spotPrice(id), 1e18);
    }

    function _graduate() internal {
        _climb();
        usdg.mint(address(this), 3_000e18);
        hook.deposit(id, 0, 2_500e18);
        vm.warp(block.timestamp + 31 minutes);
        _price(id, hook.curve(id).anchor, 10_000e18);
        hook.rebalance(id);
        assertTrue(_graduated());
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

contract BridgeLaunchHookDec6Test is BridgeFixture {
    function test_sixDecimalUsdg() public {
        _deployStack(6);
        coin = _newCoin("JESUS", 18);
        (key, id) = _create(coin, 77e18, 5e6, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        _price(id, 1e18, 725_000e18);
        assertEq(hook.spotPrice(id), 0.67e18);
        usdg.mint(address(this), 20e6);
        _buy(key, address(coin), 10e6);
        assertGt(coin.balanceOf(address(this)), 0);
        assertGt(hook.spotPrice(id), 0.67e18);
        assertTrue(hook.reserveOk(id));
    }
}
