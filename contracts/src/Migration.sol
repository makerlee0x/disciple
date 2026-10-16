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

interface ILaunchpadRecord {
    function curveOf(address token) external view returns (address);
    function creatorOf(address token) external view returns (address);
}

interface ICurveRecord {
    function quote() external view returns (address);
    function creator() external view returns (address);
}

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
    /// @notice Launchpad registry: the only legitimate migrate caller is `launchpad.curveOf(token)` (audit #1).
    address public launchpad;

    mapping(address => bool) public override isGraduated;
    mapping(address => bytes32) public override poolIdOf;
    mapping(address => address) public creatorOf; // token => creator (set by launchpad/curve via migrate caller context)

    error OnlyOwner();
    error AlreadyGraduated();
    error ZeroLiquidity();
    error OnlyCurve();
    error QuoteMismatch();
    error LaunchpadAlreadySet();

    event LaunchpadSet(address indexed launchpad);

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

    /// @notice One-time wire of the Launchpad (deployed after Migration because Launchpad stores it immutably).
    function setLaunchpad(address launchpad_) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (launchpad != address(0)) revert LaunchpadAlreadySet();
        launchpad = launchpad_;
        emit LaunchpadSet(launchpad_);
    }

    /// @inheritdoc IMigration
    /// @dev Audit #1: only the token's registered bonding curve may migrate, with its own quote. Creator and
    ///      quote price are read from the curve / Launchpad record, never from caller-supplied data.
    function migrate(address token, address quote, uint256 tokenAmount, uint256 quoteAmount, uint160 sqrtPriceX96)
        external
        override
        returns (bytes32 poolId)
    {
        address lp = launchpad;
        if (lp == address(0) || msg.sender != ILaunchpadRecord(lp).curveOf(token)) revert OnlyCurve();
        if (quote != ICurveRecord(msg.sender).quote()) revert QuoteMismatch();
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

        // Creator from the Launchpad record (current creator), falling back to the curve's immutable creator.
        address creator = ILaunchpadRecord(lp).creatorOf(token);
        if (creator == address(0)) creator = ICurveRecord(msg.sender).creator();
        creatorOf[token] = creator;
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
}
