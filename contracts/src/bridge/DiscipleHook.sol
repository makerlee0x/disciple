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
import {BridgeV4Anchor} from "./libraries/BridgeV4Anchor.sol";
import {IV4OracleHook} from "./interfaces/IV4OracleHook.sol";
import {DiscipleEngine} from "./DiscipleEngine.sol";
import {ILzReadConsumer} from "./interfaces/ILzRead.sol";
import {BridgeStorage} from "./BridgeStorage.sol";

interface IBridgeHandle {
    function handle(bytes calldata data) external returns (bytes memory);
}

/// @title Disciple
/// @notice Disciple is a Uniswap v4 hook that bootstraps a new liquidity pool from a tiny seed through
///         incentivized arbitrage. It uses an onchain bonding curve anchored to an existing pool's price.
///         One deployment quotes many coin/USDG pools. Each
///         pool picks an anchor once, at creation: lzRead of a remote TWAP, a same-chain v3 `observe`,
///         a v4 hook `consult`, or a 30-minute ring this hook samples from a v4 pool's `slot0`.
///         v4 concentrated liquidity is disabled, and every swap is quoted in `beforeSwap`. See
///         `DESIGN.md`. This contract is `DiscipleHook`. The post-graduation 1% fee hook in this
///         repo is `AscensionHook`. Graduated status turns on after 77 continuous minutes at or
///         above the live target and turns off after 77 continuous minutes below it. One threshold,
///         100%. The depth band, the fee, the boost, and Dutch size keep following live progress
///         either way. Before graduation the whole fee compounds for LPs. While status is on, each
///         fee is 33% creator, 33% LPs, 33% permanent locked liquidity, and 1% hook builder.
///         Turning status off returns new fees to LPs. The builder is one address, set here, and
///         only that address can hand it off. Pools are not migrated onto `AscensionHook`.
/// @dev Storage lives here. Writes `delegatecall` a facet whose address is fixed at construction:
///      swaps, pool creation, LP accounting, and price updates. Views run here so they stay `staticcall`-able.
///      No facet can be replaced. The v4 `slot0` price is a dummy and is never read.
contract DiscipleHook is BridgeStorage, IHooks, ILzReadConsumer {
    using PoolIdLibrary for PoolKey;

    address public immutable swapFacet;
    address public immutable lpFacet;
    address public immutable createFacet;
    address public immutable adminFacet;

    constructor(
        IPoolManager manager_,
        address usdg_,
        address lz_,
        uint8 usdgDecimals_,
        DiscipleEngine engine_,
        address swapFacet_,
        address lpFacet_,
        address createFacet_,
        address adminFacet_,
        address builder_,
        address v3Factory_
    ) BridgeStorage(manager_, usdg_, lz_, usdgDecimals_, engine_, v3Factory_) {
        if (
            swapFacet_ == address(0) || lpFacet_ == address(0) || createFacet_ == address(0)
                || adminFacet_ == address(0) || builder_ == address(0)
        ) revert BadCreate();
        swapFacet = swapFacet_;
        lpFacet = lpFacet_;
        createFacet = createFacet_;
        adminFacet = adminFacet_;
        builder = builder_;
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

    /// @notice Permissionless, multiple pools per coin. Anyone can create a pool for any coin.
    ///         Creator identity is not checked. `tickSpacing` distinguishes pools for one coin.
    function createPool(CreateParams calldata) external returns (PoolKey memory, PoolId) {
        _forward(createFacet);
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

    function poke(PoolId) external {
        _forward(adminFacet);
    }

    /// @notice Current builder names the next recipient. Pool creators cannot call this.
    function proposeBuilder(address) external {
        _forward(adminFacet);
    }

    /// @notice Pending address takes the builder role and clears the pending slot.
    function acceptBuilder() external {
        _forward(adminFacet);
    }

    /// @notice Pull this pool's accrued builder share. Only the current builder.
    function claimBuilderFees(PoolId) external returns (uint256) {
        _forward(adminFacet);
    }

    /// @notice Builder allowlist for v4 oracle hooks and the remote PoolManager of an lzRead slot.
    function setOracleAllowed(address, bool) external {
        _forward(adminFacet);
    }

    /// @notice Builder allowlist for remote lenses.
    function setLensAllowed(address, bool) external {
        _forward(adminFacet);
    }

    /// @notice Builder-only. Sends stray ETH. Does not move pool tokens.
    function rescueEth(address) external {
        _forward(adminFacet);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        uint8 op = abi.decode(data, (uint8));
        address facet = op == OP_POKE || op == OP_BUILDER || op == OP_READ ? adminFacet : lpFacet;
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

    /// @notice Live anchor. Same-chain reads the reference now. Cross-chain returns the last lzRead.
    ///         A v4 self-sample that is not warm yet returns the stored anchor (zero until the ring covers
    ///         30 minutes).
    function liveAnchor(PoolId id) external view returns (uint256 priceWad, uint256 tvlWad) {
        Pool storage p = pools[id];
        if (!p.exists) revert UnknownPool();
        uint8 k = p.anchorKind;
        if (k == C.ANCHOR_V3) return BridgeV3Anchor.read(p.v3Pool, p.coin, usdg, p.coinDec, usdgDec);
        if (k == C.ANCHOR_V4_ORACLE) return IV4OracleHook(p.refHook).consult(p.refPoolId, uint32(C.TWAP_WINDOW));
        if (k == C.ANCHOR_V4_SAMPLE) {
            (bool ready, uint256 price, uint256 tvl) = BridgeV4Anchor.peek(
                poolManager, p.refPoolId, rings[_rawId(p)], obs[_rawId(p)], p.refCoinIs0, p.coinDec, usdgDec
            );
            if (ready) return (price, tvl);
        }
        return (p.curve.anchor, p.ethTvl);
    }

    /// @notice The Dutch bid and ask, the USDG size of each, and the progress fee. `gapWad` is the ask
    ///         gap. A zero gap means that side is not overriding the curve. Each side has its own clock.
    function dutchQuote(PoolId id)
        external
        view
        returns (uint256 gapWad, uint256 bidWad, uint256 askWad, uint256 bidUsdg, uint256 askUsdg, uint256 feeBps)
    {
        Pool storage p = pools[id];
        if (!p.exists) revert UnknownPool();
        (BridgeCurve.S memory s,,) = _referenced(p);
        uint256 bidGap = _gapAt(p, p.dutchBidAt);
        gapWad = _gapAt(p, p.dutchAskAt);
        (bidWad, askWad, bidUsdg, askUsdg) = engine.preview(s.anchor, BridgeCurve.tvl(s), _gradTvl(p), bidGap, gapWad);
        feeBps = BridgeFee.baseFeeBps(BridgeCurve.tvl(s), _gradTvl(p));
    }

    /// @notice Last raw reference TVL from an anchor update. The smoothed value is what graduation uses.
    function referenceTvl(PoolId id) external view returns (uint256) {
        return pools[id].ethTvl;
    }

    /// @notice Drift fixed at creation, and each side's last reset. A side resets only on its own fill.
    function dutchState(PoolId id) external view returns (uint64 drift, uint64 bidAt, uint64 askAt) {
        Pool storage p = pools[id];
        if (!p.exists) revert UnknownPool();
        return (p.dutchDrift, p.dutchBidAt, p.dutchAskAt);
    }

    /// @notice Principal baseline the USDG floor is measured against, and the live principal.
    function floorState(PoolId id) external view returns (uint256 mark, uint256 principal) {
        Pool storage p = pools[id];
        mark = _markNow(p);
        principal = BridgeCurve.principalY(p.curve);
    }

    /// @notice Smoothed reference TVL. Graduation's target is 12% of this, not of the raw reading.
    function smoothedReference(PoolId id) external view returns (uint256) {
        return pools[id].smoothedTvl;
    }

    /// @notice Stored fee credit. The sum across LPs fits in `feePot`.
    function feeCredit(PoolId id, address user) external view returns (uint256) {
        return feeCreditOf[id][user];
    }

    function bridgeQuote(PoolId id) external view returns (BridgeQuote memory q) {
        Pool storage p = pools[id];
        if (!p.exists) revert UnknownPool();
        (BridgeCurve.S memory s,,) = _referenced(p);
        q.anchorPriceWad = s.anchor;
        q.poolPriceWad = BridgeCurve.spot(s);
        q.graduated = p.graduated;
        q.stale = p.updatedAt == 0 || block.timestamp >= p.updatedAt + C.STALE_AFTER;
        if (s.anchor > 0) q.priceGapBps = _signedBps(q.poolPriceWad, s.anchor);
        uint256 v = BridgeCurve.tvl(s);
        if (v > 0) {
            uint256 coinVal = Math.mulDiv(s.x, s.anchor, C.WAD);
            q.imbalanceBps = coinVal >= s.y
                ? int256(Math.mulDiv(coinVal - s.y, C.BPS, v))
                : -int256(Math.mulDiv(s.y - coinVal, C.BPS, v));
        }
        q.suggestedFeeBps = BridgeFee.baseFeeBps(v, _gradTvl(p));
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
        (BridgeCurve.S memory s,,) = _referenced(p);
        if (s.anchor == 0) revert NoAnchor();
        bool exactCoinIn = zeroForOne == p.coinIs0;
        BridgeCurve.Ctx memory ctx = _ctx(p, s);
        uint8 decIn = exactCoinIn ? p.coinDec : usdgDec;
        uint256 norm = _toNorm(amountIn, decIn);
        uint256 gap = exactCoinIn ? _gapAt(p, p.dutchBidAt) : _gapAt(p, p.dutchAskAt);
        BridgeCurve.Fill memory f;
        (, f) = engine.trade(s, ctx, norm, exactCoinIn, gap);
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

    /// @notice Accrued 1% share for this pool. Claimable by `builder`, not by the pool creator.
    function builderFees(PoolId id) external view returns (uint256) {
        return pools[id].builderAccrued;
    }

    /// @notice Fee credit an LP would have if they still hold through this block's parked fees.
    ///         Shares minted in the current block are excluded. They start earning next block.
    function pendingFee(PoolId id, address user) external view returns (uint256) {
        return _pendingFee(pools[id], id, user);
    }

    function feeIndex(PoolId id) external view returns (uint256) {
        return pools[id].feeIndex;
    }

    /// @notice Normalized USDG this pool may spend. A redeem or swap cannot draw another pool's balance.
    function usdgHeld(PoolId id) external view returns (uint256) {
        return pools[id].usdgHeld;
    }

    /// @notice Best arb against the live anchor and the fee a swap would charge right now.
    ///         `amountIn` / `amountOut` are raw. A returned buy or sell is executable (not capped).
    function arbQuote(PoolId id) external view returns (ArbQuote memory q) {
        Pool storage p = pools[id];
        if (!p.exists) revert UnknownPool();
        (BridgeCurve.S memory s,,) = _referenced(p);
        if (s.anchor == 0) return q;
        BridgeCurve.Ctx memory ctx = _ctx(p, s);
        uint256 bidGap = _gapAt(p, p.dutchBidAt);
        uint256 askGap = _gapAt(p, p.dutchAskAt);
        (bool buyCoin, uint256 normIn,, uint256 profit) = engine.quote(s, ctx, bidGap, askGap);
        q.buyCoin = buyCoin;
        if (normIn == 0 || profit == 0) return q;
        if (buyCoin) {
            q.amountIn = _toRaw(normIn, usdgDec);
            uint256 norm = _toNorm(q.amountIn, usdgDec);
            (uint256 out, uint256 profitRaw) = engine.fill(s, ctx, norm, true, askGap);
            q.amountOut = _toRaw(out, p.coinDec);
            q.profitWad = profitRaw;
        } else {
            q.amountIn = _toRaw(normIn, p.coinDec);
            uint256 norm = _toNorm(q.amountIn, p.coinDec);
            (uint256 out, uint256 profitRaw) = engine.fill(s, ctx, norm, false, bidGap);
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
        Pool storage p = pools[id];
        BridgeCurve.S memory s = p.curve;
        return s.protoX + s.lpX == s.x && s.protoY + s.lpY + s.feePot + s.lockedY == s.y
            && p.usdgHeld >= s.y + p.creatorAccrued + p.builderAccrued + p.tipBudget;
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
