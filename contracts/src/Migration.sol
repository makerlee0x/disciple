// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IMigration} from "./interfaces/IMigration.sol";
import {LockedLP} from "./LockedLP.sol";
import {DiscipleHook} from "./DiscipleHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

/// @title Atomic migrate to locked Uniswap v4 (§2 / LOCKED #5, #17) — LOCKED 2026-10-15
/// @notice Same-tx: initialize pool at curve-end sqrtPriceX96 (no jump), seed full-range LP into LockedLP.
/// @dev Fee design: pool LP fee = 0; DiscipleHook takes 1% on swaps → FeeRouter 33/33/33/1.
///      Justification: one fee path matching curve-era routing; avoids stacking pool+hook fees;
///      LockedLP holds depth forever; LOCKED #16 LP-fee→treasury is N/A with 0 pool fee.
contract Migration is IMigration {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    /// @dev 0 pool fee — trade fee via hook
    uint24 public constant POOL_FEE = 0;
    int24 public constant TICK_SPACING = 60;

    LockedLP public immutable lockedLP;
    IPoolManager public immutable poolManager;
    DiscipleHook public immutable hook;
    address public owner;

    mapping(address => bool) public override isGraduated;
    mapping(address => bytes32) public override poolIdOf;
    mapping(address => address) public creatorOf; // token => creator (set by launchpad/curve via migrate caller context)

    error OnlyOwner();
    error AlreadyGraduated();
    error ZeroLiquidity();

    event Migrated(
        address indexed token,
        address indexed quote,
        bytes32 poolId,
        uint256 tokenAmount,
        uint256 quoteAmount,
        uint160 sqrtPriceX96
    );

    constructor(address owner_, address lockedLP_, address poolManager_, address hook_) {
        owner = owner_;
        lockedLP = LockedLP(lockedLP_);
        poolManager = IPoolManager(poolManager_);
        hook = DiscipleHook(hook_);
    }

    /// @inheritdoc IMigration
    function migrate(address token, address quote, uint256 tokenAmount, uint256 quoteAmount, uint160 sqrtPriceX96)
        external
        override
        returns (bytes32 poolId)
    {
        if (isGraduated[token]) revert AlreadyGraduated();
        if (tokenAmount == 0 || quoteAmount == 0) revert ZeroLiquidity();

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokenAmount);
        IERC20(quote).safeTransferFrom(msg.sender, address(this), quoteAmount);

        // Fold in any curve-phase escrow already on LockedLP by adding fresh amounts then seeding
        IERC20(token).forceApprove(address(lockedLP), tokenAmount);
        IERC20(quote).forceApprove(address(lockedLP), quoteAmount);
        lockedLP.addLockedLiquidity(token, quote, tokenAmount, quoteAmount);

        // Currency order: currency0 < currency1
        bool tokenIsC0 = uint160(token) < uint160(quote);
        Currency currency0 = Currency.wrap(tokenIsC0 ? token : quote);
        Currency currency1 = Currency.wrap(tokenIsC0 ? quote : token);

        PoolKey memory key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        uint256 amount0 = tokenIsC0 ? tokenAmount : quoteAmount;
        uint256 amount1 = tokenIsC0 ? quoteAmount : tokenAmount;

        // Also include escrowed quote from fee LP-lock during curve
        (,,,, uint256 escrow,,) = lockedLP.positions(token);
        if (escrow > 0) {
            if (tokenIsC0) {
                amount1 += escrow;
            } else {
                amount0 += escrow;
            }
        }

        bytes32 salt = bytes32(uint256(uint160(token)));
        lockedLP.seedV4Position(token, quote, key, sqrtPriceX96, amount0, amount1, salt);

        // Register for hook fee routing — creator = tx.origin is weak; use BondingCurve.creator via msg.sender if curve
        address creator = _creatorFromCurve(msg.sender);
        hook.registerPool(key, token, quote, creator, _quotePriceFromCurve(msg.sender));

        PoolId id = key.toId();
        poolId = PoolId.unwrap(id);
        isGraduated[token] = true;
        poolIdOf[token] = poolId;

        emit Migrated(token, quote, poolId, tokenAmount, quoteAmount, sqrtPriceX96);
    }

    function _quotePriceFromCurve(address curve) internal view returns (uint256) {
        (bool ok, bytes memory data) = curve.staticcall(abi.encodeWithSignature("quotePriceUsd()"));
        if (ok && data.length >= 32) return abi.decode(data, (uint256));
        return 0;
    }

    function _creatorFromCurve(address curve) internal view returns (address) {
        // BondingCurve exposes immutable creator
        (bool ok, bytes memory data) = curve.staticcall(abi.encodeWithSignature("creator()"));
        if (ok && data.length >= 32) return abi.decode(data, (address));
        return curve;
    }
}
