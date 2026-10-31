// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CurrencySettler} from "../libraries/CurrencySettler.sol";
import {BridgeConstants as C} from "./libraries/BridgeConstants.sol";
import {BridgeCurve} from "./libraries/BridgeCurve.sol";
import {BridgeV3Anchor} from "./libraries/BridgeV3Anchor.sol";
import {DiscipleEngine} from "./DiscipleEngine.sol";
import {BridgeStorage} from "./BridgeStorage.sol";

/// @dev Write-side helpers shared by Disciple's swap, LP, and vault facets. No state variables.
abstract contract DiscipleFacetBase is BridgeStorage {
    using PoolIdLibrary for PoolKey;
    using CurrencySettler for Currency;
    using CurrencyLibrary for Currency;
    using SafeERC20 for IERC20;

    /// @dev This facet's own address. Under `delegatecall`, `address(this)` is the hook.
    address internal immutable self;

    constructor(
        IPoolManager manager_,
        address usdg_,
        address vault_,
        address lz_,
        uint8 usdgDecimals_,
        DiscipleEngine engine_
    ) BridgeStorage(manager_, usdg_, vault_, lz_, usdgDecimals_, engine_) {
        self = address(this);
    }

    /// @dev Direct calls hit the facet's empty storage. Every entry point must run as the hook.
    function _onlyDelegate() internal view {
        if (address(this) == self) revert OnlyDelegate();
    }

    function _delegate(address facet, bytes memory data) internal returns (bytes memory ret) {
        bool ok;
        (ok, ret) = facet.delegatecall(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    /// @notice Persist a same-chain TWAP into the book. No-op for an lzRead pool.
    function _persistReference(Pool storage p) internal {
        if (p.anchorKind != C.ANCHOR_V3) return;
        (uint256 price, uint256 tvl) = BridgeV3Anchor.read(p.v3Pool, p.coin, usdg, p.coinDec, usdgDec);
        if (price != p.curve.anchor) {
            BridgeCurve.S memory s = p.curve;
            BridgeCurve.onAnchor(s, price);
            p.curve = s;
        }
        p.ethTvl = tvl;
        p.updatedAt = block.timestamp;
    }

    /// @dev First touch of a block rolls the previous block's LP fee onto shares that existed at its open,
    ///      then snapshots the book the rest of this block will settle deposits and redeems against.
    function _rollBlock(Pool storage p, PoolId id) internal {
        if (p.openBlock == uint64(block.number)) return;
        uint64 prev = p.openBlock;
        if (prev != 0 && p.blockFee > 0) {
            uint256 eligible = p.openShares > p.redeemedEligible ? p.openShares - p.redeemedEligible : 0;
            if (eligible == 0) {
                uint256 amt = p.blockFee > p.curve.feePot ? p.curve.feePot : p.blockFee;
                p.curve.feePot -= amt;
                p.curve.protoY += amt;
            } else {
                p.feeIndex += Math.mulDiv(p.blockFee, C.RAY, eligible);
            }
        }
        if (prev != 0) indexAtBlock[id][prev] = p.feeIndex;
        p.blockFee = 0;
        p.openBlock = uint64(block.number);
        p.openSpot = BridgeCurve.spot(p.curve);
        p.openLpX = p.curve.lpX;
        p.openLpY = p.curve.lpY;
        p.openShares = p.totalShares;
        p.openTakenX = 0;
        p.openTakenY = 0;
        p.redeemedEligible = 0;
        p.revOpenTvl = BridgeCurve.tvl(p.curve);
    }

    /// @dev Add `notion` after decaying. No path subtracts volume except the time decay inside `engine.decayed`.
    function _noteRev(Pool storage p, uint256 notion) internal {
        if (notion == 0) return;
        uint256 dt = p.revAt == 0 || block.timestamp <= uint256(p.revAt) ? 0 : block.timestamp - uint256(p.revAt);
        p.revVolume = engine.decayed(p.revVolume, dt, p.revHalfLife) + notion;
        p.revAt = uint64(block.timestamp);
    }

    function _mintShares(Pool storage p, PoolId id, address to, uint256 added, uint256 coinNorm, uint256 usdgNorm)
        internal
        returns (uint256 sh)
    {
        if (added == 0) revert Dust();
        _promote(p, id, to);
        _checkpoint(p, id, to);
        uint256 valBefore = p.openLpY + Math.mulDiv(p.openLpX, p.curve.anchor, C.WAD);
        sh = Math.mulDiv(added, p.openShares + C.SHARE_OFFSET, valBefore + 1);
        if (sh == 0) revert Dust();
        sharesOf[id][to] += sh;
        p.totalShares += sh;
        freshShares[id][to] += sh;
        freshCoin[id][to] += coinNorm;
        freshUsdg[id][to] += usdgNorm;
        freshBlock[id][to] = uint64(block.number);
    }

    /// @dev Credit only shares that were already settled. Same-block mints are not in that balance.
    function _checkpoint(Pool storage p, PoolId id, address user) internal {
        uint256 fresh = freshBlock[id][user] == uint64(block.number) ? freshShares[id][user] : 0;
        uint256 sh = sharesOf[id][user];
        uint256 settled = sh > fresh ? sh - fresh : 0;
        uint256 prev = feeIndexOf[id][user];
        if (settled > 0 && p.feeIndex > prev) {
            feeCreditOf[id][user] += Math.mulDiv(settled, p.feeIndex - prev, C.RAY);
        }
        feeIndexOf[id][user] = p.feeIndex;
    }

    /// @dev Fold a previous block's fresh shares in. Their fee index starts after that block's fees.
    function _promote(Pool storage p, PoolId id, address user) internal {
        uint64 fb = freshBlock[id][user];
        if (fb == 0 || fb == uint64(block.number)) return;
        uint256 start = indexAtBlock[id][fb];
        uint256 fresh = freshShares[id][user];
        uint256 sh = sharesOf[id][user];
        uint256 settled = sh > fresh ? sh - fresh : 0;
        uint256 prev = feeIndexOf[id][user];
        if (settled > 0 && start > prev) {
            feeCreditOf[id][user] += Math.mulDiv(settled, start - prev, C.RAY);
        }
        if (sh > 0 && p.feeIndex > start) {
            feeCreditOf[id][user] += Math.mulDiv(sh, p.feeIndex - start, C.RAY);
        }
        feeIndexOf[id][user] = p.feeIndex;
        freshShares[id][user] = 0;
        freshCoin[id][user] = 0;
        freshUsdg[id][user] = 0;
        freshBlock[id][user] = 0;
    }

    function _maybeGraduate(PoolId id, Pool storage p) internal {
        if (p.graduated || p.ethTvl == 0) return;
        uint256 v = BridgeCurve.tvl(p.curve);
        if (Math.mulDiv(v, C.GRAD_DEN, C.GRAD_NUM) >= p.ethTvl) {
            p.graduated = true;
            emit Graduated(id, v, p.ethTvl);
        }
    }

    function _pull(address token, address from, uint256 raw) internal returns (uint256 got) {
        uint256 beforeBal = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(from, address(this), raw);
        got = IERC20(token).balanceOf(address(this)) - beforeBal;
    }

    function _payout(Pool storage p, uint256 coinNorm, uint256 usdgNorm, address to) internal {
        uint256 coinRaw = _toRaw(coinNorm, p.coinDec);
        uint256 usdgRaw = _toRaw(usdgNorm, usdgDec);
        if (coinRaw > 0) _claimsTo(Currency.wrap(p.coin), coinRaw, to);
        if (usdgRaw > 0) {
            _claimsTo(usdgC, usdgRaw, to);
            usdgClaimsNorm -= _toNorm(usdgRaw, usdgDec);
        }
    }

    function _walletToClaims(Currency c, uint256 raw) internal {
        c.settle(poolManager, address(this), raw, false);
        c.take(poolManager, address(this), raw, true);
    }

    function _claimsTo(Currency c, uint256 raw, address to) internal {
        c.settle(poolManager, address(this), raw, true);
        c.take(poolManager, to, raw, false);
    }

    function _id(Pool storage p) internal view returns (PoolId) {
        return p.key.toId();
    }
}
