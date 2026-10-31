// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {CurrencySettler} from "../libraries/CurrencySettler.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BridgeConstants as C} from "./libraries/BridgeConstants.sol";
import {BridgeCurve} from "./libraries/BridgeCurve.sol";
import {DiscipleEngine} from "./DiscipleEngine.sol";
import {DiscipleFacetBase} from "./DiscipleFacetBase.sol";

interface IBridgeAdminOps {
    function pullShortfall(PoolId id, uint256 shortNorm) external returns (bool);
    function afterTrade(PoolId id) external;
}

/// @title Disciple swap facet
/// @notice `beforeSwap` for Disciple (`DiscipleHook`). Quotes the curve and settles ERC-6909 claims.
///         Vault pulls and the post-trade rebalance `delegatecall` the admin facet so this contract
///         stays deployable.
contract DiscipleSwapFacet is DiscipleFacetBase {
    using PoolIdLibrary for PoolKey;
    using CurrencySettler for Currency;

    address internal immutable adminFacet;

    constructor(
        IPoolManager manager_,
        address usdg_,
        address vault_,
        address lz_,
        uint8 usdgDecimals_,
        DiscipleEngine engine_,
        address adminFacet_
    ) DiscipleFacetBase(manager_, usdg_, vault_, lz_, usdgDecimals_, engine_) {
        if (adminFacet_ == address(0)) revert BadCreate();
        adminFacet = adminFacet_;
    }

    function beforeSwap(
        address sender,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        bytes calldata hookData
    ) external returns (bytes4, BeforeSwapDelta, uint24) {
        _onlyDelegate();
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        if (_locked) revert Reentrancy();
        _locked = true;

        if (params.amountSpecified > 0) revert ExactOutUnsupported();
        uint256 specRaw = uint256(-params.amountSpecified);
        if (specRaw == 0 || specRaw > uint256(uint128(type(int128).max))) revert Amount();

        PoolId id = key.toId();
        Pool storage p = pools[id];
        if (!p.exists) revert UnknownPool();
        // Same-chain recenters on the live TWAP before the quote. Cross-chain keeps the stored anchor.
        _persistReference(p);
        if (p.curve.anchor == 0) revert NoAnchor();
        // Snapshot the block's opening LP book before this trade can move it.
        _rollBlock(p, id);

        // exact-in: the specified currency is the input. zeroForOne means the input is currency0.
        bool specIsCoin = params.zeroForOne ? p.coinIs0 : !p.coinIs0;

        (bool mintLp, address recipient) = _decodeHookData(hookData, sender);
        BridgeCurve.S memory s = p.curve;
        BridgeCurve.Ctx memory ctx = _ctx(p, s);
        _rollOutflow(p);

        uint256 specNorm = _toNorm(specRaw, specIsCoin ? p.coinDec : usdgDec);
        uint256 gap = _gap(p);
        BridgeCurve.Fill memory f;
        if (specIsCoin) (s, f) = engine.trade(s, ctx, specNorm, true, gap);
        else (s, f) = engine.trade(s, ctx, specNorm, false, gap);

        if (f.capped) revert ExceedsCap();
        if (specIsCoin) {
            if (f.coinIn != specNorm || f.usdgOut == 0) revert ZeroOutput();
        } else if (f.usdgIn != specNorm || f.coinOut == 0) {
            revert ZeroOutput();
        }

        p.curve = s;
        // One clock for both quotes. The next trade in this second sees no gap, so the launch
        // discount is not replaced by a Dutch price that has not had time to drift.
        p.dutchAt = block.timestamp == 0 ? 1 : uint64(block.timestamp);
        // Park the LP's fee until the next block so shares minted in this one cannot collect it.
        if (f.toLp > 0) p.blockFee += f.toLp;
        p.tipBudget += f.tip;
        p.creatorAccrued += f.creator;
        if (specIsCoin) _consumeOutflow(p, f.usdgOut);

        uint256 unspecRaw;
        if (!mintLp) {
            unspecRaw = specIsCoin ? _toRaw(f.usdgOut, usdgDec) : _toRaw(f.coinOut, p.coinDec);
            if (unspecRaw == 0) revert ZeroOutput();
            if (specIsCoin) _ensureUsdgLiquid(p, f.usdgOut);
        } else {
            _parkProceeds(p, id, recipient, f);
        }

        _settleSwap(p, specIsCoin, specRaw, unspecRaw);
        _noteClaims(specIsCoin, specRaw, unspecRaw);
        _afterTrade(id);

        emit Swapped(
            id,
            sender,
            !specIsCoin,
            specIsCoin ? f.coinIn : f.coinOut,
            specIsCoin ? f.usdgOut : f.usdgIn,
            f.fee,
            f.spotAfter
        );

        _locked = false;
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(uint128(specRaw)), -int128(uint128(unspecRaw))), 0);
    }

    function _parkProceeds(Pool storage p, PoolId id, address recipient, BridgeCurve.Fill memory f) internal {
        uint256 dx = f.coinOut;
        uint256 dy = f.usdgOut;
        if (dx == 0 && dy == 0) revert ZeroOutput();
        uint256 added = dy + Math.mulDiv(dx, p.curve.anchor, C.WAD);
        BridgeCurve.S memory parked = p.curve;
        BridgeCurve.addLiquidity(parked, dx, dy);
        p.curve = parked;
        _mintShares(p, id, recipient, added, dx, dy);
        emit MintedLp(id, recipient, sharesOf[id][recipient], dx, dy);
    }

    function _settleSwap(Pool storage p, bool specIsCoin, uint256 specRaw, uint256 unspecRaw) internal {
        Currency coinC = Currency.wrap(p.coin);
        Currency spec = specIsCoin ? coinC : usdgC;
        Currency unspec = specIsCoin ? usdgC : coinC;
        spec.take(poolManager, address(this), specRaw, true);
        if (unspecRaw > 0) unspec.settle(poolManager, address(this), unspecRaw, true);
    }

    /// @dev Keep `usdgClaimsNorm` aligned with the claim mint/burn `_settleSwap` just did.
    function _noteClaims(bool specIsCoin, uint256 specRaw, uint256 unspecRaw) internal {
        if (specIsCoin) {
            if (unspecRaw > 0) usdgClaimsNorm -= _toNorm(unspecRaw, usdgDec);
        } else {
            usdgClaimsNorm += _toNorm(specRaw, usdgDec);
        }
    }

    /// @dev `needNorm` has already left principal in the curve update, but the ERC-6909 claims
    ///      are burned afterwards. Pull from the vault only when it would otherwise hold more
    ///      USDG than the remaining principal (that excess is the part of the payout that was
    ///      invested). Comparing `needNorm` to post-trade principal double-counts the payout and
    ///      makes every floor-sized sell look unbacked when nothing is in the vault.
    function _ensureUsdgLiquid(Pool storage p, uint256 needNorm) internal {
        if (needNorm == 0) return;
        uint256 principal = p.curve.protoY + p.curve.lpY;
        if (p.vaultAssets <= principal) return;
        uint256 shortNorm = p.vaultAssets - principal;
        bytes memory ret = _delegate(adminFacet, abi.encodeCall(IBridgeAdminOps.pullShortfall, (_id(p), shortNorm)));
        if (!abi.decode(ret, (bool))) revert ExceedsCap();
    }

    function _afterTrade(PoolId id) internal {
        _delegate(adminFacet, abi.encodeCall(IBridgeAdminOps.afterTrade, (id)));
    }

    function _rollOutflow(Pool storage p) internal {
        if (p.outflowWindow == 0 || p.outflowCapBps == 0) return;
        bool expired = p.outflowWindow == C.OUTFLOW_PER_BLOCK
            ? block.number != p.outflowStart
            : block.timestamp >= uint256(p.outflowStart) + p.outflowWindow;
        if (!expired && p.outflowStart != 0) return;
        p.outflowStart = p.outflowWindow == C.OUTFLOW_PER_BLOCK ? uint32(block.number) : uint32(block.timestamp);
        p.outflowUsed = 0;
        p.outflowBasis = BridgeCurve.principalY(p.curve);
    }

    function _consumeOutflow(Pool storage p, uint256 norm) internal {
        if (p.outflowWindow == 0 || norm == 0) return;
        p.outflowUsed += norm;
    }

    function _decodeHookData(bytes calldata hookData, address sender) internal pure returns (bool mintLp, address to) {
        if (hookData.length == 0) return (false, sender);
        (mintLp, to) = abi.decode(hookData, (bool, address));
        if (to == address(0)) to = sender;
    }
}
