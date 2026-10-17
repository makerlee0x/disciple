// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";
import {Constants} from "./libraries/Constants.sol";
import {IHookTradeEvents} from "./interfaces/ITradeEvents.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IQuotePricer} from "./interfaces/IQuotePricer.sol";
import {IAltitudeEvents} from "./interfaces/IAltitudeEvents.sol";
import {Altitude} from "./libraries/Altitude.sol";
import {McapMath} from "./libraries/McapMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

interface IMigrationLockedLP {
    function lockedLP() external view returns (address);
}

/// @dev LockedLP's in-swap compound entry (adds the LP-share buckets to the locked position).
interface ILPCompounder {
    function compoundFromHook(address token, uint160 refSwap, uint160 refBlock, uint160 refEma)
        external
        returns (uint128);
}

/// @title Post-grad 1% trade-fee hook (§3 / LOCKED #11)
/// @notice Pool LP fee is 0; this hook takes 1% of swap output and routes via FeeRouter (33/33/33/1).
/// @dev Must be mined to an address with
///      BEFORE_INITIALIZE_FLAG | BEFORE_ADD_LIQUIDITY_FLAG | BEFORE_SWAP_FLAG | AFTER_SWAP_FLAG |
///      AFTER_SWAP_RETURNS_DELTA_FLAG.
///      beforeInitialize (audit #2): only LockedLP (via Migration at graduation) may initialize a pool on this
///      hook, so nobody can pre-initialize a DISCIPLE pool at a bad price.
///      beforeSwap snapshots sqrtPrice (transient) for the Trade event. afterSwap emits Trade, then
///      AltitudeUpdate (SPOT mcap after the trade) and TierBreak when the spot tier changes.
///      beforeAddLiquidity (SEC-02): only allowlisted liquidity managers (LockedLP, TrampWallManager) may add,
///      so nobody can JIT raw v4 positions around a swap. TrampWallManager positions are strictly single-sided
///      one-tick-spacing bands placed out of range; there is no minimum hold period.
contract DiscipleHook is IHooks, IHookTradeEvents, IAltitudeEvents {
    using PoolIdLibrary for PoolKey;
    using SafeCast for uint256;
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;

    IPoolManager public immutable poolManager;
    IFeeRouter public immutable feeRouter;

    struct PoolMeta {
        address token;
        address quote;
        address creator;
        bool registered;
        uint256 quotePriceUsd; // launch-time USD WAD per 1e18 raw quote (altitude/tier mcap; quoteUsdOf fallback)
    }

    /// @notice Allowlisted routers (only DiscipleRouter in production; UniversalRouter must NOT be trusted, SEC-05). When the swap `sender` is
    ///         trusted and hookData is exactly abi.encode(address trader), that trader is credited (Trade event +
    ///         referral). Otherwise the `sender` itself is the trader (no referral unless sender is referred).
    mapping(address => bool) public isTrustedRouter;
    address public admin;

    event TrustedRouterSet(address indexed router, bool trusted);
    event AdminTransferred(address indexed admin);

    /// @dev transient slot for pre-swap sqrtPriceX96
    bytes32 private constant PRICE_SLOT = keccak256("disciple.hook.sqrtPriceBefore");
    /// @dev transient per-pool "swapped in this tx" flag namespace (LockedLP.flush sandwich guard)
    bytes32 private constant SWAPPED_SLOT = keccak256("disciple.hook.swappedInTx");
    /// @dev Transient: 1 if the pool of the CURRENT swap had already been swapped earlier in this tx.
    bytes32 private constant REPEAT_SLOT = keccak256("disciple.hook.repeatSwapInTx");

    /// @notice LockedLP compounder called after fee routing (address(0) = compounding off).
    ILPCompounder public compounder;
    /// @notice Gas forwarded to the compound call; the call is skipped unless gasleft() covers this + reserve.
    uint32 public compoundGasLimit = 250_000;
    uint32 internal constant COMPOUND_GAS_RESERVE = 80_000;

    event CompounderSet(address indexed compounder, uint32 gasLimit);
    /// @notice The compound attempt reverted (swap unaffected; buckets carry forward).
    event CompoundFailed(address indexed token);

    mapping(PoolId => PoolMeta) public metaOf;

    address public migration;

    error OnlyPoolManager();
    error OnlyMigration();
    error HookNotImplemented();
    error NotRegistered();
    error OnlyAdmin();
    error OnlyLiquidityManager();
    error OnlyLockedLP();

    // ── SEC-02 LP gate / altitude ───────────────────────────────────────────
    /// @notice Contracts allowed to add liquidity to DISCIPLE pools (LockedLP, TrampWallManager).
    mapping(address => bool) public isLiquidityManager;
    /// @dev One packed slot per pool (DISCIPLE audit High-1 follow-up), written once per pool per block:
    ///      - tier: last altitude tier
    ///      - anchorBlock / anchorTick: BLOCK-START tick (pre-swap tick of the first swap in `anchorBlock`)
    ///      - emaTickX256 / emaTime: time-weighted EMA of block-start ticks (x256 fixed point), window REF_WINDOW.
    ///        Each first-swap-of-a-block folds the price that has held since the last update into the EMA,
    ///        weighted by the elapsed seconds, so a price pushed at the end of block N carries ~(blockTime / 60 s)
    ///        weight in block N+1 — a one-block-boundary pump cannot move the reference.
    ///      - refSince: when the EMA started (registerPool); compounding needs >= REF_MIN_AGE of history.
    ///      - obs: number of EMA observations (the registration seed + one per distinct block), saturating at 255.
    ///      Audit round 3 (HIGH-1 residual): the EMA never snaps. Each observation's weight is at most 50%
    ///      (dt is capped at REF_WINDOW / 2) and its move at most MAX_EMA_STEP_TICKS, so a pump held through a
    ///      quiet period needs many distinct-block observations to drag the reference.
    struct PoolTrack {
        uint8 tier;
        uint40 anchorBlock;
        int24 anchorTick;
        int32 emaTickX256;
        uint40 emaTime;
        uint40 refSince;
        uint8 obs;
    }

    mapping(PoolId => PoolTrack) internal _track;

    /// @notice EMA window (seconds) of the multi-block compound reference.
    uint256 public constant REF_WINDOW = 60;
    /// @notice Minimum reference history (seconds since the pool was registered) before any compounding.
    uint256 public constant REF_MIN_AGE = 60;
    /// @notice Minimum EMA observations (seed + distinct blocks), the last one >= REF_MIN_AGE after the seed.
    uint256 public constant REF_MIN_OBS = 3;
    /// @notice EMA speed limit: at most 100 ticks (≈ 1.005% price, 1/3 of the 3% compound guard) per REF_WINDOW of
    ///         elapsed time, and at most 50 ticks per observation.
    int256 public constant MAX_EMA_STEP_TICKS = 100;

    /// @notice Last spot altitude tier per pool (0..17).
    function altitudeTierOf(PoolId id) external view returns (uint8) {
        return _track[id].tier;
    }

    /// @notice Block-start price anchor: pre-swap price (tick-rounded) of the first swap of `blockNumber`.
    function blockAnchor(PoolId id) external view returns (uint64 blockNumber, uint160 sqrtPriceX96) {
        PoolTrack memory t = _track[id];
        return (t.anchorBlock, t.anchorBlock == 0 ? 0 : TickMath.getSqrtPriceAtTick(t.anchorTick));
    }

    /// @notice Multi-block compound reference: EMA tick (x256), last update time, start time, and whether it is
    ///         old enough (REF_MIN_AGE) to be used.
    function priceReference(PoolId id)
        external
        view
        returns (int32 emaTickX256, uint40 emaTime, uint40 refSince, uint8 obs, bool ready)
    {
        PoolTrack memory t = _track[id];
        return (t.emaTickX256, t.emaTime, t.refSince, t.obs, _refReady(t));
    }

    /// @notice References for LockedLP.flush: this block's block-start price (0 if the pool has not traded in
    ///         this block) and the EMA reference (0 if not ready → flush must skip).
    function compoundRefs(PoolId id) external view returns (uint160 refBlock, uint160 refEma) {
        PoolTrack memory t = _track[id];
        if (t.anchorBlock == uint40(block.number)) refBlock = TickMath.getSqrtPriceAtTick(t.anchorTick);
        if (_refReady(t)) refEma = TickMath.getSqrtPriceAtTick(_emaTick(t));
    }

    function _refReady(PoolTrack memory t) private pure returns (bool) {
        return t.refSince != 0 && t.obs >= REF_MIN_OBS && uint256(t.emaTime) >= uint256(t.refSince) + REF_MIN_AGE;
    }

    function _emaTick(PoolTrack memory t) private pure returns (int24) {
        return int24(t.emaTickX256 >> 8); // floor
    }

    event LiquidityManagerSet(address indexed manager, bool allowed);

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        _;
    }

    constructor(IPoolManager poolManager_, IFeeRouter feeRouter_, address migration_, address admin_) {
        admin = admin_;
        poolManager = poolManager_;
        feeRouter = feeRouter_;
        migration = migration_;
        Hooks.validateHookPermissions(this, getHookPermissions());
    }

    /// @notice One-time wire when constructed with migration == address(0). Audit #12: admin-only (the deployer,
    ///         set in the constructor) so it cannot be front-run between hook deploy and wiring.
    function setMigration(address m) external {
        if (msg.sender != admin) revert OnlyAdmin();
        require(migration == address(0) && m != address(0), "DiscipleHook: mig");
        migration = m;
    }

    function setTrustedRouter(address r, bool trusted) external {
        if (msg.sender != admin) revert OnlyAdmin();
        isTrustedRouter[r] = trusted;
        emit TrustedRouterSet(r, trusted);
    }

    /// @notice Live quote/USD oracle, read only by the view `quoteUsdOf` (off-chain / DiscipleRouter quotes). Never called
    ///         during a swap (gas G-1): the Trade event carries sqrtPriceAfter and altitude uses the launch-time price.
    IQuotePricer public pricer;

    function setPricer(address p) external {
        if (msg.sender != admin) revert OnlyAdmin();
        pricer = IQuotePricer(p);
    }

    /// @notice Live quote/USD price (falls back to launch-time). View only: DiscipleRouter.quoteExactIn's mcapAfterUsd and
    ///         off-chain USD mcap from Trade.sqrtPriceAfter use it. Not used on the swap path.
    function quoteUsdOf(PoolId id) external view returns (uint256) {
        return _quoteUsd(metaOf[id]);
    }

    function _quoteUsd(PoolMeta memory m) internal view returns (uint256) {
        if (address(pricer) != address(0)) {
            try pricer.quotePriceUsd(m.quote) returns (uint256 p) {
                if (p > 0) return p;
            } catch {}
        }
        return m.quotePriceUsd;
    }

    function setLiquidityManager(address mgr, bool allowed) external {
        if (msg.sender != admin) revert OnlyAdmin();
        isLiquidityManager[mgr] = allowed;
        emit LiquidityManagerSet(mgr, allowed);
    }

    function setCompounder(address c, uint32 gasLimit) external {
        if (msg.sender != admin) revert OnlyAdmin();
        require(gasLimit >= 50_000 && gasLimit <= 1_000_000, "DiscipleHook: gas");
        compounder = ILPCompounder(c);
        compoundGasLimit = gasLimit;
        emit CompounderSet(c, gasLimit);
    }

    /// @notice True if `id` was swapped earlier in the current transaction.
    function swappedInTx(PoolId id) external view returns (bool s) {
        bytes32 slot = keccak256(abi.encode(SWAPPED_SLOT, id));
        assembly ("memory-safe") {
            s := tload(slot)
        }
    }

    function transferAdmin(address a) external {
        if (msg.sender != admin) revert OnlyAdmin();
        admin = a;
        emit AdminTransferred(a);
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    /// @notice Called by Migration at graduation to bind pool → token/quote/creator.
    function registerPool(PoolKey calldata key, address token, address quote, address creator, uint256 quotePriceUsd)
        external
    {
        if (msg.sender != migration) revert OnlyMigration();
        PoolId id = key.toId();
        PoolMeta memory m =
            PoolMeta({token: token, quote: quote, creator: creator, registered: true, quotePriceUsd: quotePriceUsd});
        metaOf[id] = m;
        // Altitude stream starts at the seeded (curve-end) spot price.
        (uint160 sp, int24 tk,,) = poolManager.getSlot0(id);
        // launch-time quote/USD, same basis as the per-swap altitude in afterSwap (no oracle call)
        uint256 mcap = mcapUsdFromSqrt(sp, Currency.unwrap(key.currency0) == token, quotePriceUsd);
        uint8 tier = Altitude.tierOf(mcap);
        // The compound reference starts at the seeded (curve-end) price.
        _track[id] = PoolTrack({
            tier: tier,
            anchorBlock: 0,
            anchorTick: 0,
            emaTickX256: int32(tk) * 256,
            emaTime: uint40(block.timestamp),
            refSince: uint40(block.timestamp),
            obs: 1
        });
        emit AltitudeUpdate(token, mcap, tier);
    }

    function beforeSwap(address, PoolKey calldata key, IPoolManager.SwapParams calldata, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        (uint160 sqrtP, int24 tick,,) = poolManager.getSlot0(id);
        // First swap of the block on this pool: record the block-start tick and fold the price that held since
        // the last update into the EMA reference (one SSTORE). Later swaps in the block: one SLOAD (the slot is
        // then warm for afterSwap's tier read).
        PoolTrack storage tr = _track[id];
        if (tr.anchorBlock != uint40(block.number)) _rollBlock(id, tick);
        bytes32 slot = PRICE_SLOT;
        bytes32 swapped = keccak256(abi.encode(SWAPPED_SLOT, id));
        bytes32 repeat = REPEAT_SLOT;
        assembly ("memory-safe") {
            tstore(slot, sqrtP)
            // DISCIPLE audit #1: remember whether this pool was ALREADY swapped earlier in this tx. Compounding is
            // only allowed on the pool's first swap of the tx, so "pump → dust swap compounds at the manipulated
            // price → dump" in one tx can't add liquidity at a moved price (the 3% guard covers the swap itself).
            tstore(repeat, tload(swapped))
            tstore(swapped, 1)
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function _rollBlock(PoolId id, int24 tick) private {
        PoolTrack memory t = _track[id];
        t.anchorBlock = uint40(block.number);
        t.anchorTick = tick;
        uint256 dt = block.timestamp - t.emaTime;
        if (dt != 0 || t.refSince == 0) {
            int256 target = int256(tick) * 256;
            if (t.refSince == 0) {
                // unregistered pools never reach here in practice (afterSwap reverts); start the reference anyway
                t.refSince = uint40(block.timestamp);
                t.emaTickX256 = int32(target);
                t.obs = 1;
            } else {
                // never snap: weight <= 50% (dt capped at REF_WINDOW / 2), and the move is speed-limited to
                // MAX_EMA_STEP_TICKS per REF_WINDOW of elapsed time (so <= MAX/2 per observation, and dense dust
                // swaps can't walk it faster than ~1% price per minute)
                uint256 w = dt < REF_WINDOW / 2 ? dt : REF_WINDOW / 2;
                int256 e = t.emaTickX256;
                int256 step = (target - e) * int256(w) / int256(REF_WINDOW);
                int256 maxStep = MAX_EMA_STEP_TICKS * 256 * int256(w) / int256(REF_WINDOW);
                if (step > maxStep) step = maxStep;
                else if (step < -maxStep) step = -maxStep;
                t.emaTickX256 = int32(e + step);
                if (t.obs != type(uint8).max) ++t.obs;
            }
            t.emaTime = uint40(block.timestamp);
        }
        _track[id] = t; // one SSTORE (packed, tier preserved)
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4, int128) {
        PoolMeta memory m = metaOf[key.toId()];
        if (!m.registered) revert NotRegistered();

        // Fee on unspecified (output) token — same pattern as FeeTakingHook
        bool specifiedTokenIs0 = (params.amountSpecified < 0 == params.zeroForOne);
        (Currency feeCurrency, int128 swapAmount) =
            specifiedTokenIs0 ? (key.currency1, delta.amount1()) : (key.currency0, delta.amount0());
        if (swapAmount < 0) swapAmount = -swapAmount;

        uint256 feeAmount = uint256(uint128(swapAmount)) * Constants.TRADE_FEE_BPS / Constants.BPS_DENOM;
        address trader = sender;
        if (hookData.length == 32 && isTrustedRouter[sender]) {
            trader = abi.decode(hookData, (address));
        }

        address feeToken = Currency.unwrap(feeCurrency);
        if (feeAmount > 0) {
            // Full 1% fee → FeeRouter (33/33/33/1); no in-range LP donation (tramps/walls earn no yield).
            // Gas: PoolManager pays the FeeRouter directly (no hook hop / second ERC-20 transfer).
            poolManager.take(feeCurrency, address(feeRouter), feeAmount);
            // Audit #3 (gas): FeeRouter reports whether the LP buckets now hold both sides; one-sided accumulation
            // (the common case) skips the compound call entirely.
            if (feeRouter.routeHookFee(m.token, feeToken, trader, m.creator, feeAmount)) {
                _tryCompound(m.token, key.toId());
            }
        }

        // Gas G-1: no live QuotePricer call per swap. Trade carries sqrtPriceAfter; altitude/tier needs a USD mcap and
        // uses the cheapest existing path: the launch-time quote/USD already loaded in `m` (no extra SLOAD / CALL).
        (uint160 sqrtAfter, bool tokenIsC0) = _emitTrade(key, m, trader, delta, feeToken, feeAmount);
        _emitAltitude(key.toId(), m.token, mcapUsdFromSqrt(sqrtAfter, tokenIsC0, m.quotePriceUsd));
        return (IHooks.afterSwap.selector, feeAmount.toInt128());
    }

    /// @dev Never reverts the swap: gas-capped external call in try/catch, skipped when gas is short.
    ///      PoolManager is already unlocked by the swapper — no unlock here. LockedLP's modifyLiquidity re-enters
    ///      only beforeAddLiquidity (allowlist check), never the fee path.
    function _tryCompound(address token, PoolId id) internal {
        ILPCompounder c = compounder;
        if (address(c) == address(0)) return;
        uint256 rep;
        bytes32 rslot = REPEAT_SLOT;
        assembly ("memory-safe") {
            rep := tload(rslot)
        }
        if (rep != 0) return;
        uint256 g = compoundGasLimit;
        if (gasleft() < g + COMPOUND_GAS_RESERVE) return;
        uint160 sqrtBefore;
        bytes32 slot = PRICE_SLOT;
        assembly ("memory-safe") {
            sqrtBefore := tload(slot)
        }
        // DISCIPLE audit High-1 / L7: LockedLP checks spot against ALL THREE references (this swap's pre-price,
        // the block-start price and the multi-block EMA) and skips if any is > maxCompoundDeviationBps away. No
        // compounding at all until the EMA has REF_MIN_AGE of history.
        PoolTrack memory t = _track[id]; // warm (read in beforeSwap)
        if (!_refReady(t)) return;
        uint160 refBlock = TickMath.getSqrtPriceAtTick(t.anchorTick);
        uint160 refEma = TickMath.getSqrtPriceAtTick(_emaTick(t));
        try c.compoundFromHook{gas: g}(token, sqrtBefore, refBlock, refEma) {}
        catch {
            emit CompoundFailed(token);
        }
    }

    function _emitTrade(
        PoolKey calldata key,
        PoolMeta memory m,
        address trader,
        BalanceDelta delta,
        address feeToken,
        uint256 feeAmount
    ) internal returns (uint160 sqrtAfter, bool tokenIsC0) {
        tokenIsC0 = Currency.unwrap(key.currency0) == m.token;
        int128 dToken = tokenIsC0 ? delta.amount0() : delta.amount1();
        int128 dQuote = tokenIsC0 ? delta.amount1() : delta.amount0();
        bool isBuy = dToken > 0; // swapper receives token
        uint256 tokenAmt = _abs(dToken);
        uint256 quoteAmt = _abs(dQuote);
        // Net out the hook fee from the side it was charged on (output side for exact-in)
        bool feeInToken = feeToken == m.token;
        if (feeInToken) tokenAmt = isBuy ? tokenAmt - feeAmount : tokenAmt + feeAmount;
        else quoteAmt = isBuy ? quoteAmt + feeAmount : quoteAmt - feeAmount;

        uint160 sqrtBefore;
        bytes32 slot = PRICE_SLOT;
        assembly ("memory-safe") {
            sqrtBefore := tload(slot)
        }
        (sqrtAfter,,,) = poolManager.getSlot0(key.toId());
        uint256 pAfter = priceX18FromSqrt(sqrtAfter, tokenIsC0);
        uint256 feeQuote = feeInToken ? Math.mulDiv(feeAmount, pAfter, 1e18) : feeAmount;

        emit Trade(
            m.token,
            trader,
            isBuy,
            quoteAmt,
            tokenAmt,
            feeQuote,
            0,
            priceX18FromSqrt(sqrtBefore, tokenIsC0),
            pAfter,
            impactBpsFromSqrt(sqrtBefore, sqrtAfter, tokenIsC0),
            sqrtAfter
        );
    }

    /// @dev Altitude = SPOT mcap after the trade: Trade.sqrtPriceAfter at the launch-time quote/USD price.
    function _emitAltitude(PoolId id, address token, uint256 mcap) internal {
        uint8 tier = Altitude.tierOf(mcap);
        emit AltitudeUpdate(token, mcap, tier);
        uint8 prev = _track[id].tier;
        if (tier != prev) {
            _track[id].tier = tier;
            emit TierBreak(token, prev, tier, mcap);
        }
    }

    /// @notice Full-precision spot mcap (USD WAD) from sqrtPriceX96; qUsd = USD WAD per 1e18 raw quote.
    function mcapUsdFromSqrt(uint160 sqrtP, bool tokenIsC0, uint256 qUsd) public pure returns (uint256) {
        return McapMath.mcapUsdFromSqrt(sqrtP, tokenIsC0, Constants.TOTAL_SUPPLY, qUsd);
    }

    /// @notice quote raw * 1e18 / token raw from a v4 sqrtPriceX96.
    function priceX18FromSqrt(uint160 sqrtP, bool tokenIsC0) public pure returns (uint256) {
        if (sqrtP == 0) return 0;
        uint256 pX128 = Math.mulDiv(sqrtP, sqrtP, 1 << 64); // c1 per c0, X128
        return tokenIsC0 ? Math.mulDiv(pX128, 1e18, 1 << 128) : Math.mulDiv(1 << 128, 1e18, pX128);
    }

    /// @notice |Δprice|/price in bps, price = quote per token, from sqrt prices (full precision).
    function impactBpsFromSqrt(uint160 sb, uint160 sa, bool tokenIsC0) public pure returns (uint256) {
        if (sb == 0 || sa == 0) return 0;
        uint256 d = sa > sb ? uint256(sa - sb) : uint256(sb - sa);
        uint256 sum = uint256(sa) + uint256(sb);
        // token c0: p ∝ s² → |sa²-sb²|/sb² ; token c1: p ∝ 1/s² → |sa²-sb²|/sa²
        uint256 denomRoot = tokenIsC0 ? sb : sa;
        return Math.mulDiv(Math.mulDiv(d, sum, denomRoot), Constants.BPS_DENOM, denomRoot);
    }

    /// @dev Monotonic deviation proxy: max/min ratio of two sqrt prices, 1e18-scaled.
    function _abs(int128 x) private pure returns (uint256) {
        return uint256(uint128(x < 0 ? -x : x));
    }

    // ── unused hooks revert ──────────────────────────────────────────────────
    /// @dev Audit #2: only LockedLP (seeding at graduation, called by Migration) may initialize.
    function beforeInitialize(address sender, PoolKey calldata, uint160)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        address m = migration;
        if (m == address(0) || sender != IMigrationLockedLP(m).lockedLP()) revert OnlyLockedLP();
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    /// @dev SEC-02: raw v4 adds are blocked; only LockedLP / TrampWallManager (which enforces a minimum hold).
    function beforeAddLiquidity(
        address sender,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external view onlyPoolManager returns (bytes4) {
        if (!isLiquidityManager[sender]) revert OnlyLiquidityManager();
        return IHooks.beforeAddLiquidity.selector;
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

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
