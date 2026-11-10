// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {DiscipleHook} from "../../src/hook/DiscipleHook.sol";

/// @notice Carry research, read-only: would a best-price router send MSTR/USDG trades to a Disciple pool that
///         follows the main Uniswap v4 MSTR/USDG 0.25% pool? Forks live Robinhood Chain (4663).
///
///         Builds Disciple MSTR/USDG pools at a few fees and pool sizes, then quotes each trade size for real (an
///         exact-input swap, rolled back) on the Disciple pool and on both hookless Uniswap v4 MSTR/USDG pools. Rows
///         also show the Disciple pool after it has been pushed off balance by one-sided flow, which is when its
///         curve makes it the best buy or best sell. Prints a table and asserts nothing about the market.
///
///         Skips unless FORK_RPC_RH is set:
///         `FORK_RPC_RH=https://rpc.mainnet.chain.robinhood.com forge test --match-path test/hook/CarryFollowerRouteFork.t.sol -vv`
contract CarryFollowerRouteForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant Q128 = 1 << 128;
    IPoolManager internal constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant MSTR = 0xec262a75e413fAfD0dF80480274532C79D42da09;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    bytes32 internal constant REF_ETH_USDG = 0xa791e5169faf703c0b63fd9552c33ec1128a773a00f5dc33a640da62a022cd35;
    /// @dev Uniswap v4 MSTR/USDG 0.25% (the leader) and 0.24%, both hookless.
    bytes32 internal constant UNI25 = 0x319bac87e616a89e241c10aeb8afd4892a852cdd8b373cd9765ecddc40b87cfe;

    uint24[6] FEES = [uint24(1_000), 1_500, 2_000, 2_500, 3_000, 4_000];
    uint256[3] TVL = [uint256(5_000), 50_000, 500_000];
    uint256[5] SIZES = [uint256(50), 250, 1_000, 5_000, 25_000];
    /// Off-balance states: share of the pool's starting MSTR that one-sided flow has bought (+) or sold into it (-).
    int256[3] SKEW = [int256(0), 20, -20];

    DiscipleHook h;
    PoolSwapTest sw;
    PoolKey[2] uni;
    uint8 mstrDec;

    function _uniKey(uint24 fee, int24 spacing) internal pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(USDG), Currency.wrap(MSTR), fee, spacing, IHooks(address(0)));
    }

    function test_fork_carryFollowerRoute() public {
        string memory rpc = vm.envOr("FORK_RPC_RH", string(""));
        if (bytes(rpc).length == 0) {
            console2.log("skipped, FORK_RPC_RH unset");
            return;
        }
        vm.createSelectFork(rpc);
        require(block.chainid == 4663, "not Robinhood Chain");
        uni[0] = _uniKey(2500, 25);
        uni[1] = _uniKey(2400, 24);
        require(PoolId.unwrap(uni[0].toId()) == UNI25, "leader key");
        mstrDec = IERC20Metadata(MSTR).decimals();

        bytes memory args = abi.encode(
            PM, address(0), address(0), address(0), WETH, DiscipleHook.Config(10_000, USDG, 3, address(PM), REF_ETH_USDG, true)
        );
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
        );
        (, bytes32 salt) = HookMiner.find(address(this), flags, type(DiscipleHook).creationCode, args);
        h = new DiscipleHook{salt: salt}(
            PM, address(0), address(0), address(0), WETH, DiscipleHook.Config(10_000, USDG, 3, address(PM), REF_ETH_USDG, true)
        );
        sw = new PoolSwapTest(PM);
        deal(USDG, address(this), 1e15);
        deal(MSTR, address(this), _mstrFor(1e13));
        IERC20(USDG).approve(address(sw), type(uint256).max);
        IERC20(MSTR).approve(address(sw), type(uint256).max);
        IERC20(USDG).approve(address(h), type(uint256).max);
        IERC20(MSTR).approve(address(h), type(uint256).max);

        console2.log("fork block", block.number);
        console2.log("MSTR price on the 0.25% leader, cents", _priceCents());
        console2.log("leader in-range liquidity", uint256(PM.getLiquidity(uni[0].toId())));
        console2.log("0.24% pool in-range liquidity", uint256(PM.getLiquidity(uni[1].toId())));

        uint256 base = vm.snapshotState();
        uint256 rows;
        uint256[6] memory wins;
        for (uint256 t; t < TVL.length; ++t) {
            vm.revertToState(base);
            PoolKey[6] memory ours;
            for (uint256 f; f < FEES.length; ++f) {
                ours[f] = _create(FEES[f], TVL[t]);
            }
            vm.roll(block.number + 1);
            vm.warp(block.timestamp + 60);
            for (uint256 f; f < FEES.length; ++f) {
                try h.sample(ours[f].toId()) {} catch {}
            }
            vm.roll(block.number + 1);
            vm.warp(block.timestamp + 2);
            uint256 fresh = vm.snapshotState();
            console2.log("");
            console2.log(string.concat("=== Disciple pools at $", vm.toString(TVL[t]), " total value each ==="));
            for (uint256 k; k < SKEW.length; ++k) {
                for (uint256 s; s < SIZES.length; ++s) {
                    for (uint256 d; d < 2; ++d) {
                        vm.revertToState(fresh);
                        bool buy = d == 0;
                        bool[6] memory won = _row(ours, TVL[t], SKEW[k], SIZES[s], buy);
                        rows++;
                        for (uint256 f; f < 6; ++f) {
                            if (won[f]) wins[f]++;
                        }
                    }
                }
            }
        }
        console2.log("");
        for (uint256 f; f < 6; ++f) {
            console2.log(
                string.concat(
                    "Disciple fee ", vm.toString(FEES[f]), " beat both Uniswap pools in ", vm.toString(wins[f]), " of ",
                    vm.toString(rows), " rows"
                )
            );
        }
    }

    function _create(uint24 fee, uint256 tvl) internal returns (PoolKey memory key) {
        DiscipleHook.Source memory s;
        s.kind = 3;
        s.coinIs0 = false; // MSTR is currency1 of the leader (USDG < MSTR)
        s.target = address(PM);
        s.v4Id = UNI25;
        PoolKey memory none;
        (key,) = h.createPool(
            DiscipleHook.CreateParams({
                coin: MSTR,
                quote: USDG,
                fee: fee,
                src: s,
                coinIn: _mstrFor(tvl * 1e6 / 2),
                quoteIn: tvl * 1e6 / 2,
                srcKey: uni[0],
                srcKey2: none
            })
        );
    }

    /// @dev One size and direction at one skew. Buy = USDG in, MSTR out.
    function _row(PoolKey[6] memory ours, uint256 tvl, int256 skew, uint256 dollars, bool buy)
        internal
        returns (bool[6] memory won)
    {
        // Push each Disciple pool off balance with one-sided flow first (a separate earlier block).
        if (skew != 0) {
            uint256 push = tvl * 1e6 / 2 * uint256(skew > 0 ? skew : -skew) / 100;
            for (uint256 f; f < 6; ++f) {
                if (skew > 0) _swap(ours[f], USDG, push); // traders bought MSTR from the pool: it is short MSTR
                else _swap(ours[f], MSTR, _mstrFor(push)); // traders sold MSTR into it: it is long MSTR
            }
            vm.roll(block.number + 1);
            vm.warp(block.timestamp + 2);
        }
        address tokenIn = buy ? USDG : MSTR;
        uint256 amountIn = buy ? dollars * 1e6 : _mstrFor(dollars * 1e6);
        string memory line = string.concat(
            skew == 0 ? "balanced " : (skew > 0 ? "short20  " : "long20   "), buy ? "buy  $" : "sell $", vm.toString(dollars), " |"
        );
        uint256 best;
        for (uint256 i; i < 2; ++i) {
            (uint256 out,) = _quote(uni[i], tokenIn, amountIn);
            if (out > best) best = out;
            line = string.concat(line, " uni", vm.toString(uni[i].fee), " ", vm.toString(_usd(out, buy)));
        }
        for (uint256 f; f < 6; ++f) {
            (uint256 out, uint256 g) = _quote(ours[f], tokenIn, amountIn);
            int256 gap = best == 0 ? int256(0) : (int256(out) - int256(best)) * 10_000 / int256(best);
            won[f] = out > best;
            line = string.concat(
                line, " | dis", vm.toString(FEES[f]), " ", vm.toString(_usd(out, buy)), " (", gap < 0 ? "-" : "+",
                vm.toString(gap < 0 ? uint256(-gap) : uint256(gap)), "bps gas ", vm.toString(g), ")"
            );
        }
        console2.log(line);
    }

    /// @dev Real exact-input swap, rolled back. Returns 0 if the pool refuses the size.
    function _quote(PoolKey memory key, address tokenIn, uint256 amountIn) internal returns (uint256 out, uint256 g) {
        uint256 snap = vm.snapshotState();
        uint256 g0 = gasleft();
        try this.swapExt(key, tokenIn, amountIn) returns (uint256 o) {
            out = o;
        } catch {}
        g = g0 - gasleft();
        vm.revertToState(snap);
    }

    function swapExt(PoolKey memory key, address tokenIn, uint256 amountIn) external returns (uint256) {
        require(msg.sender == address(this), "self");
        return _swap(key, tokenIn, amountIn);
    }

    function _swap(PoolKey memory key, address tokenIn, uint256 amountIn) internal returns (uint256 out) {
        bool zeroForOne = Currency.unwrap(key.currency0) == tokenIn;
        address outT = zeroForOne ? Currency.unwrap(key.currency1) : Currency.unwrap(key.currency0);
        uint256 b0 = IERC20(outT).balanceOf(address(this));
        sw.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        out = IERC20(outT).balanceOf(address(this)) - b0;
    }

    /// @dev Raw USDG per raw MSTR on the leader, X128.
    function _priceX128() internal view returns (uint256) {
        (uint160 sp,,,) = PM.getSlot0(uni[0].toId());
        // sqrtPrice is currency1 (MSTR) per currency0 (USDG); invert for USDG per MSTR.
        uint256 mstrPerUsdg = Math.mulDiv(uint256(sp) * uint256(sp), Q128, uint256(1) << 192);
        return Math.mulDiv(Q128, Q128, mstrPerUsdg);
    }

    function _mstrFor(uint256 usdgRaw) internal view returns (uint256) {
        return Math.mulDiv(usdgRaw, Q128, _priceX128());
    }

    function _priceCents() internal view returns (uint256) {
        return Math.mulDiv(_priceX128(), 10 ** mstrDec, Q128) / 1e4;
    }

    /// @dev Output in whole dollars x100 (cents), valued at the leader's spot.
    function _usd(uint256 out, bool buy) internal view returns (uint256) {
        if (!buy) return out / 1e4;
        return Math.mulDiv(out, _priceX128(), Q128) / 1e4;
    }
}
