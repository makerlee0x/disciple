// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IntegrationBase, MockUSDG} from "../integration/IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {CurrencySettler} from "../../src/libraries/CurrencySettler.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice PROTOTYPE (gas only, not production): seeds N single-sided USDG floor bands on the graduated pool via the
///         real v4 PoolManager + DiscipleHook liquidity-manager allowlist, in ONE unlock. Bands are tick offsets (in
///         tick-spacings) measured down from the spot tick (token = currency0) or up from it (token = currency1).
contract FloorSeedProto is IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using CurrencySettler for Currency;

    IPoolManager public immutable pm;
    int24 internal constant SPACING = 60;

    struct Args {
        PoolKey key;
        bool tokenIsC0;
        uint256 usd;
        uint16[] bps; // per band, sums to 10_000
        uint16[] lo; // band near-edge offset (spacings from spot)
        uint16[] hi; // band far-edge offset
    }

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function seed(Args calldata a) external returns (uint256 used) {
        used = abi.decode(pm.unlock(abi.encode(a)), (uint256));
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        Args memory a = abi.decode(raw, (Args));
        (, int24 cur,,) = pm.getSlot0(a.key.toId());
        int24 base = cur / SPACING * SPACING;
        if (cur < 0 && cur % SPACING != 0) base -= SPACING; // floor toward -inf
        if (!a.tokenIsC0) base += SPACING; // strictly above spot: all-currency0 (USDG)
        int256 owed;
        for (uint256 i = 0; i < a.bps.length; i++) {
            uint256 amt = a.usd * a.bps[i] / 10_000;
            int24 tl;
            int24 tu;
            if (a.tokenIsC0) {
                tu = base - int24(uint24(a.lo[i])) * SPACING;
                tl = base - int24(uint24(a.hi[i])) * SPACING;
            } else {
                tl = base + int24(uint24(a.lo[i])) * SPACING;
                tu = base + int24(uint24(a.hi[i])) * SPACING;
            }
            uint160 sa = TickMath.getSqrtPriceAtTick(tl);
            uint160 sb = TickMath.getSqrtPriceAtTick(tu);
            uint128 liq = a.tokenIsC0
                ? LiquidityAmounts.getLiquidityForAmount1(sa, sb, amt)
                : LiquidityAmounts.getLiquidityForAmount0(sa, sb, amt);
            (BalanceDelta d,) = pm.modifyLiquidity(
                a.key,
                IPoolManager.ModifyLiquidityParams({
                    tickLower: tl, tickUpper: tu, liquidityDelta: int256(uint256(liq)), salt: bytes32(i + 1)
                }),
                ""
            );
            // single-sided: the token side must be untouched
            require((a.tokenIsC0 ? d.amount0() : d.amount1()) == 0, "not single-sided");
            owed += a.tokenIsC0 ? d.amount1() : d.amount0();
        }
        uint256 u = uint256(-owed);
        (a.tokenIsC0 ? a.key.currency1 : a.key.currency0).settle(pm, address(this), u, false);
        return abi.encode(u);
    }
}

/// @notice Phase-1 gas check for the one-build floor. Run: `forge test --mc FloorSeedGas --isolate -vv`.
///         GRAD = the real graduating curve.buy (Migration + LockedLP full-range seed). FLOOR_N = prototype seeding N
///         bands in its own tx (conservative: cold pool slots; inside the grad tx they would be warm).
contract FloorSeedGas is IntegrationBase {
    uint256 internal constant LEFTOVER = 1201 ether; // ~$1,201 USDG (MockUSDG is 18-dec here)

    function _gradMeasured(BondingCurve curve) internal returns (uint256 gGrad, uint256 gPrev) {
        _warpPastSnipe();
        for (uint256 i = 0; i < 120 && !curve.graduated(); i++) {
            address w = makeAddr(string(abi.encodePacked("fgW", vm.toString(i), address(curve))));
            quote.mint(w, 50_000 ether);
            uint256[6] memory sizes = [uint256(400 ether), 200 ether, 100 ether, 50 ether, 10 ether, 1 ether];
            for (uint256 j = 0; j < sizes.length && !curve.graduated(); j++) {
                vm.prank(w);
                quote.approve(address(curve), sizes[j]);
                vm.prank(w);
                try curve.buy(sizes[j], 0, block.timestamp + 1) {
                    uint256 g = vm.lastCallGas().gasTotalUsed;
                    if (curve.graduated()) gGrad = g;
                    else gPrev = g;
                    break;
                } catch {}
            }
        }
        require(curve.graduated(), "not graduated");
    }

    function _bands(uint256 n)
        internal
        pure
        returns (uint16[] memory b, uint16[] memory lo, uint16[] memory hi)
    {
        // 30% flat over spot..0.75x (48 spacings), 70% geometric 4x bottom-heavy over spot..0.1x (384 spacings)
        if (n == 16) {
            b = _a16([uint16(750), 750, 750, 750, 266, 301, 342, 388, 440, 499, 566, 642, 728, 826, 937, 1065]);
            (lo, hi) = _edges(4, 48, 12);
        } else if (n == 12) {
            uint16[12] memory t = [uint16(1000), 1000, 1000, 353, 419, 499, 593, 705, 838, 997, 1186, 1410];
            b = new uint16[](12);
            for (uint256 i; i < 12; i++) b[i] = t[i];
            (lo, hi) = _edges(3, 48, 9);
        } else {
            uint16[8] memory t = [uint16(1500), 1500, 523, 690, 910, 1201, 1585, 2091];
            b = new uint16[](8);
            for (uint256 i; i < 8; i++) b[i] = t[i];
            (lo, hi) = _edges(2, 48, 6);
        }
    }

    function _a16(uint16[16] memory t) internal pure returns (uint16[] memory b) {
        b = new uint16[](16);
        for (uint256 i; i < 16; i++) b[i] = t[i];
    }

    function _edges(uint256 kTop, uint256 topSp, uint256 nBot) internal pure returns (uint16[] memory lo, uint16[] memory hi) {
        lo = new uint16[](kTop + nBot);
        hi = new uint16[](kTop + nBot);
        for (uint256 i; i < kTop; i++) {
            lo[i] = uint16(topSp * i / kTop);
            hi[i] = uint16(topSp * (i + 1) / kTop);
        }
        for (uint256 i; i < nBot; i++) {
            lo[kTop + i] = uint16(384 * i / nBot);
            hi[kTop + i] = uint16(384 * (i + 1) / nBot);
        }
    }

    function _run(uint256 n) internal {
        (BondingCurve curve, Token tok) = _launchWithQuote(address(quote), 100, 0);
        _runOn(n, curve, tok);
    }

    function _runOn(uint256 n, BondingCurve curve, Token tok) internal {
        (uint256 gGrad, uint256 gPrev) = _gradMeasured(curve);
        PoolKey memory key = _poolKey(tok);
        bool c0 = uint160(address(tok)) < uint160(address(quote));
        FloorSeedProto s = new FloorSeedProto(manager);
        hook.setLiquidityManager(address(s), true);
        quote.mint(address(s), LEFTOVER);
        vm.prank(address(s));
        IERC20(address(quote)).approve(address(manager), type(uint256).max);
        (uint16[] memory b, uint16[] memory lo, uint16[] memory hi) = _bands(n);
        uint256 used = s.seed(FloorSeedProto.Args(key, c0, LEFTOVER, b, lo, hi));
        uint256 gFloor = vm.lastCallGas().gasTotalUsed;
        console2.log("N", n, c0 ? "token=currency0" : "token=currency1");
        console2.log("  curve.buy (non-grad, last before grad)", gPrev);
        console2.log("  curve.buy GRADUATING (real Migration+LockedLP)", gGrad);
        console2.log("  floor seed N bands (prototype, own tx)", gFloor);
        console2.log("  per band", gFloor / n);
        console2.log("  est. grad tx incl floor (+21k intrinsic)", gGrad + gFloor + 21_000);
        console2.log("  USDG used / dust wei", used, LEFTOVER - used);
        assertLe(LEFTOVER - used, n * 1e6, "dust");
    }

    function test_floorSeed_N16() public {
        _run(16);
    }

    function test_floorSeed_N12() public {
        _run(12);
    }

    /// @dev Other token order (token = currency0 -> bands BELOW spot, USDG = currency1).
    function test_floorSeed_N16_tokenIsCurrency0() public {
        for (uint256 i = 0; i < 12; i++) {
            (BondingCurve curve, Token tok) = _launchWithQuote(address(quote), 100, 0);
            if (uint160(address(tok)) < uint160(address(quote))) return _runOn(16, curve, tok);
        }
        revert("no currency0 token in 12 launches");
    }

    function test_floorSeed_N8() public {
        _run(8);
    }
}
