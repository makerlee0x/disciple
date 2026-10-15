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

/// @title Post-grad 1% trade-fee hook (§3 / LOCKED #11)
/// @notice Pool LP fee is 0; this hook takes 1% of swap output and routes via FeeRouter (33/33/33/1).
/// @dev Must be mined to an address with AFTER_SWAP_FLAG | AFTER_SWAP_RETURNS_DELTA_FLAG.
contract DiscipleHook is IHooks {
    using PoolIdLibrary for PoolKey;
    using SafeCast for uint256;
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;
    IFeeRouter public immutable feeRouter;

    struct PoolMeta {
        address token;
        address quote;
        address creator;
        bool registered;
    }

    mapping(PoolId => PoolMeta) public metaOf;

    address public migration;

    error OnlyPoolManager();
    error OnlyMigration();
    error HookNotImplemented();
    error NotRegistered();

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        _;
    }

    constructor(IPoolManager poolManager_, IFeeRouter feeRouter_, address migration_) {
        poolManager = poolManager_;
        feeRouter = feeRouter_;
        migration = migration_;
        Hooks.validateHookPermissions(this, getHookPermissions());
    }

    function setMigration(address m) external {
        // one-time wire if constructed with address(0)
        require(migration == address(0) || msg.sender == migration, "DiscipleHook: mig");
        migration = m;
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: false,
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
    function registerPool(PoolKey calldata key, address token, address quote, address creator) external {
        if (msg.sender != migration) revert OnlyMigration();
        metaOf[key.toId()] = PoolMeta({token: token, quote: quote, creator: creator, registered: true});
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        PoolMeta memory m = metaOf[key.toId()];
        if (!m.registered) revert NotRegistered();

        // Fee on unspecified (output) token — same pattern as FeeTakingHook
        bool specifiedTokenIs0 = (params.amountSpecified < 0 == params.zeroForOne);
        (Currency feeCurrency, int128 swapAmount) =
            specifiedTokenIs0 ? (key.currency1, delta.amount1()) : (key.currency0, delta.amount0());
        if (swapAmount < 0) swapAmount = -swapAmount;

        uint256 feeAmount = uint256(uint128(swapAmount)) * Constants.TRADE_FEE_BPS / Constants.BPS_DENOM;
        if (feeAmount == 0) return (IHooks.afterSwap.selector, 0);

        address feeToken = Currency.unwrap(feeCurrency);
        poolManager.take(feeCurrency, address(this), feeAmount);

        // Route only when fee is in the quote asset (typical); if fee is in launch token, send to treasury path via FeeRouter still
        IERC20(feeToken).safeTransfer(address(feeRouter), feeAmount);
        // For FeeRouter.routeTradeFee the `quote` param is the fee asset being split
        feeRouter.routeTradeFee(m.token, feeToken, sender, m.creator, feeAmount, 0);

        return (IHooks.afterSwap.selector, feeAmount.toInt128());
    }

    // ── unused hooks revert ──────────────────────────────────────────────────
    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        revert HookNotImplemented();
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

    function beforeAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
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

    function beforeSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, bytes calldata)
        external
        pure
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
