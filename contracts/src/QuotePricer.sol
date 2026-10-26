// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Owned2Step} from "./utils/Owned2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IQuotePricer} from "./interfaces/IQuotePricer.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {TwapOracle} from "./libraries/TwapOracle.sol";
import {BasePools} from "./libraries/BasePools.sol";

/// @title Quote/USD oracle (USDG = $1, others via a TRUNCATED TWAP of a registered quote/USDG v4 pool)
/// @notice Curve mcap targets ($7,777 / $33,333) are USD. At launch the Launchpad asks this contract for the
///         quote's USD price exactly once and bakes it into the curve geometry (immutable thereafter).
/// @dev Trust assumptions (documented in README):
///      - USDG is treated as exactly $1 (no depeg handling).
///      - Non-USDG quotes are priced from a time-weighted mean tick (SEC-03 fix) of an owner-registered
///        quote/USDG v4 pool. Observations are written by the permissionless `poke(quote)` (also called by
///        Launchpad.launch) in LAGGED mode: a poke records the current spot only for the FUTURE, clamped to
///        ±maxTickDelta of the previous observation, so a flash move + poke + read in one tx has zero effect and a
///        move must be held across blocks (and keepers' pokes) to shift the TWAP. Spot is available separately
///        via `spotPriceUsd` for display. `minLiquidity` still applies to the reference pool.
///      - Permissionless base discovery: `poke(base)` (also called by every launch) auto-registers the deepest
///        hookless (base, USDG) v4 pool at the standard tiers (BasePools) if its liquidity >= minLiquidity. An
///        auto-discovered pool prices only after `autoWarmup` seconds of TWAP history (its first observation is the
///        discovery-time spot, which a flash move could skew; truncated keeper/launch pokes wash that out).
///      - Owner registration (`setPricePool`) stays as an override and is never replaced by discovery.
contract QuotePricer is IQuotePricer, Owned2Step {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager public immutable poolManager;
    address public immutable usdg;
    uint8 public immutable usdgDecimals;
    /// @notice Minimum in-range liquidity of a reference pool (discovery + every pricing). Default set in the
    ///         constructor: 1e4 · 10^((18 + usdgDecimals) / 2), i.e. the in-range L of a full-range pool holding
    ///         ~$10k per side for an 18-decimal base priced ~$1 (L scales with 1/sqrt(price)). Owner-settable.
    uint128 public minLiquidity;
    /// @notice TWAP history an AUTO-discovered pool needs before it can price (seconds). Default 1 h (2× window).
    uint32 public autoWarmup = 3600;
    /// @notice true if the registered pool came from permissionless discovery (not the owner).
    mapping(address => bool) public isAutoPool;
    /// @notice When the auto pool was discovered (its oracle start).
    mapping(address => uint40) public autoSince;

    mapping(address => PoolKey) internal _poolOf;
    mapping(address => bool) public hasPricePool;

    /// @notice TWAP window, seconds (owner-settable). Default 30 minutes.
    uint32 public twapWindow = 1800;
    /// @notice Max |tick move| recorded per poke. Default 2000 ticks ≈ ±22% per observation.
    int24 public maxTickDelta = 2000;
    mapping(address => TwapOracle.State) internal _oracle;

    error NoPricePool(address quote);
    error TwapWarmingUp(uint256 readyAt);
    error BadPool();
    error ThinPool(uint128 liquidity);
    error ZeroPrice();
    error BadParam();

    event PricePoolSet(address indexed quote, bytes32 indexed poolId, uint24 fee, int24 tickSpacing, address hooks);
    event PricePoolCleared(address indexed quote);
    event MinLiquiditySet(uint128 minLiquidity);
    event PricePoolDiscovered(address indexed quote, bytes32 indexed poolId, uint24 fee, int24 tickSpacing, uint128 liquidity);
    event AutoWarmupSet(uint32 warmup);
    event TwapParamsSet(uint32 window, int24 maxTickDelta);
    event Poked(address indexed quote, int24 spotTick, int24 recordedTick);

    constructor(address owner_, IPoolManager poolManager_, address usdg_) Owned2Step(owner_) {
        poolManager = poolManager_;
        usdg = usdg_;
        uint8 d = IERC20Metadata(usdg_).decimals();
        usdgDecimals = d;
        minLiquidity = uint128(1e4 * 10 ** ((18 + uint256(d)) / 2));
    }

    function setAutoWarmup(uint32 w) external onlyOwner {
        if (w > 7 days) revert BadParam();
        autoWarmup = w;
        emit AutoWarmupSet(w);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    function setTwapParams(uint32 window, int24 maxDelta) external onlyOwner {
        if (window == 0 || window > 7 days || maxDelta <= 0) revert BadParam();
        twapWindow = window;
        maxTickDelta = maxDelta;
        emit TwapParamsSet(window, maxDelta);
    }

    function setMinLiquidity(uint128 l) external onlyOwner {
        minLiquidity = l;
        emit MinLiquiditySet(l);
    }

    /// @notice Register the canonical quote/USDG v4 pool for `quote`. Pool must exist (initialized).
    function setPricePool(address quote, PoolKey calldata key) external onlyOwner {
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        if (quote == usdg || !((c0 == quote && c1 == usdg) || (c0 == usdg && c1 == quote))) revert BadPool();
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        if (sqrtP == 0) revert BadPool();
        _poolOf[quote] = key;
        hasPricePool[quote] = true;
        isAutoPool[quote] = false;
        // (Re)start the oracle at the owner-registration spot.
        TwapOracle.initialize(_oracle[quote], _usdTick(quote, key));
        emit PricePoolSet(quote, PoolId.unwrap(key.toId()), key.fee, key.tickSpacing, address(key.hooks));
    }

    function clearPricePool(address quote) external onlyOwner {
        delete _poolOf[quote];
        hasPricePool[quote] = false;
        isAutoPool[quote] = false;
        emit PricePoolCleared(quote);
    }

    /// @notice Permissionless: record a (lagged, truncated) observation for `quote`. If `quote` has no pool yet,
    ///         discover and auto-register the deepest standard (quote, USDG) v4 pool meeting minLiquidity.
    function poke(address quote) public {
        if (quote == usdg) return;
        // Discover if unset, or re-discover if the AUTO pool fell below the floor (e.g. a thin/narrow-range pool
        // that was arbitraged out of range). Owner-registered pools are never replaced.
        if (!hasPricePool[quote] || (isAutoPool[quote] && poolManager.getLiquidity(_poolOf[quote].toId()) < minLiquidity)) {
            (bool found, PoolKey memory k, uint128 liq) = BasePools.discover(poolManager, quote, usdg);
            if (!found || liq == 0 || liq < minLiquidity) return;
            _poolOf[quote] = k;
            hasPricePool[quote] = true;
            isAutoPool[quote] = true;
            autoSince[quote] = uint40(block.timestamp);
            TwapOracle.initialize(_oracle[quote], _usdTick(quote, k));
            emit PricePoolDiscovered(quote, PoolId.unwrap(k.toId()), k.fee, k.tickSpacing, liq);
            return;
        }
        int24 spot = _usdTick(quote, _poolOf[quote]);
        TwapOracle.State storage o = _oracle[quote];
        if (TwapOracle.write(o, spot, maxTickDelta, true)) emit Poked(quote, spot, TwapOracle.last(o).tick);
    }

    /// @dev Reference pool tick in "USDG per quote" orientation.
    function _usdTick(address quote, PoolKey memory key) internal view returns (int24) {
        (, int24 tick,,) = poolManager.getSlot0(key.toId());
        return Currency.unwrap(key.currency0) == quote ? tick : -tick;
    }

    /// @notice TWAP tick (USDG raw per quote raw) and the seconds covered.
    function twapTick(address quote) public view returns (int24 tick, uint32 actualWindow) {
        if (!hasPricePool[quote]) revert NoPricePool(quote);
        TwapOracle.State storage o = _oracle[quote];
        return TwapOracle.consult(o, twapWindow, TwapOracle.last(o).tick);
    }

    function pricePoolOf(address quote) external view returns (PoolKey memory) {
        return _poolOf[quote];
    }

    /// @notice The pool `quote` is (or would be) priced from: the registered pool, else the deepest standard
    ///         (quote, USDG) v4 pool meeting minLiquidity. Used by QuoteProbe for the round-trip probe.
    function poolKeyFor(address quote) external view returns (bool ok, PoolKey memory key) {
        if (hasPricePool[quote]) return (true, _poolOf[quote]);
        uint128 liq;
        (ok, key, liq) = BasePools.discover(poolManager, quote, usdg);
        ok = ok && liq != 0 && liq >= minLiquidity;
    }

    /// @inheritdoc IQuotePricer
    /// @dev TWAP (manipulation-resistant). Used for curve USD targets at launch and live mcap.
    function quotePriceUsd(address quote) external view override returns (uint256 p) {
        uint256 usdgScale = 10 ** (36 - uint256(usdgDecimals));
        if (quote == usdg) return usdgScale;
        if (!hasPricePool[quote]) revert NoPricePool(quote);
        uint128 liq = poolManager.getLiquidity(_poolOf[quote].toId());
        if (liq < minLiquidity || liq == 0) revert ThinPool(liq);
        if (isAutoPool[quote]) {
            uint256 readyAt = uint256(autoSince[quote]) + autoWarmup;
            if (block.timestamp < readyAt) revert TwapWarmingUp(readyAt);
        }
        (int24 t,) = twapTick(quote);
        // usdg raw per quote raw at tick t, scaled to USD WAD per 1e18 quote raw
        // Tick-quantized TWAP (≤1 bp). If the TWAP is within ±1 tick of spot, use the exact spot sqrt price:
        // that differs from the TWAP by ≤ 2 bp, so precision improves without reopening manipulation.
        (uint160 spotSqrt, int24 spotTick,,) = poolManager.getSlot0(_poolOf[quote].toId());
        bool q0 = Currency.unwrap(_poolOf[quote].currency0) == quote;
        int256 diff = int256(q0 ? spotTick : -spotTick) - int256(t);
        uint160 sp = (diff >= -1 && diff <= 1) ? spotSqrt : TickMath.getSqrtPriceAtTick(q0 ? t : -t);
        uint256 priceX128 = Math.mulDiv(sp, sp, 1 << 64); // c1 per c0
        p = q0 ? Math.mulDiv(priceX128, usdgScale, 1 << 128) : Math.mulDiv(1 << 128, usdgScale, priceX128);
        if (p == 0) revert ZeroPrice();
    }

    /// @notice Spot price (display only; flash-manipulable — never use for safety checks).
    function spotPriceUsd(address quote) external view returns (uint256 p) {
        // USD WAD per 1e18 raw units: usdg raw unit = 10^-dec USD → 1e18 raw = 1e(36-dec) USD WAD
        uint256 usdgScale = 10 ** (36 - uint256(usdgDecimals));
        if (quote == usdg) return usdgScale;
        if (!hasPricePool[quote]) revert NoPricePool(quote);

        PoolKey memory key = _poolOf[quote];
        PoolId id = key.toId();
        (uint160 sqrtP,,,) = poolManager.getSlot0(id);
        if (sqrtP == 0) revert BadPool();
        uint128 liq = poolManager.getLiquidity(id);
        if (liq < minLiquidity || liq == 0) revert ThinPool(liq);

        // priceX128 = currency1 raw per currency0 raw, X128
        uint256 priceX128 = Math.mulDiv(sqrtP, sqrtP, 1 << 64);
        if (Currency.unwrap(key.currency0) == quote) {
            // usdg raw per quote raw = priceX128 / 2^128
            p = Math.mulDiv(priceX128, usdgScale, 1 << 128);
        } else {
            // usdg raw per quote raw = 2^128 / priceX128
            p = Math.mulDiv(1 << 128, usdgScale, priceX128);
        }
        if (p == 0) revert ZeroPrice();
    }
}
