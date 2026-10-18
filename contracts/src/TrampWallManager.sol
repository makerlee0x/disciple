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
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {CurrencySettler} from "./libraries/CurrencySettler.sol";
import {LockedLP} from "./LockedLP.sol";

/// @title Tramps & walls — single-sided concentrated LP orders in graduated DISCIPLE v4 pools
/// @notice "Price" below = quote per token.
///         Tramp = quote-only range strictly BELOW the current price (support: buys the dip, converts quote→token).
///         Wall  = token-only range strictly ABOVE the current price (resistance: sells into pumps, token→quote).
///         Positions are owned by this contract in the PoolManager (salt = id) and tracked per user here.
///         Pure limit orders: NO yield. The pool LP fee is 0 and the hook donates nothing, so positions earn
///         only their fill (the range price).
/// @dev No custody beyond the v4 position itself; only the owner can cancel (any time); `pull` is
///      permissionless once filled (immediately) and pays the owner minus the keeper tip.
///      Positions are strictly one-sided and behave like limit orders: a tramp (quote below price) is a floor that
///      buys the dip; a wall (token above price) sells into pumps. Once price has crossed the whole range the
///      order is filled and anyone may `pull` it: the owner gets the proceeds minus a small keeper tip
///      (`keeperTipBps`, default 10 = 0.1%, owner-settable up to MAX_KEEPER_TIP_BPS = 1%) paid to the caller,
///      so bots auto-close filled orders.
///      The hook only accepts LP adds from LockedLP and this contract (SEC-02 LP gate).
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

    address public owner;
    /// @notice Keeper tip on `pull`, bps of everything paid out . Default 0.1%.
    uint16 public keeperTipBps = 10;
    uint16 public constant MAX_KEEPER_TIP_BPS = 100;

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
    /// @notice Range fully crossed and removed via `pull`. Amounts are the owner's net (after keeper tip).
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
    /// @notice Owner removed the position. quoteFees/tokenFees are always 0 (kept for ABI stability).
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
    event KeeperTipSet(uint16 keeperTipBps);
    event OwnerTransferred(address indexed owner);
    /// @notice Tip paid to the `pull` caller (amounts are NOT included in Filled.quoteOut/tokenOut).
    event KeeperTipPaid(uint256 indexed id, address indexed keeper, uint256 quoteTip, uint256 tokenTip);

    enum Op {
        Add,
        Remove
    }

    struct CallbackData {
        Op op;
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        int256 liquidityDelta;
        bytes32 salt;
        address payer; // Add
        address recipient; // Remove
        uint256 tipBps; // Remove via pull: share of the payout sent to `keeper`
        address keeper;
    }

    constructor(IPoolManager poolManager_, LockedLP lockedLP_, address hook_) {
        poolManager = poolManager_;
        lockedLP = lockedLP_;
        hook = hook_;
        owner = msg.sender;
    }

    function setKeeperTipBps(uint16 bps) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (bps > MAX_KEEPER_TIP_BPS) revert BadParam();
        keeperTipBps = bps;
        emit KeeperTipSet(bps);
    }

    function transferOwnership(address o) external {
        if (msg.sender != owner) revert OnlyOwner();
        owner = o;
        emit OwnerTransferred(o);
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
        // Audit #6 / spec: a tramp or wall is exactly one tick spacing wide.
        if (tu - tl != key.tickSpacing) revert BadRange();

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
                    tipBps: 0,
                    keeper: address(0)
                })
            )
        );
    }

    // ───────────────────────────── remove ─────────────────────────────

    /// @notice Owner removes the position at any time; receives remaining principal (either/both assets).
    function cancel(uint256 id) external nonReentrant returns (uint256 quoteOut, uint256 tokenOut) {
        Position memory p = positions[id];
        if (!p.active) revert Inactive();
        if (p.owner != msg.sender) revert NotOwner();
        (quoteOut, tokenOut) = _remove(id, p, 0, address(0));
        // quoteFees/tokenFees kept for ABI stability; always 0 (no LP yield)
        emit Cancelled(id, p.owner, p.token, p.tickLower, p.tickUpper, quoteOut, tokenOut, 0, 0);
    }

    /// @notice Permissionless keeper: close a fully-crossed (filled) order. Owner receives the proceeds minus
    ///         `keeperTipBps`; the caller receives the tip. Returns the owner's amounts.
    function pull(uint256 id) external nonReentrant returns (uint256 quoteOut, uint256 tokenOut) {
        Position memory p = positions[id];
        if (!p.active) revert Inactive();
        if (!isFilled(id)) revert NotFilled();
        (quoteOut, tokenOut) = _remove(id, p, keeperTipBps, msg.sender);
        emit Filled(id, p.owner, p.token, p.tickLower, p.tickUpper, quoteOut, tokenOut, msg.sender);
    }

    function _remove(uint256 id, Position memory p, uint256 tipBps, address keeper)
        internal
        returns (uint256 quoteOut, uint256 tokenOut)
    {
        positions[id].active = false; // effects before interaction
        positions[id].liquidity = 0;
        (quoteOut, tokenOut) = _modify(id, p, Op.Remove, -int256(uint256(p.liquidity)), tipBps, keeper);
    }

    function _modify(uint256 id, Position memory p, Op op, int256 liqDelta, uint256 tipBps, address keeper)
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
                    tipBps: tipBps,
                    keeper: keeper
                })
            )
        );
        (uint256 a0, uint256 a1, uint256 f0, uint256 f1) = abi.decode(res, (uint256, uint256, uint256, uint256));
        bool tIs0 = Currency.unwrap(key.currency0) == p.token;
        (quoteOut, tokenOut) = tIs0 ? (a1, a0) : (a0, a1);
        if (f0 | f1 != 0) {
            (uint256 tq, uint256 tt) = tIs0 ? (f1, f0) : (f0, f1);
            emit KeeperTipPaid(id, keeper, tq, tt);
        }
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        CallbackData memory d = abi.decode(raw, (CallbackData));
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
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
        // Keeper tip on pull (bps of each asset paid out).
        uint256 f0;
        uint256 f1;
        if (d.tipBps > 0 && d.keeper != address(0)) {
            f0 = a0 * d.tipBps / 10_000;
            f1 = a1 * d.tipBps / 10_000;
            a0 -= f0;
            a1 -= f1;
            if (f0 > 0) d.key.currency0.take(poolManager, d.keeper, f0, false);
            if (f1 > 0) d.key.currency1.take(poolManager, d.keeper, f1, false);
        }
        if (a0 > 0) d.key.currency0.take(poolManager, d.recipient, a0, false);
        if (a1 > 0) d.key.currency1.take(poolManager, d.recipient, a1, false);
        return abi.encode(a0, a1, f0, f1);
    }
}
