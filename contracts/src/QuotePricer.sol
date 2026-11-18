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
import {UsdgRouteLib} from "./libraries/UsdgRouteLib.sol";
import {PoolDepth} from "./libraries/PoolDepth.sol";

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
///      - Audit 2026-11-14 HK-02: only owner-approved pokers (the keeper) write observations or discover pools.
///        `poke` from anyone else (including Launchpad.launch) is a silent no-op, so a flash pump + poke + dump can
///        no longer plant a tick. Default `maxTickDelta` is 200 ticks (~2%) per recorded observation.
///      - Audit 2026-11-14 LB-01: listed quotes (1- or 2-hop routes) are priced from a TWAP of every route pool
///        (`_routeOracle`, written by the same keeper pokes), not from live spot. Spot stays for display only.
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

    /// @notice If true, every quote is priced live with the $10k-per-side dollar floor (default off).
    bool public allowAnyQuote;
    mapping(address => bool) public isAllowedQuote;
    /// @dev USDG-first v4 route used for live pricing of a listed (or allow-any) quote. 1 or 2 hops.
    mapping(address => PoolKey[]) internal _routeOf;
    /// @notice $10,000 per side, USD WAD. Applied only to listed / allow-any quotes.
    uint256 public constant DEPTH_FLOOR_USD = 10_000e18;

    /// @notice TWAP window, seconds (owner-settable). Default 30 minutes.
    uint32 public twapWindow = 1800;
    /// @notice Max |tick move| recorded per poke. Default 200 ticks ≈ ±2% per observation (HK-02).
    int24 public maxTickDelta = 200;
    mapping(address => TwapOracle.State) internal _oracle;
    /// @notice Addresses allowed to record observations (the keeper). Owner always may (HK-02).
    mapping(address => bool) public isPoker;
    /// @dev Per-pool TWAP for listed routes, native pool orientation (currency1 per currency0) (LB-01).
    mapping(PoolId => TwapOracle.State) internal _routeOracle;

    error NoPricePool(address quote);
    error TwapWarmingUp(uint256 readyAt);
    error BadPool();
    error ThinPool(uint128 liquidity);
    error ZeroPrice();
    error BadParam();
    error NoRouteAboveFloor(address quote);
    error QuoteNotListed(address quote);
    error StalePrice(address quote);

    event PricePoolSet(address indexed quote, bytes32 indexed poolId, uint24 fee, int24 tickSpacing, address hooks);
    event PricePoolCleared(address indexed quote);
    event MinLiquiditySet(uint128 minLiquidity);
    event PricePoolDiscovered(address indexed quote, bytes32 indexed poolId, uint24 fee, int24 tickSpacing, uint128 liquidity);
    event AutoWarmupSet(uint32 warmup);
    event TwapParamsSet(uint32 window, int24 maxTickDelta);
    event Poked(address indexed quote, int24 spotTick, int24 recordedTick);
    event AllowAnyQuoteSet(bool allowed);
    event AllowedQuoteSet(address indexed quote, bool allowed);
    event PriceRouteSet(address indexed quote, PoolKey[] keys);
    event PokerSet(address indexed poker, bool allowed);

    constructor(address owner_, IPoolManager poolManager_, address usdg_) Owned2Step(owner_) {
        poolManager = poolManager_;
        usdg = usdg_;
        uint8 d = IERC20Metadata(usdg_).decimals();
        usdgDecimals = d;
        minLiquidity = uint128(1e4 * 10 ** ((18 + uint256(d)) / 2));
    }

    function setAutoWarmup(uint32 w) external onlyOwner {
        if (w > 7 days || w < twapWindow) revert BadParam(); // F-I7: warm-up at least one TWAP window
        autoWarmup = w;
        emit AutoWarmupSet(w);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    function setTwapParams(uint32 window, int24 maxDelta) external onlyOwner {
        // F-I7: no near-spot windows and no clamp wider than the old 2000-tick default.
        if (window < 300 || window > 7 days || maxDelta <= 0 || maxDelta > 2000) revert BadParam();
        twapWindow = window;
        maxTickDelta = maxDelta;
        emit TwapParamsSet(window, maxDelta);
    }

    function setPoker(address who, bool allowed) external onlyOwner {
        if (who == address(0)) revert BadParam();
        isPoker[who] = allowed;
        emit PokerSet(who, allowed);
    }

    function setMinLiquidity(uint128 l) external onlyOwner {
        if (l == 0) revert BadParam(); // F-I7
        minLiquidity = l;
        emit MinLiquiditySet(l);
    }

    function setAllowAnyQuote(bool allowed) external onlyOwner {
        allowAnyQuote = allowed;
        emit AllowAnyQuoteSet(allowed);
    }

    function setAllowedQuote(address quote, bool allowed) external onlyOwner {
        if (quote == address(0) || quote == usdg) revert BadParam();
        isAllowedQuote[quote] = allowed;
        emit AllowedQuoteSet(quote, allowed);
    }

    /// @notice Register the USDG-first v4 route used to price `quote` (1 or 2 hops). Owner only.
    function setPriceRoute(address quote, PoolKey[] calldata keys) external onlyOwner {
        if (!UsdgRouteLib.check(poolManager, usdg, quote, keys, address(0))) revert BadPool();
        delete _routeOf[quote];
        for (uint256 i; i < keys.length; ++i) {
            _routeOf[quote].push(keys[i]);
            (, int24 tick,,) = poolManager.getSlot0(keys[i].toId());
            // LB-01: route TWAP starts at owner-time spot. Audit L-19: never wipe a populated (possibly shared) oracle.
            if (!TwapOracle.isInitialized(_routeOracle[keys[i].toId()])) TwapOracle.initialize(_routeOracle[keys[i].toId()], tick);
        }
        emit PriceRouteSet(quote, keys);
        if (keys.length == 1) {
            _poolOf[quote] = keys[0];
            hasPricePool[quote] = true;
            isAutoPool[quote] = false;
            TwapOracle.initialize(_oracle[quote], _usdTick(quote, keys[0]));
            emit PricePoolSet(quote, PoolId.unwrap(keys[0].toId()), keys[0].fee, keys[0].tickSpacing, address(keys[0].hooks));
        }
    }

    function priceRouteOf(address quote) external view returns (PoolKey[] memory) {
        return _routeOf[quote];
    }

    function _listed(address quote) internal view returns (bool) {
        return isAllowedQuote[quote] || allowAnyQuote;
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
        delete _routeOf[quote];
        _routeOf[quote].push(key);
        // (Re)start the oracles at the owner-registration spot (the route oracle prices it once listed, LB-01).
        TwapOracle.initialize(_oracle[quote], _usdTick(quote, key));
        (, int24 rawTick,,) = poolManager.getSlot0(key.toId());
        if (!TwapOracle.isInitialized(_routeOracle[key.toId()])) TwapOracle.initialize(_routeOracle[key.toId()], rawTick);
        emit PricePoolSet(quote, PoolId.unwrap(key.toId()), key.fee, key.tickSpacing, address(key.hooks));
    }

    function clearPricePool(address quote) external onlyOwner {
        delete _poolOf[quote];
        hasPricePool[quote] = false;
        isAutoPool[quote] = false;
        delete _routeOf[quote];
        // F-L9: clearing also unlists, so a listed quote can't fall back to permissionless discovery.
        if (isAllowedQuote[quote]) {
            isAllowedQuote[quote] = false;
            emit AllowedQuoteSet(quote, false);
        }
        emit PricePoolCleared(quote);
    }

    /// @notice Keeper only (HK-02): record a (lagged, truncated) observation for `quote` and for every pool on its
    ///         listed route. If `quote` has no pool yet, discover and auto-register the deepest standard
    ///         (quote, USDG) v4 pool meeting minLiquidity. A call from anyone else is a no-op (never reverts, so
    ///         Launchpad.launch's try-poke keeps working).
    function poke(address quote) public {
        if (quote == usdg) return;
        if (!isPoker[msg.sender] && msg.sender != owner) return;
        uint256 n = _routeOf[quote].length;
        for (uint256 i; i < n; ++i) {
            PoolKey memory k = _routeOf[quote][i];
            (, int24 tick,,) = poolManager.getSlot0(k.toId());
            TwapOracle.write(_routeOracle[k.toId()], tick, maxTickDelta, true);
        }
        // 2-hop listed routes are priced from the route oracles; do not auto-register a direct USDG pool over them.
        if (n > 1) return;
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
        PoolKey[] memory keys;
        (ok, keys) = _routeFor(quote);
        if (ok) key = keys[0];
    }

    /// @notice Full USDG-first route for `quote`: owner-registered route, else the registered/discovered USDG pool.
    function routeFor(address quote) external view returns (bool ok, PoolKey[] memory keys) {
        return _routeFor(quote);
    }

    function _routeFor(address quote) internal view returns (bool ok, PoolKey[] memory keys) {
        uint256 n = _routeOf[quote].length;
        if (n > 0) {
            keys = _routeOf[quote];
            return (true, keys);
        }
        if (hasPricePool[quote]) {
            keys = new PoolKey[](1);
            keys[0] = _poolOf[quote];
            return (true, keys);
        }
        (bool found, PoolKey memory k, uint128 liq) = BasePools.discover(poolManager, quote, usdg);
        if (!found || liq == 0 || liq < minLiquidity) return (false, keys);
        keys = new PoolKey[](1);
        keys[0] = k;
        return (true, keys);
    }

    /// @inheritdoc IQuotePricer
    /// @dev TWAP (manipulation-resistant). Used for curve USD targets at launch and live mcap.
    ///      Listed quotes with an owner route use the per-pool route TWAPs (LB-01); a listed quote without one
    ///      (allow-any) falls through to the registered-pool TWAP below and needs a registered pool.
    function quotePriceUsd(address quote) external view override returns (uint256 p) {
        uint256 usdgScale = 10 ** (36 - uint256(usdgDecimals));
        if (quote == usdg) return usdgScale;
        if (_listed(quote)) {
            if (_routeOf[quote].length > 0) return _twapRoutePrice(_routeOf[quote], usdgScale, quote);
            if (!hasPricePool[quote]) revert NoRouteAboveFloor(quote);
        }
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

    /// @notice Launch-time price: like `quotePriceUsd`, but only USDG and listed quotes (`isAllowedQuote`, ignoring
    ///         `allowAnyQuote`) can be launch quotes (maker 2026-11-14, external review F-M1).
    ///         Fail-closed freshness (audit 2026-11-17 M-02 / R461-03 / L-19 / L-20): every route pool's TWAP must
    ///         cover a full `twapWindow` (no launches off a just-registered route), its newest keeper observation
    ///         must be under 2 × twapWindow old (a stopped keeper stops launches instead of baking a stale price),
    ///         and no two consecutive observations across the window may be more than twapWindow / 2 apart.
    ///         No spot check: USDG launches buy the pair coin in the same tx, which moves spot on purpose.
    function launchPriceUsd(address quote) external view returns (uint256) {
        if (quote != usdg) {
            if (!isAllowedQuote[quote]) revert QuoteNotListed(quote);
            uint256 n = _routeOf[quote].length;
            for (uint256 i; i < n; ++i) {
                _checkFresh(_routeOracle[_routeOf[quote][i].toId()], quote);
            }
            if (n == 0 && hasPricePool[quote]) _checkFresh(_oracle[quote], quote);
        }
        return this.quotePriceUsd(quote);
    }

    function _checkFresh(TwapOracle.State storage o, address quote) internal view {
        if (!TwapOracle.isInitialized(o)) revert NoPricePool(quote);
        uint32 w = twapWindow;
        TwapOracle.Observation memory l = TwapOracle.last(o);
        (, uint32 covered) = TwapOracle.consult(o, w, l.tick);
        if (covered < w || block.timestamp - l.ts > 2 * uint256(w)) revert StalePrice(quote);
        // Audit 2026-11-18 E-L1: no gap over half a window between keeper observations across the whole window,
        // so one poke after a long pause can't pass a stale tick off as a full window.
        if (TwapOracle.maxGapSince(o, uint32(block.timestamp) - w) > w / 2) revert StalePrice(quote);
    }

    /// @notice Spot price (display only; flash-manipulable — never use for safety checks).
    function spotPriceUsd(address quote) external view returns (uint256 p) {
        // USD WAD per 1e18 raw units: usdg raw unit = 10^-dec USD → 1e18 raw = 1e(36-dec) USD WAD
        uint256 usdgScale = 10 ** (36 - uint256(usdgDecimals));
        if (quote == usdg) return usdgScale;
        if (_listed(quote)) {
            (bool ok, PoolKey[] memory keys) = _routeFor(quote);
            if (!ok) revert NoRouteAboveFloor(quote);
            return _liveRoutePrice(keys, usdgScale, quote);
        }
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

    /// @dev TWAP along a USDG-first 1- or 2-hop route (LB-01), with the $10k-per-side floor on every pool valued
    ///      at the TWAP prices.
    function _twapRoutePrice(PoolKey[] memory keys, uint256 usdgScale, address quote) internal view returns (uint256 p) {
        uint256 midUsd = usdgScale;
        if (keys.length == 2) {
            address mid = UsdgRouteLib.other(keys[0], usdg);
            midUsd = _priceAtSqrt(keys[0], mid, usdg, usdgScale, _routeTwapSqrt(keys[0], quote));
            _assertFloor(keys[0], usdg, usdgScale, midUsd, quote);
            p = _priceAtSqrt(keys[1], quote, mid, midUsd, _routeTwapSqrt(keys[1], quote));
            _assertFloor(keys[1], mid, midUsd, p, quote);
        } else {
            p = _priceAtSqrt(keys[0], quote, usdg, usdgScale, _routeTwapSqrt(keys[0], quote));
            _assertFloor(keys[0], usdg, usdgScale, p, quote);
        }
        if (p == 0) revert ZeroPrice();
    }

    /// @dev sqrt price at the route pool's TWAP tick (native orientation). The tail since the last keeper write is
    ///      the last recorded tick (lagged), so a same-block move has no weight.
    function _routeTwapSqrt(PoolKey memory key, address quote) internal view returns (uint160) {
        TwapOracle.State storage o = _routeOracle[key.toId()];
        if (!TwapOracle.isInitialized(o)) revert NoPricePool(quote);
        (int24 t,) = TwapOracle.consult(o, twapWindow, TwapOracle.last(o).tick);
        return TickMath.getSqrtPriceAtTick(t);
    }

    /// @notice Route-pool TWAP tick (native orientation) and the seconds covered. For keepers / monitoring.
    function routeTwapTick(PoolKey calldata key) external view returns (int24 tick, uint32 actualWindow) {
        TwapOracle.State storage o = _routeOracle[key.toId()];
        if (!TwapOracle.isInitialized(o)) revert BadPool();
        return TwapOracle.consult(o, twapWindow, TwapOracle.last(o).tick);
    }

    /// @dev Live spot along a USDG-first 1- or 2-hop route, with a $10k-per-side floor on every pool (display).
    function _liveRoutePrice(PoolKey[] memory keys, uint256 usdgScale, address quote) internal view returns (uint256 p) {
        uint256 midUsd = usdgScale;
        if (keys.length == 2) {
            address mid = UsdgRouteLib.other(keys[0], usdg);
            midUsd = _priceInPool(keys[0], mid, usdg, usdgScale);
            _assertFloor(keys[0], usdg, usdgScale, midUsd, quote);
            p = _priceInPool(keys[1], quote, mid, midUsd);
            _assertFloor(keys[1], mid, midUsd, p, quote);
        } else {
            p = _priceInPool(keys[0], quote, usdg, usdgScale);
            _assertFloor(keys[0], usdg, usdgScale, p, quote);
        }
        if (p == 0) revert ZeroPrice();
    }

    /// @dev USD WAD per 1e18 raw of `token`, given the other currency's USD WAD per 1e18 raw.
    function _priceInPool(PoolKey memory key, address token, address other, uint256 otherUsd)
        internal
        view
        returns (uint256)
    {
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        if (sqrtP == 0) revert BadPool();
        return _priceAtSqrt(key, token, other, otherUsd, sqrtP);
    }

    function _priceAtSqrt(PoolKey memory key, address token, address other, uint256 otherUsd, uint160 sqrtP)
        internal
        pure
        returns (uint256)
    {
        uint256 priceX128 = Math.mulDiv(sqrtP, sqrtP, 1 << 64);
        if (Currency.unwrap(key.currency0) == token) {
            // other raw per token raw
            if (Currency.unwrap(key.currency1) != other) revert BadPool();
            return Math.mulDiv(otherUsd, priceX128, 1 << 128);
        }
        if (Currency.unwrap(key.currency1) != token || Currency.unwrap(key.currency0) != other) revert BadPool();
        return Math.mulDiv(otherUsd, 1 << 128, priceX128);
    }

    function _assertFloor(
        PoolKey memory key,
        address a,
        uint256 aUsd,
        uint256 bUsd,
        address quote
    ) internal view {
        (uint256 r0, uint256 r1) = PoolDepth.virtualReserves(poolManager, key);
        address c0 = Currency.unwrap(key.currency0);
        uint256 d0 = PoolDepth.sideUsd(r0, c0 == a ? aUsd : bUsd);
        uint256 d1 = PoolDepth.sideUsd(r1, c0 == a ? bUsd : aUsd);
        if (d0 < DEPTH_FLOOR_USD || d1 < DEPTH_FLOOR_USD) revert NoRouteAboveFloor(quote);
    }
}
