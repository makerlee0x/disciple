// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IERC6909Claims} from "@uniswap/v4-core/src/interfaces/external/IERC6909Claims.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {DiscipleHook} from "../../src/bridge/DiscipleHook.sol";
import {BridgeStorage} from "../../src/bridge/BridgeStorage.sol";
import {BridgeCurve} from "../../src/bridge/libraries/BridgeCurve.sol";
import {BridgeConstants as C} from "../../src/bridge/libraries/BridgeConstants.sol";
import {BridgeFixture} from "./BridgeFixture.sol";
import {MockERC20} from "./mocks/BridgeMocks.sol";

/// @notice Arb quote and same-block LP settlement.
contract BridgeScopeTest is BridgeFixture {
    using CurrencyLibrary for Currency;

    function setUp() public {
        _deployStack(18);
        coin = _newCoin("JESUS", 18);
        (key, id) = _create(coin, 77e18, 5e18, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        _price(id, 1e18, 725_000e18);
    }

    function test_arbQuoteIsExecutableAndBeatsHalfSize() public {
        BridgeStorage.ArbQuote memory q = hook.arbQuote(id);
        assertTrue(q.buyCoin, "below the anchor the arb buys coin");
        assertGt(q.amountIn, 1e18);
        assertGt(q.amountOut, 0);
        assertGt(q.profitWad, 0);

        uint256 snap = vm.snapshotState();
        usdg.mint(address(this), q.amountIn);
        uint256 halfIn = q.amountIn / 2;
        uint256 usdgBefore = usdg.balanceOf(address(this));
        uint256 coinBefore = coin.balanceOf(address(this));
        _buy(key, address(coin), halfIn);
        uint256 halfProfit = (coin.balanceOf(address(this)) - coinBefore) - (usdgBefore - usdg.balanceOf(address(this)));

        vm.revertToState(snap);
        usdg.mint(address(this), q.amountIn);
        usdgBefore = usdg.balanceOf(address(this));
        coinBefore = coin.balanceOf(address(this));
        _buy(key, address(coin), q.amountIn);
        uint256 spent = usdgBefore - usdg.balanceOf(address(this));
        uint256 got = coin.balanceOf(address(this)) - coinBefore;
        assertEq(spent, q.amountIn);
        assertEq(got, q.amountOut);
        // Anchor is $1, both tokens are 18 decimals, so mark-to-anchor profit is coin out minus USDG in.
        assertApproxEqAbs(got - spent, q.profitWad, 2);
        assertGt(got - spent, halfProfit, "the quoted size beats half of it");
        assertGt(hook.spotPrice(id), 0.67e18);
        _solvent(id, address(coin));
    }

    function test_swapWithoutFlagPaysProceedsAndFlagKeepsShares() public {
        usdg.mint(address(this), 20e18);
        uint256 coinBefore = coin.balanceOf(address(this));
        uint256 sharesBefore = hook.sharesOf(id, address(this));

        _buy(key, address(coin), 5e18);
        assertGt(coin.balanceOf(address(this)), coinBefore, "empty hookData pays the coin out");
        assertEq(hook.sharesOf(id, address(this)), sharesBefore);

        uint256 coinMid = coin.balanceOf(address(this));
        bool zfo = Currency.unwrap(key.currency0) != address(coin);
        usdg.approve(address(swapper), type(uint256).max);
        swapper.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zfo,
                amountSpecified: -int256(uint256(5e18)),
                sqrtPriceLimitX96: zfo ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            abi.encode(false, address(this))
        );
        assertGt(coin.balanceOf(address(this)), coinMid, "explicit false pays the coin out");
        assertEq(hook.sharesOf(id, address(this)), sharesBefore);

        coinMid = coin.balanceOf(address(this));
        _buyLp(key, address(coin), 5e18);
        assertEq(coin.balanceOf(address(this)), coinMid, "the flag keeps the coin as shares");
        assertGt(hook.sharesOf(id, address(this)), sharesBefore);
        _solvent(id, address(coin));
    }

    function test_sameBlockDepositBuyRedeemEarnsNoBoost() public {
        usdg.mint(address(this), 40e18);
        uint256 start = usdg.balanceOf(address(this));
        uint256 sh = hook.deposit(id, 0, 20e18);
        _buy(key, address(coin), 8e18);
        assertEq(hook.pendingFee(id, address(this)), 0, "shares minted this block earn no fee");
        (uint256 cOut, uint256 uOut) = hook.redeem(id, sh);
        assertEq(cOut, 0, "escrow was USDG, not seed coin");
        assertLt(uOut, 20e18);
        uint256 held = coin.balanceOf(address(this));
        if (held > 0) {
            (,,, uint256 used) = hook.quoteExactIn(key, _sellZfo(), held);
            if (used > 0) _sell(key, address(coin), used);
        }
        uint256 leftover = coin.balanceOf(address(this));
        uint256 bid;
        if (leftover > 0) (bid,,,) = hook.quoteExactIn(key, _sellZfo(), leftover);
        assertLe(usdg.balanceOf(address(this)) + bid, start, "deposit, buy, redeem in one block loses money");
        _solvent(id, address(coin));
    }

    function test_depositSharesIgnoreSameBlockBuy() public {
        uint256 snap = vm.snapshotState();
        usdg.mint(address(this), 20e18);
        uint256 quiet = hook.deposit(id, 0, 20e18);

        vm.revertToState(snap);
        usdg.mint(address(this), 40e18);
        _buy(key, address(coin), 10e18);
        uint256 afterBuy = hook.deposit(id, 0, 20e18);
        assertEq(afterBuy, quiet, "a same-block buy does not change the share price");
    }

    function test_existingLpRedeemUsesOpeningReserves() public {
        address lp = address(0xB0B);
        usdg.mint(lp, 30e18);
        vm.startPrank(lp);
        usdg.approve(address(hook), type(uint256).max);
        uint256 sh = hook.deposit(id, 0, 20e18);
        vm.stopPrank();
        this.nextBlock();

        usdg.mint(address(this), 40e18);
        _buy(key, address(coin), 25e18);
        uint256 spot = hook.spotPrice(id);
        assertGt(spot, 0.67e18);

        vm.prank(lp);
        (uint256 cOut, uint256 uOut) = hook.redeem(id, sh);
        assertEq(cOut, 0, "opening book had no coin, so the buy's inventory is not redeemed");
        assertGt(uOut, 15e18, "they get their opening USDG back");
        assertLt(uOut, 20e18, "the redeem fee still comes out");
        // Virtual-reserve retarget rounds by at most a wei.
        assertApproxEqAbs(hook.spotPrice(id), spot, 1, "redeem retargets to the post-trade price");
        _solvent(id, address(coin));
    }

    function _sellZfo() internal view returns (bool) {
        return Currency.unwrap(key.currency0) == address(coin);
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
