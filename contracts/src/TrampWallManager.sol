// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint128} from "@uniswap/v4-core/src/libraries/FixedPoint128.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {CurrencySettler} from "./libraries/CurrencySettler.sol";
import {LockedLP} from "./LockedLP.sol";

/// @title Tramps & walls — single-sided concentrated LP orders in graduated DISCIPLE v4 pools
/// @notice "Price" below = quote per token.
///         Tramp = quote-only range strictly BELOW the current price (support: buys the dip, converts quote→token).
///         Wall  = token-only range strictly ABOVE the current price (resistance: sells into pumps, token→quote).
///         Positions are owned by this contract in the PoolManager (salt = id) and tracked per user here.
///         In-range positions earn the DiscipleHook donation (1/3 of the 33% LP share of the 1% fee).
/// @dev Pool LP fee is 0, so fees come only from hook donations. No custody beyond the v4 position itself;
///      only the position owner can cancel/claim; `pull` is permissionless but always pays the owner.
///      SEC-02 (JIT): a position cannot be cancelled or pulled before `minHoldSeconds`, and donation fees vest
///      linearly over `feeVestSeconds` from placement. Unvested fees taken out by cancel/pull/claim are
///      forfeited to the treasury (LockedLP.treasury()). An add→swap→remove in one block therefore earns 0.
contract TrampWallManager is IUnlockCallback, ReentrancyGuardTransient {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using CurrencySettler for Currency;

    IPoolManager public immutable poolManager;
    LockedLP public immutable lockedLP;
    address public immutable hook;

    enum Kind {
        Tramp,
        Wall
    }

    struct Position {
        address owner;
        address token;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        Kind kind;
        bool active;
    }

    uint256 public nextId = 1;
    mapping(uint256 => Position) public positions;
    mapping(address => uint256[]) internal _idsOf;
    /// @notice Placement timestamp per position id (kept out of `positions` so its ABI is unchanged).
    mapping(uint256 => uint64) public placedAt;

    address public owner;
    /// @notice Minimum seconds between place and cancel/pull (SEC-02).
    uint32 public minHoldSeconds = 300;
    /// @notice Donation fees vest linearly over this many seconds from placement (SEC-02).
    uint32 public feeVestSeconds = 3600;
    uint32 public constant MAX_HOLD = 7 days;

    error OnlyPoolManager();
    error NotGraduated();
    error Expired();
    error BadRange();
    error NotSingleSided();
    error LiquidityTooLow(uint128 liquidity);
    error NotOwner();
    error Inactive();
    error NotFilled();
    error ZeroAmount();
    error OnlyOwner();
    error BadParam();
    error HoldActive(uint256 unlockAt);

    event TrampPlaced(
        uint256 indexed id,
        address indexed owner,
        address indexed token,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 quoteAmt
    );
    event WallPlaced(
        uint256 indexed id,
        address indexed owner,
        address indexed token,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 tokenAmt
    );
    /// @notice Range fully crossed and removed via `pull`. Amounts include fees.
    event Filled(
        uint256 indexed id,
        address indexed owner,
        address indexed token,
        int24 tickLower,
        int24 tickUpper,
        uint256 quoteOut,
        uint256 tokenOut,
        address keeper
    );
    /// @notice Owner removed the position. Amounts include fees (also reported separately).
    event Cancelled(
        uint256 indexed id,
        address indexed owner,
        address indexed token,
        int24 tickLower,
        int24 tickUpper,
        uint256 quoteOut,
        uint256 tokenOut,
        uint256 quoteFees,
        uint256 tokenFees
    );
    event JitParamsSet(uint32 minHoldSeconds, uint32 feeVestSeconds);
    event OwnerTransferred(address indexed owner);
    /// @notice Unvested donation fees withheld on cancel/pull/claim and sent to the treasury.
    event FeesForfeited(uint256 indexed id, address indexed to, uint256 quoteFees, uint256 tokenFees);
    event FeesClaimed(
        uint256 indexed id, address indexed owner, address indexed token, uint256 quoteFees, uint256 tokenFees
    );

    enum Op {
        Add,
        Remove,
        Poke
    }

    struct CallbackData {
        Op op;
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        int256 liquidityDelta;
        bytes32 salt;
        address payer; // Add
        address recipient; // Remove / Poke
        uint256 vestBps; // Remove / Poke: share of accrued fees paid to recipient (rest → forfeitTo)
        address forfeitTo;
    }

    constructor(IPoolManager poolManager_, LockedLP lockedLP_, address hook_) {
        poolManager = poolManager_;
        lockedLP = lockedLP_;
        hook = hook_;
        owner = msg.sender;
    }

    function setJitParams(uint32 minHold, uint32 vest) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (minHold > MAX_HOLD || vest > MAX_HOLD) revert BadParam();
        minHoldSeconds = minHold;
        feeVestSeconds = vest;
        emit JitParamsSet(minHold, vest);
    }

    function transferOwnership(address o) external {
        if (msg.sender != owner) revert OnlyOwner();
        owner = o;
        emit OwnerTransferred(o);
    }

    /// @notice Share of accrued fees (bps) the owner would receive right now.
    function vestedBps(uint256 id) public view returns (uint256) {
        uint256 age = block.timestamp - placedAt[id];
        if (feeVestSeconds == 0 || age >= feeVestSeconds) return 10_000;
        return age * 10_000 / feeVestSeconds;
    }

    /// @notice Earliest timestamp at which `cancel` / `pull` are allowed.
    function unlockAt(uint256 id) public view returns (uint256) {
        return uint256(placedAt[id]) + minHoldSeconds;
    }

    // ───────────────────────────── views ─────────────────────────────

    function poolKeyOf(address token) public view returns (PoolKey memory key) {
        key = lockedLP.getPoolKey(token);
        if (address(key.hooks) != hook || hook == address(0)) revert NotGraduated();
    }

    /// @notice Current pool tick and whether the token is currency0 (frontend: price↔tick conversion).
    function poolState(address token)
        external
        view
        returns (int24 tick, uint160 sqrtPriceX96, int24 tickSpacing, bool tokenIsCurrency0)
    {
        PoolKey memory key = poolKeyOf(token);
        (sqrtPriceX96, tick,,) = poolManager.getSlot0(key.toId());
        tickSpacing = key.tickSpacing;
        tokenIsCurrency0 = Currency.unwrap(key.currency0) == token;
    }

    function positionsOf(address owner) external view returns (uint256[] memory) {
        return _idsOf[owner];
    }

    /// @notice Unclaimed donation fees of a position, in (quote, token).
    function pendingFees(uint256 id) public view returns (uint256 quoteFees, uint256 tokenFees) {
        Position memory p = positions[id];
        if (!p.active) return (0, 0);
        PoolKey memory key = poolKeyOf(p.token);
        PoolId pid = key.toId();
        (uint128 liq, uint256 last0, uint256 last1) =
            poolManager.getPositionInfo(pid, address(this), p.tickLower, p.tickUpper, bytes32(id));
        (uint256 g0, uint256 g1) = poolManager.getFeeGrowthInside(pid, p.tickLower, p.tickUpper);
        uint256 f0;
        uint256 f1;
        unchecked {
            f0 = FullMath.mulDiv(g0 - last0, liq, FixedPoint128.Q128);
            f1 = FullMath.mulDiv(g1 - last1, liq, FixedPoint128.Q128);
        }
        (quoteFees, tokenFees) = Currency.unwrap(key.currency0) == p.token ? (f1, f0) : (f0, f1);
    }

    /// @notice Fees the owner would actually receive now (pendingFees × vestedBps).
    function claimableFees(uint256 id) external view returns (uint256 quoteFees, uint256 tokenFees) {
        (uint256 q, uint256 t) = pendingFees(id);
        uint256 v = vestedBps(id);
        return (q * v / 10_000, t * v / 10_000);
    }

    /// @notice True when the price has moved fully through the range (position is now 100% the other asset).
    function isFilled(uint256 id) public view returns (bool) {
        Position memory p = positions[id];
        if (!p.active) return false;
        PoolKey memory key = poolKeyOf(p.token);
        (uint160 sp,,,) = poolManager.getSlot0(key.toId());
        bool quoteIsC0 = Currency.unwrap(key.currency0) != p.token;
        // Original side currency: Tramp = quote, Wall = token. Side is c0 → range sat above price; filled when
        // price (sqrt c1/c0) rises to/above upper. Side is c1 → range sat below; filled when price ≤ lower.
        bool sideIsC0 = (p.kind == Kind.Tramp) == quoteIsC0;
        return
            sideIsC0 ? sp >= TickMath.getSqrtPriceAtTick(p.tickUpper) : sp <= TickMath.getSqrtPriceAtTick(p.tickLower);
    }

    // ───────────────────────────── place ─────────────────────────────

    /// @notice Quote-only support range below current price.
    function placeTramp(
        address token,
        int24 tickLower,
        int24 tickUpper,
        uint256 quoteAmt,
        uint128 minLiquidity,
        uint256 deadline
    ) external nonReentrant returns (uint256 id, uint128 liquidity) {
        (id, liquidity) = _place(token, tickLower, tickUpper, quoteAmt, minLiquidity, deadline, Kind.Tramp);
        emit TrampPlaced(id, msg.sender, token, tickLower, tickUpper, liquidity, quoteAmt);
    }

    /// @notice Token-only resistance range above current price.
    function placeWall(
        address token,
        int24 tickLower,
        int24 tickUpper,
        uint256 tokenAmt,
        uint128 minLiquidity,
        uint256 deadline
    ) external nonReentrant returns (uint256 id, uint128 liquidity) {
        (id, liquidity) = _place(token, tickLower, tickUpper, tokenAmt, minLiquidity, deadline, Kind.Wall);
        emit WallPlaced(id, msg.sender, token, tickLower, tickUpper, liquidity, tokenAmt);
    }

    function _place(
        address token,
        int24 tl,
        int24 tu,
        uint256 amount,
        uint128 minLiquidity,
        uint256 deadline,
        Kind kind
    ) internal returns (uint256 id, uint128 liquidity) {
        if (block.timestamp > deadline) revert Expired();
        if (amount == 0) revert ZeroAmount();
        PoolKey memory key = poolKeyOf(token);
        if (tl >= tu || tl < TickMath.MIN_TICK || tu > TickMath.MAX_TICK) revert BadRange();
        if (tl % key.tickSpacing != 0 || tu % key.tickSpacing != 0) revert BadRange();

        (uint160 sp,,,) = poolManager.getSlot0(key.toId());
        uint160 sL = TickMath.getSqrtPriceAtTick(tl);
        uint160 sU = TickMath.getSqrtPriceAtTick(tu);
        bool quoteIsC0 = Currency.unwrap(key.currency0) != token;
        bool sideIsC0 = (kind == Kind.Tramp) == quoteIsC0;
        // Strictly single-sided: c0-only needs price < lower; c1-only needs price ≥ upper.
        if (sideIsC0) {
            if (sp >= sL) revert NotSingleSided();
            liquidity = LiquidityAmounts.getLiquidityForAmount0(sL, sU, amount);
        } else {
            if (sp < sU) revert NotSingleSided();
            liquidity = LiquidityAmounts.getLiquidityForAmount1(sL, sU, amount);
        }
        if (liquidity == 0 || liquidity < minLiquidity) revert LiquidityTooLow(liquidity);

        id = nextId++;
        positions[id] = Position({
            owner: msg.sender,
            token: token,
            tickLower: tl,
            tickUpper: tu,
            liquidity: liquidity,
            kind: kind,
            active: true
        });
        _idsOf[msg.sender].push(id);
        placedAt[id] = uint64(block.timestamp);

        poolManager.unlock(
            abi.encode(
                CallbackData({
                    op: Op.Add,
                    key: key,
                    tickLower: tl,
                    tickUpper: tu,
                    liquidityDelta: int256(uint256(liquidity)),
                    salt: bytes32(id),
                    payer: msg.sender,
                    recipient: address(0),
                    vestBps: 0,
                    forfeitTo: address(0)
                })
            )
        );
    }

    // ───────────────────────────── remove / fees ─────────────────────────────

    /// @notice Owner removes the position; receives remaining principal (either/both assets) + accrued fees.
    function cancel(uint256 id) external nonReentrant returns (uint256 quoteOut, uint256 tokenOut) {
        Position memory p = positions[id];
        if (!p.active) revert Inactive();
        if (p.owner != msg.sender) revert NotOwner();
        _checkHold(id);
        (uint256 qf, uint256 tf) = pendingFees(id);
        uint256 v = vestedBps(id);
        (quoteOut, tokenOut) = _remove(id, p);
        emit Cancelled(id, p.owner, p.token, p.tickLower, p.tickUpper, quoteOut, tokenOut, qf * v / 1e4, tf * v / 1e4);
    }

    /// @notice Permissionless keeper: remove a fully-crossed range and send everything to its owner. No tip (v0).
    function pull(uint256 id) external nonReentrant returns (uint256 quoteOut, uint256 tokenOut) {
        Position memory p = positions[id];
        if (!p.active) revert Inactive();
        if (!isFilled(id)) revert NotFilled();
        _checkHold(id);
        (quoteOut, tokenOut) = _remove(id, p);
        emit Filled(id, p.owner, p.token, p.tickLower, p.tickUpper, quoteOut, tokenOut, msg.sender);
    }

    /// @notice Owner collects accrued donation fees without touching principal.
    function claimFees(uint256 id) external nonReentrant returns (uint256 quoteFees, uint256 tokenFees) {
        Position memory p = positions[id];
        if (!p.active) revert Inactive();
        if (p.owner != msg.sender) revert NotOwner();
        (quoteFees, tokenFees) = _modify(id, p, Op.Poke, 0);
        emit FeesClaimed(id, p.owner, p.token, quoteFees, tokenFees);
    }

    function _forfeitTo() internal view returns (address t) {
        t = lockedLP.treasury();
        if (t == address(0)) t = owner;
    }

    function _checkHold(uint256 id) internal view {
        uint256 u = unlockAt(id);
        if (block.timestamp < u) revert HoldActive(u);
    }

    function _remove(uint256 id, Position memory p) internal returns (uint256 quoteOut, uint256 tokenOut) {
        positions[id].active = false; // effects before interaction
        positions[id].liquidity = 0;
        (quoteOut, tokenOut) = _modify(id, p, Op.Remove, -int256(uint256(p.liquidity)));
    }

    function _modify(uint256 id, Position memory p, Op op, int256 liqDelta)
        internal
        returns (uint256 quoteOut, uint256 tokenOut)
    {
        PoolKey memory key = poolKeyOf(p.token);
        bytes memory res = poolManager.unlock(
            abi.encode(
                CallbackData({
                    op: op,
                    key: key,
                    tickLower: p.tickLower,
                    tickUpper: p.tickUpper,
                    liquidityDelta: liqDelta,
                    salt: bytes32(id),
                    payer: address(0),
                    recipient: p.owner,
                    vestBps: vestedBps(id),
                    forfeitTo: _forfeitTo()
                })
            )
        );
        (uint256 a0, uint256 a1, uint256 f0, uint256 f1) = abi.decode(res, (uint256, uint256, uint256, uint256));
        bool tIs0 = Currency.unwrap(key.currency0) == p.token;
        (quoteOut, tokenOut) = tIs0 ? (a1, a0) : (a0, a1);
        if (f0 | f1 != 0) {
            (uint256 fq, uint256 ft) = tIs0 ? (f1, f0) : (f0, f1);
            emit FeesForfeited(id, _forfeitTo(), fq, ft);
        }
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        CallbackData memory d = abi.decode(raw, (CallbackData));
        (BalanceDelta delta, BalanceDelta fees) = poolManager.modifyLiquidity(
            d.key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: d.tickLower, tickUpper: d.tickUpper, liquidityDelta: d.liquidityDelta, salt: d.salt
            }),
            ""
        );
        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();
        if (d.op == Op.Add) {
            if (d0 < 0) d.key.currency0.settle(poolManager, d.payer, uint256(uint128(-d0)), false);
            if (d1 < 0) d.key.currency1.settle(poolManager, d.payer, uint256(uint128(-d1)), false);
            return abi.encode(uint256(0), uint256(0));
        }
        uint256 a0 = d0 > 0 ? uint256(uint128(d0)) : 0;
        uint256 a1 = d1 > 0 ? uint256(uint128(d1)) : 0;
        // SEC-02: withhold the unvested part of the accrued fees (fees are included in the caller delta).
        uint256 f0;
        uint256 f1;
        if (d.vestBps < 10_000 && d.forfeitTo != address(0)) {
            f0 = _unvested(fees.amount0(), d.vestBps, a0);
            f1 = _unvested(fees.amount1(), d.vestBps, a1);
            a0 -= f0;
            a1 -= f1;
            if (f0 > 0) d.key.currency0.take(poolManager, d.forfeitTo, f0, false);
            if (f1 > 0) d.key.currency1.take(poolManager, d.forfeitTo, f1, false);
        }
        if (a0 > 0) d.key.currency0.take(poolManager, d.recipient, a0, false);
        if (a1 > 0) d.key.currency1.take(poolManager, d.recipient, a1, false);
        return abi.encode(a0, a1, f0, f1);
    }

    function _unvested(int128 fee, uint256 vestBps, uint256 cap) private pure returns (uint256 u) {
        if (fee <= 0) return 0;
        uint256 f = uint256(uint128(fee));
        u = f - f * vestBps / 10_000;
        if (u > cap) u = cap;
    }
}
