// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {BridgeConstants as C} from "./libraries/BridgeConstants.sol";
import {BridgeCurve} from "./libraries/BridgeCurve.sol";
import {IUniswapV3FactoryView, IUniswapV3Slot0} from "./libraries/BridgeV3Anchor.sol";
import {DiscipleEngine} from "./DiscipleEngine.sol";
import {DiscipleFacetBase} from "./DiscipleFacetBase.sol";

/// @title Disciple create facet
/// @notice `createPool` for Disciple (`DiscipleHook`). Split from the LP facet so both stay under
///         the 24kb limit. Runs as the hook via `delegatecall`. The seed unlock still settles on
///         the LP facet.
contract DiscipleCreateFacet is DiscipleFacetBase {
    using PoolIdLibrary for PoolKey;

    constructor(
        IPoolManager manager_,
        address usdg_,
        address lz_,
        uint8 usdgDecimals_,
        DiscipleEngine engine_,
        address v3Factory_
    ) DiscipleFacetBase(manager_, usdg_, lz_, usdgDecimals_, engine_, v3Factory_) {}

    function createPool(CreateParams calldata c) external returns (PoolKey memory key, PoolId id) {
        _onlyDelegate();
        if (_locked) revert Reentrancy();
        _locked = true;

        if (c.coin == address(0) || c.coin == usdg || c.coin.code.length == 0) revert BadCreate();
        if (c.creator == address(0)) revert BadCreate();
        if (!engine.anchorOk(c.anchorKind, c.remoteOracle, c.v3Pool, c.refPoolId, c.refHook, c.tipSeed, c.remoteEid)) {
            revert BadCreate();
        }
        if (!_sameChain(c.anchorKind) && lz == address(0)) revert BadCreate();
        if (c.floorBps != C.FLOOR_BPS) revert BadCreate();
        if (c.discountBps < 1_000 || c.discountBps > 5_000) revert BadCreate();
        if (c.coinSeed == 0) revert BadCreate();
        uint16 capBps = c.outflowCapBps;
        uint32 window = c.outflowWindow;
        if (capBps == 0 && window == 0) {
            capBps = C.OUTFLOW_CAP_DEFAULT_BPS;
            window = C.OUTFLOW_PER_HOUR;
        } else {
            if (window != C.OUTFLOW_PER_BLOCK && window != C.OUTFLOW_PER_HOUR) revert BadCreate();
            if (capBps == 0 || capBps > C.BPS) revert BadCreate();
        }
        _checkRef(c);
        uint64 drift = engine.normalizeDrift(c.dutchDrift);
        if (drift == 0) revert BadCreate();

        uint8 coinDec = IERC20Metadata(c.coin).decimals();
        if (coinDec > 18) revert BadCreate();

        uint256 coinGot = _pull(c.coin, msg.sender, c.coinSeed);
        uint256 tipGot = c.tipSeed == 0 ? 0 : _pull(usdg, msg.sender, c.tipSeed);
        uint256 coinNorm = _toNorm(coinGot, coinDec);
        uint256 tipNorm = _toNorm(tipGot, usdgDec);
        if (coinNorm == 0) revert Dust();

        bool coinIs0 = c.coin < usdg;
        int24 spacing = c.tickSpacing == 0 ? C.TICK_SPACING : c.tickSpacing;
        if (spacing <= 0 || spacing > TickMath.MAX_TICK_SPACING) revert BadCreate();
        key = PoolKey({
            currency0: Currency.wrap(coinIs0 ? c.coin : usdg),
            currency1: Currency.wrap(coinIs0 ? usdg : c.coin),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: spacing,
            hooks: IHooks(address(this))
        });
        id = key.toId();
        if (pools[id].exists) revert BadCreate();

        Pool storage p = pools[id];
        p.exists = true;
        p.coinIs0 = coinIs0;
        p.coinDec = coinDec;
        p.coin = c.coin;
        p.creator = c.creator;
        p.floorBps = c.floorBps;
        p.outflowCapBps = capBps;
        p.outflowWindow = window;
        p.remoteEid = c.remoteEid;
        p.remoteOracle = c.remoteOracle;
        p.anchorKind = c.anchorKind;
        p.v3Pool = c.v3Pool;
        p.tipBudget = tipNorm;
        p.dutchDrift = drift;
        uint64 opened = block.timestamp == 0 ? 1 : uint64(block.timestamp);
        p.dutchBidAt = opened;
        p.dutchAskAt = opened;
        p.refPoolId = c.refPoolId;
        p.refHook = c.refHook;
        p.refCoinIs0 = c.anchorKind == C.ANCHOR_V4_SAMPLE ? coinIs0 : c.refCoinIs0;
        p.key = key;
        // `init` takes memory. Assigning the copy is what actually stores the seed.
        BridgeCurve.S memory seeded;
        BridgeCurve.init(seeded, coinNorm, uint256(c.discountBps) * 1e14); // bps → WAD (3300 bps = 0.33e18)
        p.curve = seeded;
        if (_sameChain(c.anchorKind)) {
            // v3 `observe` reverts when the pair is wrong or the pool has no 30-minute history.
            // A v4 self-sample that is not warm yet leaves the anchor at 0. Swaps revert until it is.
            _persistReference(p);
            _touchGrad(id, p);
        }

        // Self-call: v4 skips beforeInitialize when the hook is msg.sender. Anyone else hits the revert below.
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(0));
        poolManager.unlock(abi.encode(OP_SEED, PoolId.unwrap(id), coinGot, tipGot));

        if (tipNorm > 0) _creditPoolUsdg(p, tipNorm);
        emit PoolCreated(id, c.coin, c.creator, c.floorBps, c.discountBps, coinNorm, c.anchorKind);
        _locked = false;
    }

    /// @dev The reference has to be the pool it claims to be. A squatter's fake v3 pool, a wrong
    ///      pair, or a hook the builder has not allowed cannot be attached.
    function _checkRef(CreateParams calldata c) internal view {
        uint8 k = c.anchorKind;
        if (k == C.ANCHOR_V3) {
            if (v3Factory == address(0) || c.v3Fee == 0) revert BadCreate();
            address canonical = IUniswapV3FactoryView(v3Factory).getPool(c.coin, usdg, c.v3Fee);
            if (canonical == address(0) || canonical != c.v3Pool) revert BadCreate();
            (,,, uint16 card,,,) = IUniswapV3Slot0(c.v3Pool).slot0();
            if (card < C.MIN_V3_CARDINALITY) revert BadCreate();
        }
        if (k == C.ANCHOR_V4_SAMPLE) {
            if (c.refTickSpacing <= 0 || c.refTickSpacing > TickMath.MAX_TICK_SPACING) revert BadCreate();
            bool ref0 = c.coin < usdg;
            PoolKey memory refKey = PoolKey({
                currency0: Currency.wrap(ref0 ? c.coin : usdg),
                currency1: Currency.wrap(ref0 ? usdg : c.coin),
                fee: c.refFee,
                tickSpacing: c.refTickSpacing,
                hooks: IHooks(c.refHooks)
            });
            if (PoolId.unwrap(refKey.toId()) != c.refPoolId) revert BadCreate();
        }
        if (k == C.ANCHOR_V4_ORACLE || k == C.ANCHOR_LZ_V4_ORACLE || k == C.ANCHOR_LZ_V4_SLOT) {
            if (!allowedOracle[c.refHook]) revert BadCreate();
        }
        if (k == C.ANCHOR_LZ || k == C.ANCHOR_LZ_V4_ORACLE || k == C.ANCHOR_LZ_V4_SLOT) {
            if (!allowedLens[c.remoteOracle]) revert BadCreate();
        }
    }
}
