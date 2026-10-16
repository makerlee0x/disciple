// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Constants} from "../libraries/Constants.sol";

interface ILensLaunchpad {
    function curveOf(address token) external view returns (address);
    function pricer() external view returns (address);
}

interface ILensCurve {
    function quote() external view returns (address);
    function graduated() external view returns (bool);
    function priceNow() external view returns (uint256);
    function quotePriceUsd() external view returns (uint256);
}

interface ILensMigration {
    function hook() external view returns (address);
    function poolIdOf(address token) external view returns (bytes32);
    function poolManager() external view returns (IPoolManager);
}

interface ILensTwapCurve {
    function twapMcapUsd(uint32 window) external view returns (uint256, uint32);
}

interface ILensTwapHook {
    function twapMcapUsd(PoolId id, uint32 window) external view returns (uint256, uint32);
}

interface ILensPricer {
    function quotePriceUsd(address quote) external view returns (uint256);
}

/// @title Read-only market lens (add-on; no core redeploy)
/// @notice Correct live price/mcap for ALL coins, incl. ones whose already-deployed curve returns the frozen
///         curve-end mcap after graduation. Post-grad: v4 pool slot0 x live QuotePricer.
contract MarketLens {
    ILensLaunchpad public immutable launchpad;
    ILensMigration public immutable migration;

    constructor(address launchpad_, address migration_) {
        launchpad = ILensLaunchpad(launchpad_);
        migration = ILensMigration(migration_);
    }

    /// @return priceWad quote raw * 1e18 / token raw
    /// @return mcapUsd USD WAD
    /// @return graduated whether the price came from the v4 pool
    function market(address token) public view returns (uint256 priceWad, uint256 mcapUsd, bool graduated) {
        ILensCurve c = ILensCurve(launchpad.curveOf(token));
        address q = c.quote();
        graduated = c.graduated();
        uint256 qUsd = c.quotePriceUsd();
        if (graduated) {
            (uint160 sp,,,) = StateLibrary.getSlot0(migration.poolManager(), PoolId.wrap(migration.poolIdOf(token)));
            priceWad = uint160(token) < uint160(q)
                ? Math.mulDiv(Math.mulDiv(sp, sp, 1 << 64), 1e18, 1 << 128)
                : Math.mulDiv(Math.mulDiv(1e18, 1 << 96, sp), 1 << 96, sp);
            address p = launchpad.pricer();
            if (p != address(0)) {
                try ILensPricer(p).quotePriceUsd(q) returns (uint256 v) {
                    if (v > 0) qUsd = v;
                } catch {}
            }
        } else {
            priceWad = c.priceNow();
        }
        mcapUsd = Math.mulDiv(Math.mulDiv(priceWad, Constants.TOTAL_SUPPLY, 1e18), qUsd, 1e18);
    }

    function mcapNow(address token) external view returns (uint256 m) {
        (, m,) = market(token);
    }

    /// @notice Manipulation-resistant mcap (USD WAD) over `window` seconds: curve TWAP pre-grad, hook TWAP post-grad.
    /// @dev Use this (never `market`/`mcapNow`, which are spot) for any safety check or altitude/tier logic.
    ///      Coins on older stacks without an oracle fall back to spot and return actualWindow = 0.
    function twapMcapUsd(address token, uint32 window) external view returns (uint256 mcapUsd, uint32 actualWindow) {
        ILensCurve c = ILensCurve(launchpad.curveOf(token));
        if (c.graduated()) {
            try ILensTwapHook(migration.hook()).twapMcapUsd(PoolId.wrap(migration.poolIdOf(token)), window) returns (
                uint256 m, uint32 w
            ) {
                return (m, w);
            } catch {}
        } else {
            try ILensTwapCurve(address(c)).twapMcapUsd(window) returns (uint256 m, uint32 w) {
                return (m, w);
            } catch {}
        }
        (, mcapUsd,) = market(token);
    }
}
