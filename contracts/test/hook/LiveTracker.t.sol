// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {DiscipleHook} from "../../src/hook/DiscipleHook.sol";
import {LaunchGateForkTest} from "./LaunchGateFork.t.sol";

/// @notice LIVE POOL TRACKER (read-only, Robinhood fork of "now"). One run = one CSV row on a line starting
///         "TRACKROW,". scripts/track-live.sh runs it on a timer and appends the rows to a CSV.
///         Skips unless FORK_RPC_RH is set. Pool defaults to the live v0.2 pool; override with TRACK_HOOK/TRACK_POOL.
///         Hold baseline = the seed (TRACK_SEED_COIN / TRACK_SEED_QUOTE, raw), valued at the source mid now.
///         Quotes: our quoteView vs the real Uniswap route (STRATEGY/MSTR x MSTR/USDG, executed on the fork and
///         rolled back). Positive bp = we pay MORE than Uniswap (we win), negative = we pay less.
contract LiveTrackerTest is LaunchGateForkTest {
    address internal constant V02_HOOK = 0xC0E513735F35df6A82523744E2aE8a601C772a88;
    bytes32 internal constant V02_POOL = 0x8a1d5f363db9d4a7b874abc858a8fdc86786a9208835aa8360b953cad223b8cd;
    uint256 internal constant SEED_COIN = 53_105.74e18;
    uint256 internal constant SEED_QUOTE = 100e6;

    function _edgeBp(uint256 ours, uint256 src) internal pure returns (int256) {
        if (src == 0) return 0;
        return (int256(ours) - int256(src)) * 10_000 / int256(src);
    }

    /// @dev USDG raw -> "12.345678" style string (6 decimals).
    function _usd(int256 raw) internal pure returns (string memory) {
        bool neg = raw < 0;
        uint256 a = uint256(neg ? -raw : raw);
        string memory frac = vm.toString(a % 1e6 + 1e6); // leading 1 keeps the zeros
        bytes memory f = bytes(frac);
        bytes memory six = new bytes(6);
        for (uint256 i; i < 6; i++) six[i] = f[i + 1];
        return string.concat(neg ? "-" : "", vm.toString(a / 1e6), ".", string(six));
    }

    function test_fork_track() public {
        if (!_fork()) return;
        h = DiscipleHook(payable(vm.envOr("TRACK_HOOK", V02_HOOK)));
        id = PoolId.wrap(vm.envOr("TRACK_POOL", V02_POOL));
        uint256 spot = _spot(); // USDG raw per STRATEGY raw, X128, source mid
        console2.log(string.concat("TRACKROW,", _head(spot), ",", _value(spot), _quotes()));
    }

    /// @dev unix, block, source price (USDG raw per 1e18 STRATEGY raw = price x 1e6), centre gap bp, sampleDue,
    ///      reserves (raw).
    function _head(uint256 spot) internal view returns (string memory) {
        DiscipleHook.PoolView memory v = h.poolState(id);
        int256 gapBp = (int256(v.anchorX128) - int256(spot)) * 10_000 / int256(spot);
        return string.concat(
            vm.toString(block.timestamp),
            ",",
            vm.toString(block.number),
            ",",
            vm.toString(Math.mulDiv(spot, 1e18, Q128)),
            ",",
            vm.toString(gapBp),
            ",",
            vm.toString(h.sampleDue(id)),
            ",",
            vm.toString(v.coinReserve),
            ",",
            vm.toString(v.quoteReserve)
        );
    }

    /// @dev coin share of pool value (bp), pool $, hold-the-seed $, P&L $ and bp, tip jar $ (all at source mid).
    function _value(uint256 spot) internal view returns (string memory) {
        DiscipleHook.PoolView memory v = h.poolState(id);
        uint256 coinVal = Math.mulDiv(v.coinReserve, spot, Q128);
        uint256 poolVal = v.quoteReserve + coinVal;
        uint256 holdVal = vm.envOr("TRACK_SEED_QUOTE", SEED_QUOTE)
            + Math.mulDiv(vm.envOr("TRACK_SEED_COIN", SEED_COIN), spot, Q128);
        int256 pnl = int256(poolVal) - int256(holdVal);
        return string.concat(
            vm.toString(poolVal == 0 ? 0 : coinVal * 10_000 / poolVal),
            ",",
            _usd(int256(poolVal)),
            ",",
            _usd(int256(holdVal)),
            ",",
            _usd(pnl),
            ",",
            vm.toString(holdVal == 0 ? int256(0) : pnl * 10_000 / int256(holdVal)),
            ",",
            _usd(int256(v.jarY + Math.mulDiv(v.jarX, spot, Q128)))
        );
    }

    /// @dev ",buy1,sell1,buy5,sell5,buy20,sell20": our edge vs the real route in bp (+ = we pay more).
    function _quotes() internal returns (string memory row) {
        uint256[3] memory sizes = [uint256(1e6), 5e6, 20e6];
        for (uint256 i; i < 3; i++) {
            int256 b = _edgeBp(_ourOut(true, sizes[i]), _srcOut(true, sizes[i]));
            uint256 cIn = _coinFor(sizes[i]);
            row = string.concat(
                row, ",", vm.toString(b), ",", vm.toString(_edgeBp(_ourOut(false, cIn), _srcOut(false, cIn)))
            );
        }
    }
}
