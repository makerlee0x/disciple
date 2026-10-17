// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ILockedLP} from "./interfaces/ILockedLP.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {CurrencySettler} from "./libraries/CurrencySettler.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev Hook-side view used by flush() to refuse adds in a tx that already swapped this pool (atomic sandwich).
interface ISwapInTx {
    function swappedInTx(PoolId id) external view returns (bool);
}

/// @title Permanently locked v4 LP owner (§3 / LOCKED #16–#17)
/// @notice Owns the full-range v4 position forever. removeLiquidity always reverts.
/// @dev Pool LP fee is 0; trade fees taken by DiscipleHook. collectFees is a no-op residual for #16.
///      LP auto-compound: after graduation the 33% LP share of the 1% hook fee lands in two per-coin buckets
///      (token side from buys, quote side from sells). On every swap DiscipleHook calls compoundFromHook (the
///      PoolManager is already unlocked by the swapper); once the matched liquidity passes minCompoundPpm of the
///      position it is added to the SAME locked full-range position (same ticks + salt), each currency settled
///      immediately (sync → transfer → settle), and the unmatched remainder carries forward. flush() does the
///      same outside swaps via unlock. No rebalancing swaps are ever made.
contract LockedLP is ILockedLP, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using CurrencySettler for Currency;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;
    using CurrencyLibrary for Currency;

    address public treasury;
    address public owner;
    address public migration;
    /// @notice FeeRouter allowed to lock LP shares / snipe escrow (SEC-01: addLockedLiquidity is caller-restricted).
    address public feeRouter;
    IPoolManager public poolManager;

    int24 public constant TICK_SPACING = 60;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    struct Position {
        address quote;
        address token;
        uint256 tokenAmount; // intended seed (may exceed used)
        uint256 quoteAmount;
        uint256 escrowQuote; // curve-phase fee LP share before graduation
        bool graduated;
        PoolKey poolKey;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        bool tokenIsC0; // packed with ticks + liquidity (compound hot path reads one slot)
        bytes32 salt;
        PoolId poolId; // cached for the compound hot path (avoids re-hashing / reading the 3-slot key)
    }

    mapping(address => Position) internal _positions; // token => position

    /// @notice Post-graduation LP-share buckets pending compound. Invariant: for every graduated coin these are
    ///         exactly the token / quote amounts LockedLP holds on that coin's behalf.
    struct Bucket {
        uint128 token;
        uint128 quote;
    }

    mapping(address => Bucket) internal _buckets;

    /// @notice DiscipleHook (only caller of compoundFromHook; also the swappedInTx oracle for flush).
    address public hook;
    /// @notice Minimum liquidity per add, in ppm of the position's current liquidity (gas saver). Default 0.005%.
    uint32 public minCompoundPpm = 50;
    /// @notice Per-add cap, in ppm of the position's current liquidity (0 = uncapped). Default 2%.
    uint32 public maxCompoundPpm = 20_000;
    /// @notice Skip if the post-swap price moved more than this vs the pre-swap price. Default 3%.
    uint16 public maxCompoundDeviationBps = 300;

    uint160 internal immutable SQRT_LOWER;
    uint160 internal immutable SQRT_UPPER;

    uint8 internal constant CB_SEED = 0;
    uint8 internal constant CB_FLUSH = 1;

    error OnlyOwner();
    error OnlyMigration();
    error Unauthorized();
    error OnlyPoolManager();
    error RemoveLiquidityDisabled();
    error NotGraduated();
    error ZeroLiquidity();
    error OnlyHook();
    error BadParams();
    error SwappedInTx();
    error CompoundOverspend();
    error CompoundCredit();

    event LiquidityLocked(address indexed token, address indexed quote, uint256 tokenAmount, uint256 quoteAmount);
    event QuoteEscrowed(address indexed token, address indexed quote, uint256 amount);
    event FeesCollected(address indexed token, uint256 amount0, uint256 amount1);
    /// @notice Audit #4 (rev. 2026-10-16): quote not absorbed by the full-range add at the curve-end price goes
    ///         into the coin's compound quote bucket (pairs with incoming token fees over time); token dust
    ///         (rounding only) → burn address. Emitted once per graduation. Same signature as before.
    event GraduationLeftover(address indexed token, uint256 quoteToCompoundBucket, uint256 tokenBurned);
    event V4PositionSeeded(
        address indexed token, PoolId poolId, uint128 liquidity, int24 tickLower, int24 tickUpper, uint160 sqrtPriceX96
    );

    /// @notice LP-share bucket credited after graduation (one side per swap).
    event CompoundBucketed(address indexed token, uint256 tokenAmount, uint256 quoteAmount);
    event LiquidityCompounded(
        address indexed token,
        uint128 liquidity,
        uint256 tokenUsed,
        uint256 quoteUsed,
        uint256 tokenCarry,
        uint256 quoteCarry
    );
    event CompoundParamsSet(uint32 minPpm, uint32 maxPpm, uint16 maxDeviationBps);
    event HookSet(address indexed hook);

    constructor(address owner_, address treasury_) {
        owner = owner_;
        treasury = treasury_;
        SQRT_LOWER = TickMath.getSqrtPriceAtTick(TickMath.minUsableTick(TICK_SPACING));
        SQRT_UPPER = TickMath.getSqrtPriceAtTick(TickMath.maxUsableTick(TICK_SPACING));
    }

    function setHook(address h) external {
        if (msg.sender != owner) revert OnlyOwner();
        hook = h;
        emit HookSet(h);
    }

    /// @param minPpm  minimum add as ppm of position liquidity (<= 1e6)
    /// @param maxPpm  per-add cap as ppm of position liquidity (0 = uncapped; else >= minPpm)
    /// @param maxDevBps max |post/pre - 1| price move (1..5000)
    function setCompoundParams(uint32 minPpm, uint32 maxPpm, uint16 maxDevBps) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (minPpm > 1e6 || (maxPpm != 0 && maxPpm < minPpm) || maxDevBps == 0 || maxDevBps > 5000) {
            revert BadParams();
        }
        minCompoundPpm = minPpm;
        maxCompoundPpm = maxPpm;
        maxCompoundDeviationBps = maxDevBps;
        emit CompoundParamsSet(minPpm, maxPpm, maxDevBps);
    }

    function setTreasury(address t) external {
        if (msg.sender != owner) revert OnlyOwner();
        treasury = t;
    }

    function setFeeRouter(address r) external {
        if (msg.sender != owner) revert OnlyOwner();
        feeRouter = r;
    }

    function setMigration(address m) external {
        if (msg.sender != owner) revert OnlyOwner();
        migration = m;
    }

    function setPoolManager(address pm) external {
        if (msg.sender != owner) revert OnlyOwner();
        poolManager = IPoolManager(pm);
    }

    /// @inheritdoc ILockedLP
    function addLockedLiquidity(address token, address quote, uint256 tokenAmount, uint256 quoteAmount)
        external
        override
        returns (uint256 lpShares)
    {
        // SEC-01: only FeeRouter (fee LP share) and Migration (graduation) may add; otherwise anyone could
        // overflow escrowQuote with a worthless token and brick all fee routing for a coin.
        if (msg.sender != feeRouter && msg.sender != migration) revert Unauthorized();
        if (quoteAmount > 0) {
            IERC20(quote).safeTransferFrom(msg.sender, address(this), quoteAmount);
        }
        if (tokenAmount > 0) {
            IERC20(token).safeTransferFrom(msg.sender, address(this), tokenAmount);
        }
        _credit(token, quote, tokenAmount, quoteAmount);
        return tokenAmount + quoteAmount;
    }

    /// @notice Gas path for the per-trade LP share: FeeRouter has ALREADY transferred the amounts here.
    /// @dev FeeRouter-only (it transfers exactly these amounts immediately before this call, same tx).
    /// @return compoundReady post-graduation and both buckets hold >= 2 wei (the hook may try to compound).
    function creditLockedLiquidity(address token, address quote, uint256 tokenAmount, uint256 quoteAmount)
        external
        returns (bool compoundReady)
    {
        if (msg.sender != feeRouter) revert Unauthorized();
        return _credit(token, quote, tokenAmount, quoteAmount);
    }

    function _credit(address token, address quote, uint256 tokenAmount, uint256 quoteAmount)
        internal
        returns (bool compoundReady)
    {
        Position storage p = _positions[token];
        if (p.graduated) {
            // Post-graduation LP share → compound buckets (FeeRouter sends exactly one side per swap).
            Bucket memory b = _buckets[token];
            b.token += SafeCast.toUint128(tokenAmount);
            b.quote += SafeCast.toUint128(quoteAmount);
            _buckets[token] = b;
            emit CompoundBucketed(token, tokenAmount, quoteAmount);
            return b.token >= 2 && b.quote >= 2;
        }
        if (p.quote == address(0)) p.quote = quote;
        if (p.token != token) p.token = token;

        if (tokenAmount == 0 && quoteAmount > 0) {
            p.escrowQuote += quoteAmount;
            emit QuoteEscrowed(token, quote, quoteAmount);
            return false;
        }

        p.tokenAmount += tokenAmount;
        p.quoteAmount += quoteAmount;
        emit LiquidityLocked(token, quote, tokenAmount, quoteAmount);
    }

    struct SeedParams {
        address token;
        address quote;
        PoolKey key;
        uint160 sqrtPriceX96;
        uint256 amount0;
        uint256 amount1;
        bytes32 salt;
    }

    /// @notice Initialize pool (if needed) and seed full-range liquidity owned by this contract.
    function seedV4Position(
        address token,
        address quote,
        PoolKey calldata key,
        uint160 sqrtPriceX96,
        uint256 amount0Desired,
        uint256 amount1Desired,
        bytes32 salt
    ) external returns (uint128 liquidity) {
        if (msg.sender != migration) revert OnlyMigration();
        if (address(poolManager) == address(0)) revert ZeroLiquidity();

        Position storage p = _positions[token];
        p.quote = quote;
        p.token = token;
        p.poolKey = key;
        p.salt = salt;
        p.tickLower = TickMath.minUsableTick(TICK_SPACING);
        p.tickUpper = TickMath.maxUsableTick(TICK_SPACING);
        p.graduated = true;
        p.poolId = key.toId();
        p.tokenIsC0 = Currency.unwrap(key.currency0) == token;

        // Include any escrowed quote into the quote side of the seed
        // (caller already transferred primary amounts via addLockedLiquidity)

        // Initialize pool at curve-end price (no jump). Audit #2: no try/catch — DiscipleHook.beforeInitialize
        // only lets this contract initialize, so a pre-initialized (mispriced) pool cannot exist.
        poolManager.initialize(key, sqrtPriceX96);

        SeedParams memory sp = SeedParams({
            token: token,
            quote: quote,
            key: key,
            sqrtPriceX96: sqrtPriceX96,
            amount0: amount0Desired,
            amount1: amount1Desired,
            salt: salt
        });

        bytes memory result = poolManager.unlock(abi.encode(CB_SEED, abi.encode(sp)));
        uint256 used0;
        uint256 used1;
        (liquidity, used0, used1) = abi.decode(result, (uint128, uint256, uint256));
        p.liquidity = liquidity;

        // Audit #4: liquidity is the max matched amount at the curve-end price; whatever one side could not
        // be paired with is swept explicitly so LockedLP's per-token accounting equals real balances.
        bool tokenIsC0 = Currency.unwrap(key.currency0) == token;
        (uint256 tokenUsed, uint256 quoteUsed) = tokenIsC0 ? (used0, used1) : (used1, used0);
        (uint256 tokenDesired, uint256 quoteDesired) =
            tokenIsC0 ? (amount0Desired, amount1Desired) : (amount1Desired, amount0Desired);
        uint256 quoteLeft = quoteDesired - quoteUsed;
        uint256 tokenLeft = tokenDesired - tokenUsed;
        if (quoteLeft > 0) _graduationQuoteLeftover(token, quote, quoteLeft);
        if (tokenLeft > 0) IERC20(token).safeTransfer(BURN, tokenLeft);
        p.tokenAmount = tokenUsed;
        p.quoteAmount = quoteUsed;
        p.escrowQuote = 0;
        emit GraduationLeftover(token, quoteLeft, tokenLeft);

        emit V4PositionSeeded(token, key.toId(), liquidity, p.tickLower, p.tickUpper, sqrtPriceX96);
    }

    /// @dev Decision (Maker lee, 2026-10-16): unabsorbed graduation quote stays in LockedLP as the coin's compound
    ///      quote bucket (previously swept to treasury). It is already held here, so the bucket invariant holds.
    function _graduationQuoteLeftover(address token, address, uint256 amount) internal {
        _buckets[token].quote += SafeCast.toUint128(amount);
    }

    // ── LP auto-compound ─────────────────────────────────────────────────────

    /// @notice Called by DiscipleHook.afterSwap (PoolManager already unlocked by the swapper). The hook wraps this
    ///         in try/catch with a gas cap, so any revert here only skips the add — never the user's swap.
    /// @param sqrtBefore pre-swap sqrtPriceX96 (hook's transient PRICE_SLOT) for the deviation guard.
    function compoundFromHook(address token, uint160 sqrtBefore) external returns (uint128) {
        if (msg.sender != hook) revert OnlyHook();
        return _compound(token, sqrtBefore);
    }

    /// @notice Permissionless top-up outside swaps (uses unlock). Same min / cap guards; refuses if the pool was
    ///         already swapped earlier in this tx (atomic sandwich). Returns liquidity added (0 = skipped).
    function flush(address token) external returns (uint128 liquidity) {
        Position storage p = _positions[token];
        if (!p.graduated) revert NotGraduated();
        address h = hook;
        if (h != address(0) && ISwapInTx(h).swappedInTx(p.poolKey.toId())) revert SwappedInTx();
        bytes memory r = poolManager.unlock(abi.encode(CB_FLUSH, abi.encode(token)));
        liquidity = abi.decode(r, (uint128));
    }

    /// @notice Pending LP-share buckets for a graduated coin (token side, quote side).
    function compoundBucket(address token) external view returns (uint256 tokenAmount, uint256 quoteAmount) {
        Bucket memory b = _buckets[token];
        return (b.token, b.quote);
    }

    /// @dev Must run while the PoolManager is unlocked. Returns 0 (no state change) when skipped.
    ///      sqrtRef == 0 → use spot (flush path: no intra-swap reference, swappedInTx already checked).
    function _compound(address token, uint160 sqrtRef) internal returns (uint128 liq) {
        Bucket memory b = _buckets[token];
        // Cheapest exit first: one-sided accumulation (the common case) costs one SLOAD.
        if (b.token < 2 || b.quote < 2) return 0;
        // Non-empty buckets imply graduated (addLockedLiquidity only buckets post-graduation).
        Position storage p = _positions[token];
        (uint160 sqrtP,,,) = poolManager.getSlot0(p.poolId);
        if (sqrtRef != 0 && _deviationBps(sqrtRef, sqrtP) > maxCompoundDeviationBps) return 0;

        bool tokenIsC0 = p.tokenIsC0;
        // 1 wei margin per side: amounts owed for L round up by at most 1, so owed <= bucket always.
        (uint256 a0, uint256 a1) = tokenIsC0 ? (b.token - 1, b.quote - 1) : (b.quote - 1, b.token - 1);
        liq = LiquidityAmounts.getLiquidityForAmounts(sqrtP, SQRT_LOWER, SQRT_UPPER, a0, a1);

        uint256 posL = p.liquidity;
        if (liq == 0 || uint256(liq) * 1e6 < posL * minCompoundPpm) return 0;
        uint256 maxPpm = maxCompoundPpm;
        if (maxPpm != 0) {
            uint256 capL = posL * maxPpm / 1e6;
            if (liq > capL) liq = uint128(capL);
            if (liq == 0) return 0;
        }

        // DISCIPLE audit #2: never touch sync/settle state the swapper may be using. If any currency is synced
        // (a swapper pre-paid via sync→transfer and has not settled yet), our sync() would overwrite it — skip.
        if (!poolManager.getSyncedCurrency().isAddressZero()) return 0;

        PoolKey memory key = p.poolKey;
        // Adds to the SAME locked position (owner = this, same ticks + salt). beforeAddLiquidity on our hook only
        // checks the LockedLP allowlist — no fee logic re-entry.
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: p.tickLower, tickUpper: p.tickUpper, liquidityDelta: int256(uint256(liq)), salt: p.salt
            }),
            ""
        );
        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();
        if (d0 > 0 || d1 > 0) revert CompoundCredit(); // pool fee 0 → never; never leave a credit open
        uint256 used0 = uint256(int256(-d0));
        uint256 used1 = uint256(int256(-d1));
        (uint256 tokenUsed, uint256 quoteUsed) = tokenIsC0 ? (used0, used1) : (used1, used0);
        if (tokenUsed > b.token || quoteUsed > b.quote) revert CompoundOverspend();

        // Settle each currency immediately and completely (sync → transfer → settle, no interleaving).
        if (used0 > 0) key.currency0.settle(poolManager, address(this), used0, false);
        if (used1 > 0) key.currency1.settle(poolManager, address(this), used1, false);

        uint128 tCarry = b.token - uint128(tokenUsed);
        uint128 qCarry = b.quote - uint128(quoteUsed);
        _buckets[token] = Bucket({token: tCarry, quote: qCarry});
        p.liquidity += liq;
        p.tokenAmount += tokenUsed;
        p.quoteAmount += quoteUsed;
        emit LiquidityCompounded(token, liq, tokenUsed, quoteUsed, tCarry, qCarry);
    }

    /// @dev |(hi/lo)^2 - 1| in bps from two sqrt prices (direction-agnostic, slightly conservative).
    function _deviationBps(uint160 a, uint160 b) internal pure returns (uint256) {
        if (a == b) return 0;
        if (a == 0 || b == 0) return type(uint256).max;
        (uint256 hi, uint256 lo) = a > b ? (uint256(a), uint256(b)) : (uint256(b), uint256(a));
        return Math.mulDiv(Math.mulDiv(hi, 10_000, lo), hi, lo) - 10_000;
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata rawData) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        (uint8 kind, bytes memory inner) = abi.decode(rawData, (uint8, bytes));
        if (kind == CB_FLUSH) {
            return abi.encode(_compound(abi.decode(inner, (address)), 0));
        }
        SeedParams memory sp = abi.decode(inner, (SeedParams));
        Position storage p = _positions[sp.token];

        uint160 sqrtPriceX96 = sp.sqrtPriceX96;
        // Re-read in case initialize moved us — use passed price for liquidity math
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(p.tickLower),
            TickMath.getSqrtPriceAtTick(p.tickUpper),
            sp.amount0,
            sp.amount1
        );
        require(liq > 0, "LockedLP: liq=0");

        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            sp.key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: p.tickLower, tickUpper: p.tickUpper, liquidityDelta: int256(uint256(liq)), salt: sp.salt
            }),
            ""
        );

        // Settle debts (negative deltas)
        if (delta.amount0() < 0) {
            sp.key.currency0.settle(poolManager, address(this), uint256(int256(-delta.amount0())), false);
        }
        if (delta.amount1() < 0) {
            sp.key.currency1.settle(poolManager, address(this), uint256(int256(-delta.amount1())), false);
        }
        // Adding liquidity never yields credits (pool fee 0, fresh position)
        uint256 used0 = delta.amount0() < 0 ? uint256(int256(-delta.amount0())) : 0;
        uint256 used1 = delta.amount1() < 0 ? uint256(int256(-delta.amount1())) : 0;
        return abi.encode(liq, used0, used1);
    }

    /// @inheritdoc ILockedLP
    /// @dev Pool fee is 0; residual collect for compatibility. Any tokens held pushed to treasury.
    function collectFees(address token) external override returns (uint256 amount0, uint256 amount1) {
        Position storage p = _positions[token];
        if (!p.graduated) revert NotGraduated();
        // With 0 LP fee there is nothing in the position fee growth; leftover dust → treasury
        amount0 = 0;
        amount1 = 0;
        emit FeesCollected(token, amount0, amount1);
    }

    /// @inheritdoc ILockedLP
    function removeLiquidity(address, uint256) external pure override {
        revert RemoveLiquidityDisabled();
    }

    function getPoolKey(address token) external view returns (PoolKey memory) {
        return _positions[token].poolKey;
    }

    function positions(address token)
        external
        view
        returns (
            address quote,
            address token_,
            uint256 tokenAmount,
            uint256 quoteAmount,
            uint256 escrowQuote,
            bool graduated,
            uint128 liquidity
        )
    {
        Position storage p = _positions[token];
        return (p.quote, p.token, p.tokenAmount, p.quoteAmount, p.escrowQuote, p.graduated, p.liquidity);
    }

    function isGraduated(address token) external view returns (bool) {
        return _positions[token].graduated;
    }

    /// @notice Position identity for off-chain / tests (owner is always this contract).
    function positionTicks(address token) external view returns (int24 tickLower, int24 tickUpper, bytes32 salt) {
        Position storage p = _positions[token];
        return (p.tickLower, p.tickUpper, p.salt);
    }
}
