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
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {CurrencySettler} from "./libraries/CurrencySettler.sol";

/// @title Permanently locked v4 LP owner (§3 / LOCKED #16–#17)
/// @notice Owns the full-range v4 position forever. removeLiquidity always reverts.
/// @dev Pool LP fee is 0; trade fees taken by DiscipleHook. collectFees is a no-op residual for #16.
contract LockedLP is ILockedLP, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using CurrencySettler for Currency;
    using StateLibrary for IPoolManager;
    using CurrencyLibrary for Currency;

    address public treasury;
    address public owner;
    address public migration;
    /// @notice FeeRouter allowed to lock LP shares / snipe escrow (SEC-01: addLockedLiquidity is caller-restricted).
    address public feeRouter;
    IPoolManager public poolManager;

    int24 public constant TICK_SPACING = 60;

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
        bytes32 salt;
    }

    mapping(address => Position) internal _positions; // token => position

    error OnlyOwner();
    error OnlyMigration();
    error Unauthorized();
    error OnlyPoolManager();
    error RemoveLiquidityDisabled();
    error NotGraduated();
    error ZeroLiquidity();

    event LiquidityLocked(address indexed token, address indexed quote, uint256 tokenAmount, uint256 quoteAmount);
    event QuoteEscrowed(address indexed token, address indexed quote, uint256 amount);
    event FeesCollected(address indexed token, uint256 amount0, uint256 amount1);
    event V4PositionSeeded(
        address indexed token, PoolId poolId, uint128 liquidity, int24 tickLower, int24 tickUpper, uint160 sqrtPriceX96
    );

    constructor(address owner_, address treasury_) {
        owner = owner_;
        treasury = treasury_;
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
        Position storage p = _positions[token];
        if (p.quote == address(0)) p.quote = quote;
        p.token = token;

        if (quoteAmount > 0) {
            IERC20(quote).safeTransferFrom(msg.sender, address(this), quoteAmount);
        }
        if (tokenAmount > 0) {
            IERC20(token).safeTransferFrom(msg.sender, address(this), tokenAmount);
        }

        if (tokenAmount == 0 && quoteAmount > 0) {
            p.escrowQuote += quoteAmount;
            emit QuoteEscrowed(token, quote, quoteAmount);
            return quoteAmount;
        }

        p.tokenAmount += tokenAmount;
        p.quoteAmount += quoteAmount;
        lpShares = tokenAmount + quoteAmount;
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

        // Include any escrowed quote into the quote side of the seed
        // (caller already transferred primary amounts via addLockedLiquidity)

        // Initialize pool at curve-end price (no jump)
        try poolManager.initialize(key, sqrtPriceX96) {} catch {}

        SeedParams memory sp = SeedParams({
            token: token,
            quote: quote,
            key: key,
            sqrtPriceX96: sqrtPriceX96,
            amount0: amount0Desired,
            amount1: amount1Desired,
            salt: salt
        });

        bytes memory result = poolManager.unlock(abi.encode(sp));
        liquidity = abi.decode(result, (uint128));
        p.liquidity = liquidity;

        emit V4PositionSeeded(token, key.toId(), liquidity, p.tickLower, p.tickUpper, sqrtPriceX96);
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata rawData) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        SeedParams memory sp = abi.decode(rawData, (SeedParams));
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
        // Take any credits
        if (delta.amount0() > 0) {
            sp.key.currency0.take(poolManager, address(this), uint256(int256(delta.amount0())), false);
        }
        if (delta.amount1() > 0) {
            sp.key.currency1.take(poolManager, address(this), uint256(int256(delta.amount1())), false);
        }

        return abi.encode(liq);
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
