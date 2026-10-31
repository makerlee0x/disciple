// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BridgeConstants as C} from "./libraries/BridgeConstants.sol";
import {BridgeCurve} from "./libraries/BridgeCurve.sol";
import {BridgeFee} from "./libraries/BridgeFee.sol";
import {BridgeV3Anchor} from "./libraries/BridgeV3Anchor.sol";
import {BridgeEngine} from "./BridgeEngine.sol";
import {ILzReadConsumer} from "./interfaces/ILzRead.sol";
import {BridgeStorage} from "./BridgeStorage.sol";

interface IBridgeHandle {
    function handle(bytes calldata data) external returns (bytes memory);
}

/// @title Disciple
/// @notice Disciple is a Uniswap v4 hook that bootstraps a new liquidity pool from a tiny seed through
///         incentivized arbitrage. It uses an onchain bonding curve anchored to an existing pool's price,
///         compounds every fee back into the pool, and earns Morpho yield on idle USDG once the pool
///         graduates. One deployment quotes many coin/USDG pools. Each pool picks an anchor once, at
///         creation: a LayerZero lzRead of a remote 30-minute TWAP, or a same-chain read of a Uniswap v3
///         pool's `observe`. v4 concentrated liquidity is disabled, and every swap is quoted in
///         `beforeSwap`. See `DESIGN.md`. The contract name stays `BridgeLaunchHook` because `DiscipleHook`
///         is already the post-graduation fee hook in this repo.
/// @dev Storage lives here. Writes `delegatecall` a facet whose address is fixed at construction:
///      swaps, LP accounting, and the vault admin. Views run here so they stay `staticcall`-able.
///      No facet can be replaced. The v4 `slot0` price is a dummy and is never read.
contract BridgeLaunchHook is BridgeStorage, IHooks, ILzReadConsumer {
    using PoolIdLibrary for PoolKey;

    address public immutable swapFacet;
    address public immutable lpFacet;
    address public immutable adminFacet;

    constructor(
        IPoolManager manager_,
        address usdg_,
        address vault_,
        address lz_,
        uint8 usdgDecimals_,
        BridgeEngine engine_,
        address swapFacet_,
        address lpFacet_,
        address adminFacet_
    ) BridgeStorage(manager_, usdg_, vault_, lz_, usdgDecimals_, engine_) {
        if (swapFacet_ == address(0) || lpFacet_ == address(0) || adminFacet_ == address(0)) {
            revert BadCreate();
        }
        swapFacet = swapFacet_;
        lpFacet = lpFacet_;
        adminFacet = adminFacet_;
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeAddLiquidity = true;
        p.beforeRemoveLiquidity = true;
        p.beforeSwap = true;
        p.beforeSwapReturnDelta = true;
    }

    // ───────────────────────────── writes (forwarded) ────────────────

    function createPool(CreateParams calldata) external returns (PoolKey memory, PoolId) {
        _forward(lpFacet);
    }

    function setCreator(PoolId, address) external {
        _forward(lpFacet);
    }

    function updatePrice(PoolId) external payable {
        _forward(adminFacet);
    }

    function onLzRead(bytes32, bytes calldata) external {
        _forward(lpFacet);
    }

    function fundTip(PoolId, uint256) external {
        _forward(lpFacet);
    }

    function deposit(PoolId, uint256, uint256) external returns (uint256) {
        _forward(lpFacet);
    }

    function redeem(PoolId, uint256) external returns (uint256, uint256) {
        _forward(lpFacet);
    }

    function claimCreatorFees(PoolId) external returns (uint256) {
        _forward(lpFacet);
    }

    function rebalance(PoolId) external {
        _forward(adminFacet);
    }

    function pullVaultOnLoss(PoolId) external {
        _forward(adminFacet);
    }

    function proposeVault(PoolId, address) external {
        _forward(adminFacet);
    }

    function executeVault(PoolId) external {
        _forward(adminFacet);
    }

    function pullAllFromVault(PoolId) external {
        _forward(adminFacet);
    }

    function renounceVaultAdmin(PoolId) external {
        _forward(adminFacet);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        uint8 op = abi.decode(data, (uint8));
        address facet = op >= OP_REBALANCE ? adminFacet : lpFacet;
        bytes memory ret = _delegate(facet, abi.encodeCall(IBridgeHandle.handle, (data)));
        return abi.decode(ret, (bytes));
    }

    receive() external payable {}

    // ───────────────────────────── quotes ────────────────────────────

    function spotPrice(PoolId id) external view returns (uint256) {
        Pool storage p = pools[id];
        if (!p.exists) revert UnknownPool();
        (BridgeCurve.S memory s,,) = _referenced(p);
        return BridgeCurve.spot(s);
    }

    /// @notice Live anchor. Same-chain calls `observe` now. Cross-chain returns the last lzRead.
    function liveAnchor(PoolId id) external view returns (uint256 priceWad, uint256 tvlWad) {
        Pool storage p = pools[id];
        if (!p.exists) revert UnknownPool();
        if (p.anchorKind == C.ANCHOR_V3) return BridgeV3Anchor.read(p.v3Pool, p.coin, usdg, p.coinDec, usdgDec);
        return (p.curve.anchor, p.ethTvl);
    }

    function bridgeQuote(PoolId id) external view returns (BridgeQuote memory q) {
        Pool storage p = pools[id];
        if (!p.exists) revert UnknownPool();
        (BridgeCurve.S memory s, uint256 refTvl, uint256 age) = _referenced(p);
        q.anchorPriceWad = s.anchor;
        q.poolPriceWad = BridgeCurve.spot(s);
        q.graduated = p.graduated;
        q.stale = p.anchorKind != C.ANCHOR_V3 && (s.anchor == 0 || age >= C.STALE_AFTER);
        if (s.anchor > 0) q.priceGapBps = _signedBps(q.poolPriceWad, s.anchor);
        uint256 v = BridgeCurve.tvl(s);
        if (v > 0) {
            uint256 coinVal = Math.mulDiv(s.x, s.anchor, C.WAD);
            q.imbalanceBps = coinVal >= s.y
                ? int256(Math.mulDiv(coinVal - s.y, C.BPS, v))
                : -int256(Math.mulDiv(s.y - coinVal, C.BPS, v));
        }
        uint256 gradTvl = refTvl == 0 ? 0 : Math.mulDiv(refTvl, C.GRAD_NUM, C.GRAD_DEN);
        uint256 base = BridgeFee.baseFeeBps(v, gradTvl);
        uint256 dir = q.poolPriceWad > s.anchor ? base / 2 : (q.poolPriceWad < s.anchor ? base + base / 2 : base);
        q.suggestedFeeBps = BridgeFee.applyStale(dir, p.anchorKind == C.ANCHOR_V3 ? 0 : age);
    }

    /// @notice Exact-in quote. `capped` means the requested input hits the seed guard or the USDG floor;
    ///         `amountInUsed` is the largest input that still clears. A v4 swap of the full amount would revert.
    function quoteExactIn(PoolKey calldata key, bool zeroForOne, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, uint256 fee, bool capped, uint256 amountInUsed)
    {
        Pool storage p = pools[key.toId()];
        if (!p.exists) revert UnknownPool();
        (BridgeCurve.S memory s, uint256 refTvl, uint256 age) = _referenced(p);
        if (s.anchor == 0) revert NoAnchor();
        bool exactCoinIn = zeroForOne == p.coinIs0;
        BridgeCurve.Ctx memory ctx = _ctx(p, s, refTvl, age);
        uint8 decIn = exactCoinIn ? p.coinDec : usdgDec;
        uint256 norm = _toNorm(amountIn, decIn);
        BridgeCurve.Fill memory f;
        if (exactCoinIn) (s, f) = engine.sell(s, ctx, norm);
        else (s, f) = engine.buy(s, ctx, norm);
        capped = f.capped;
        if (exactCoinIn) {
            amountInUsed = _toRaw(f.coinIn, p.coinDec);
            amountOut = _toRaw(f.usdgOut, usdgDec);
        } else {
            amountInUsed = _toRaw(f.usdgIn, usdgDec);
            amountOut = _toRaw(f.coinOut, p.coinDec);
        }
        fee = _toRaw(f.fee, usdgDec);
    }

    function curve(PoolId id) external view returns (BridgeCurve.S memory s) {
        Pool storage p = pools[id];
        if (!p.exists) revert UnknownPool();
        (s,,) = _referenced(p);
    }

    function creatorFees(PoolId id) external view returns (uint256) {
        return pools[id].creatorAccrued;
    }

    /// @notice Fee credit an LP would have if they still hold through this block's parked fees.
    ///         Shares minted in the current block are excluded. They start earning next block.
    function pendingFee(PoolId id, address user) external view returns (uint256) {
        return _pendingFee(pools[id], id, user);
    }

    function feeIndex(PoolId id) external view returns (uint256) {
        return pools[id].feeIndex;
    }

    function poolVault(PoolId id) external view returns (address) {
        return pools[id].poolVault;
    }

    function vaultAdmin(PoolId id) external view returns (address) {
        return pools[id].vaultAdmin;
    }

    function vaultFrozen(PoolId id) external view returns (bool) {
        return pools[id].vaultFrozen;
    }

    function pendingVaultOf(PoolId id) external view returns (address next, uint256 eta) {
        return (pools[id].pendingVault, pools[id].vaultEta);
    }

    /// @notice Best arb against the live anchor and the fee a swap would charge right now.
    ///         `amountIn` / `amountOut` are raw. A returned buy or sell is executable (not capped).
    function arbQuote(PoolId id) external view returns (ArbQuote memory q) {
        Pool storage p = pools[id];
        if (!p.exists) revert UnknownPool();
        (BridgeCurve.S memory s, uint256 refTvl, uint256 age) = _referenced(p);
        if (s.anchor == 0) return q;
        BridgeCurve.Ctx memory ctx = _ctx(p, s, refTvl, age);
        (bool buyCoin, uint256 normIn,, uint256 profit) = engine.quote(s, ctx);
        q.buyCoin = buyCoin;
        if (normIn == 0 || profit == 0) return q;
        if (buyCoin) {
            q.amountIn = _toRaw(normIn, usdgDec);
            uint256 norm = _toNorm(q.amountIn, usdgDec);
            (uint256 out, uint256 profitRaw) = engine.fill(s, ctx, norm, true);
            q.amountOut = _toRaw(out, p.coinDec);
            q.profitWad = profitRaw;
        } else {
            q.amountIn = _toRaw(normIn, p.coinDec);
            uint256 norm = _toNorm(q.amountIn, p.coinDec);
            (uint256 out, uint256 profitRaw) = engine.fill(s, ctx, norm, false);
            q.amountOut = _toRaw(out, usdgDec);
            q.profitWad = profitRaw;
        }
        if (q.amountIn == 0 || q.amountOut == 0 || q.profitWad == 0) {
            q.amountIn = 0;
            q.amountOut = 0;
            q.profitWad = 0;
        }
    }

    function reserveOk(PoolId id) external view returns (bool) {
        BridgeCurve.S memory s = pools[id].curve;
        return
            s.protoX + s.lpX == s.x && s.protoY + s.lpY + s.feePot == s.y && pools[id].vaultAssets <= s.protoY + s.lpY;
    }

    // ───────────────────────────── hooks ─────────────────────────────

    function beforeInitialize(address, PoolKey calldata, uint160) external view returns (bytes4) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        revert ExternalInit();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert LiquidityDisabled();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert LiquidityDisabled();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, bytes calldata)
        external
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        _forward(swapFacet);
    }

    function afterSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, int128)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    // ───────────────────────────── internals ─────────────────────────

    function _pendingFee(Pool storage p, PoolId id, address user) internal view returns (uint256 credit) {
        credit = feeCreditOf[id][user];
        uint256 sh = sharesOf[id][user];
        if (sh == 0) return credit;
        uint256 fresh = freshShares[id][user];
        uint64 fb = freshBlock[id][user];
        uint256 prev = feeIndexOf[id][user];
        uint256 idx = p.feeIndex;
        if (p.openBlock != 0 && p.openBlock != uint64(block.number) && p.blockFee > 0) {
            uint256 eligible = p.openShares > p.redeemedEligible ? p.openShares - p.redeemedEligible : 0;
            if (eligible > 0) idx += Math.mulDiv(p.blockFee, C.RAY, eligible);
        }
        uint256 currentExtra;
        if (p.openBlock == uint64(block.number) && p.blockFee > 0) {
            uint256 eligible = p.openShares > p.redeemedEligible ? p.openShares - p.redeemedEligible : 0;
            if (eligible > 0) currentExtra = Math.mulDiv(p.blockFee, C.RAY, eligible);
        }
        if (fb == uint64(block.number) && fresh > 0) {
            uint256 settled = sh > fresh ? sh - fresh : 0;
            uint256 to = idx + currentExtra;
            if (settled > 0 && to > prev) credit += Math.mulDiv(settled, to - prev, C.RAY);
            return credit;
        }
        if (fb != 0 && fresh > 0) {
            uint256 start = indexAtBlock[id][fb];
            if (fb == p.openBlock && p.openBlock != uint64(block.number)) start = idx;
            uint256 settled = sh > fresh ? sh - fresh : 0;
            if (settled > 0 && start > prev) credit += Math.mulDiv(settled, start - prev, C.RAY);
            uint256 to = idx + currentExtra;
            if (to > start) credit += Math.mulDiv(sh, to - start, C.RAY);
            return credit;
        }
        uint256 endIdx = idx + currentExtra;
        if (endIdx > prev) credit += Math.mulDiv(sh, endIdx - prev, C.RAY);
    }

    function _forward(address facet) internal {
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), facet, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
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
}
