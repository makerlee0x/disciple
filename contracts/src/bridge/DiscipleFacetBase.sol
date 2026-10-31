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
import {BridgeV4Anchor} from "./libraries/BridgeV4Anchor.sol";
import {IV4OracleHook} from "./interfaces/IV4OracleHook.sol";
import {DiscipleEngine} from "./DiscipleEngine.sol";
import {BridgeStorage} from "./BridgeStorage.sol";

/// @dev Write-side helpers shared by Disciple's swap, LP, and admin facets. No state variables.
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
        address lz_,
        uint8 usdgDecimals_,
        DiscipleEngine engine_,
        address v3Factory_
    ) BridgeStorage(manager_, usdg_, lz_, usdgDecimals_, engine_, v3Factory_) {
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

    /// @notice Persist a same-chain anchor into the book. No-op for an lzRead pool.
    ///         A v4 self-sample that is not warm yet leaves the anchor at 0.
    function _persistReference(Pool storage p) internal {
        uint8 k = p.anchorKind;
        if (k == C.ANCHOR_V3) {
            (uint256 price, uint256 tvl) = BridgeV3Anchor.read(p.v3Pool, p.coin, usdg, p.coinDec, usdgDec);
            _applyAnchor(p, price, tvl);
            return;
        }
        if (k == C.ANCHOR_V4_ORACLE) {
            (uint256 price, uint256 tvl) = IV4OracleHook(p.refHook).consult(p.refPoolId, uint32(C.TWAP_WINDOW));
            if (price == 0) revert NoAnchor();
            _applyAnchor(p, price, tvl);
            return;
        }
        if (k == C.ANCHOR_V4_SAMPLE) {
            bytes32 raw = _rawId(p);
            (bool ready, uint256 price, uint256 tvl) =
                BridgeV4Anchor.sample(poolManager, p.refPoolId, rings[raw], obs[raw], p.refCoinIs0, p.coinDec, usdgDec);
            if (ready && price != 0) _applyAnchor(p, price, tvl);
        }
    }

    /// @dev Write the anchor, keep the raw TVL, and pull the smoothed TVL toward it.
    function _applyAnchor(Pool storage p, uint256 price, uint256 tvl) internal {
        if (price != 0 && price != p.curve.anchor) {
            BridgeCurve.S memory s = p.curve;
            BridgeCurve.onAnchor(s, price);
            p.curve = s;
        }
        if (price != 0) p.updatedAt = block.timestamp;
        p.ethTvl = tvl;
        _smooth(p, tvl);
    }

    /// @dev First reading snaps. Later readings close the error with a 30-minute half-life.
    ///      A zero `dt` does not move the smooth, so two reads in one second cannot jump it.
    function _smooth(Pool storage p, uint256 next) internal {
        uint256 prev = p.smoothedTvl;
        if (prev == 0) {
            p.smoothedTvl = next;
            p.smoothAt = uint64(block.timestamp);
            return;
        }
        uint256 dt =
            p.smoothAt == 0 || block.timestamp <= uint256(p.smoothAt) ? 0 : block.timestamp - uint256(p.smoothAt);
        if (dt == 0) return;
        // Cap the step so one reading after idle time, or one donation, cannot close the whole gap.
        if (dt > C.SMOOTH_STEP) dt = C.SMOOTH_STEP;
        uint256 mag = prev > next ? prev - next : next - prev;
        uint256 left = engine.decayed(mag, dt, C.TWAP_WINDOW);
        p.smoothedTvl = prev > next ? next + left : (next > left ? next - left : 0);
        p.smoothAt = uint64(block.timestamp);
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

    /// @dev Snap the principal baseline up, or decay the gap toward the live principal.
    ///      A zero `dt` does not decay, so several sells in one second share one floor.
    function _touchMark(Pool storage p) internal {
        uint256 principal = BridgeCurve.principalY(p.curve);
        uint256 mark = p.principalMark;
        uint64 nowS = _stamp();
        if (mark == 0 || principal >= mark) {
            p.principalMark = principal;
            p.principalMarkAt = nowS;
            return;
        }
        uint256 dt = block.timestamp > uint256(p.principalMarkAt) ? block.timestamp - uint256(p.principalMarkAt) : 0;
        if (dt == 0) return;
        p.principalMark = principal + engine.decayed(mark - principal, dt, C.MARK_HALF_LIFE);
        p.principalMarkAt = nowS;
    }

    /// @dev Graduation looks at protocol inventory only. An LP deposit is not inventory, so
    ///      deposit-wait-poke-withdraw cannot cross the target.
    function _statusTvl(Pool storage p) internal view returns (uint256) {
        BridgeCurve.S memory s = p.curve;
        return Math.mulDiv(s.protoX, s.anchor, C.WAD) + s.protoY + s.lockedY + s.feePot;
    }

    /// @dev Advance the status flag. The math lives on the engine so this stub stays small in every
    ///      facet. Depth, fee, boost, and Dutch size do not wait on the status window.
    function _touchGrad(PoolId id, Pool storage p) internal {
        uint256 v = _statusTvl(p);
        (bool grad, uint64 above, uint64 below, uint8 edge) =
            engine.stepGrad(v, _gradTvl(p), p.graduated, p.aboveSince, p.belowSince, block.timestamp);
        p.graduated = grad;
        p.aboveSince = above;
        p.belowSince = below;
        if (edge == 1) emit Graduated(id, v, p.smoothedTvl);
        else if (edge == 2) emit Ungraduated(id, v, _gradTvl(p));
    }

    /// @dev Principal that arrives during an open window (a buy or a deposit) raises the cap.
    ///      Outflows do not lower it until the window rolls. Without this, the first buy snapshots
    ///      a zero baseline and every sell in that window quotes nothing.
    function _bumpOutflowBasis(Pool storage p) internal {
        if (p.outflowWindow == 0 || p.outflowCapBps == 0) return;
        uint256 principal = BridgeCurve.principalY(p.curve);
        if (principal > p.outflowBasis) p.outflowBasis = principal;
    }

    /// @dev Timestamp 0 would look like "not started", so a zero clock is stored as 1.
    function _stamp() internal view returns (uint64) {
        return block.timestamp == 0 ? 1 : uint64(block.timestamp);
    }

    function _pull(address token, address from, uint256 raw) internal returns (uint256 got) {
        uint256 beforeBal = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(from, address(this), raw);
        got = IERC20(token).balanceOf(address(this)) - beforeBal;
    }

    /// @dev USDG that entered this pool. It is not available to any other pool.
    function _creditPoolUsdg(Pool storage p, uint256 norm) internal {
        if (norm == 0) return;
        p.usdgHeld += norm;
        usdgClaimsNorm += norm;
    }

    /// @dev Pay USDG out of this pool only. Reverts when the amount is not this pool's.
    function _debitPoolUsdg(Pool storage p, uint256 norm) internal {
        if (norm == 0) return;
        if (norm > p.usdgHeld) revert Invariant();
        p.usdgHeld -= norm;
        usdgClaimsNorm -= norm;
    }

    /// @dev The curve splits match, and this pool's claims cover its book, creator accrual, builder
    ///      accrual, and tip. Locked liquidity sits inside the curve's USDG.
    function _requireReserve(Pool storage p) internal view {
        BridgeCurve.S memory s = p.curve;
        if (s.protoX + s.lpX != s.x || s.protoY + s.lpY + s.feePot + s.lockedY != s.y) revert Invariant();
        if (p.usdgHeld < s.y + p.creatorAccrued + p.builderAccrued + p.tipBudget) revert Invariant();
    }

    function _payout(Pool storage p, uint256 coinNorm, uint256 usdgNorm, address to) internal {
        uint256 coinRaw = _toRaw(coinNorm, p.coinDec);
        uint256 usdgRaw = _toRaw(usdgNorm, usdgDec);
        if (coinRaw > 0) _claimsTo(Currency.wrap(p.coin), coinRaw, to);
        if (usdgRaw > 0) {
            _debitPoolUsdg(p, _toNorm(usdgRaw, usdgDec));
            _claimsTo(usdgC, usdgRaw, to);
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
