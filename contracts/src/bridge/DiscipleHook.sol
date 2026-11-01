// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BridgeCurve} from "./libraries/BridgeCurve.sol";
import {BridgeStorage} from "./BridgeStorage.sol";
import {DiscipleBook} from "./DiscipleBook.sol";
import {DiscipleLp} from "./DiscipleLp.sol";
import {DiscipleMath} from "./DiscipleMath.sol";
import {DiscipleAnchor} from "./DiscipleAnchor.sol";

/// @title DiscipleHook
/// @notice One Uniswap v4 hook. It holds every pool's state and every token. PoolManager calls this
///         contract only. Curve math and price reads live in `DiscipleMath` and `DiscipleAnchor`,
///         and the state machine lives in `DiscipleBook`. Those are linked libraries: fixed addresses
///         in this bytecode, no setter, no proxy, no replacement. The hook accepts no ETH.
contract DiscipleHook is IHooks {
    IPoolManager public immutable poolManager;
    address public immutable usdg;
    uint8 public immutable usdgDec;
    address public immutable v2Factory;
    address public immutable v3Factory;

    constructor(IPoolManager manager_, address usdg_, uint8 usdgDec_, address v2Factory_, address v3Factory_) {
        if (address(manager_) == address(0) || usdg_ == address(0) || usdgDec_ > 18) revert BridgeStorage.BadCreate();
        poolManager = manager_;
        usdg = usdg_;
        usdgDec = usdgDec_;
        v2Factory = v2Factory_;
        v3Factory = v3Factory_;
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    /// @dev Linked library addresses. They are code, not storage, and cannot change.
    function mathLibrary() external pure returns (address) {
        return address(DiscipleMath);
    }

    function anchorLibrary() external pure returns (address) {
        return address(DiscipleAnchor);
    }

    function bookLibrary() external pure returns (address) {
        return address(DiscipleBook);
    }

    function lpLibrary() external pure returns (address) {
        return address(DiscipleLp);
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeAddLiquidity = true;
        p.beforeRemoveLiquidity = true;
        p.beforeSwap = true;
        p.beforeSwapReturnDelta = true;
    }

    function createPool(BridgeStorage.CreateParams calldata c) external returns (PoolKey memory, PoolId) {
        return DiscipleBook.createPool(_env(), c);
    }

    function deposit(PoolId id, uint256 coinRaw, uint256 usdgRaw) external returns (uint256) {
        return DiscipleLp.deposit(_env(), id, coinRaw, usdgRaw);
    }

    function redeem(PoolId id, uint256 shares) external returns (uint256, uint256) {
        return DiscipleLp.redeem(_env(), id, shares);
    }

    function claimCreatorFees(PoolId id) external returns (uint256) {
        return DiscipleLp.claimCreatorFees(_env(), id);
    }

    function poke(PoolId id) external {
        DiscipleBook.poke(_env(), id);
    }

    /// @dev The current creator recipient only. No admin. `next` must be non-zero.
    function transferCreator(PoolId id, address next) external {
        DiscipleBook.transferCreator(id, next);
    }

    /// @dev First call records `seenAt`. A later call does not move it. v2 and v4 creates read this.
    function witnessSource(bytes32 key) external {
        DiscipleBook.witnessSource(key);
    }

    function sourceKey(uint8 kind, address ref, bytes32 refId) external pure returns (bytes32) {
        return DiscipleBook.sourceKey(kind, ref, refId);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert BridgeStorage.OnlyPoolManager();
        uint8 op = abi.decode(data, (uint8));
        if (op == BridgeStorage.OP_SEED) return DiscipleBook.onSeed(_env(), data);
        if (op == BridgeStorage.OP_DEPOSIT) return DiscipleLp.onDeposit(_env(), data);
        if (op == BridgeStorage.OP_REDEEM) return DiscipleLp.onRedeem(_env(), data);
        if (op == BridgeStorage.OP_CLAIM) return DiscipleLp.onClaim(_env(), data);
        revert BridgeStorage.HookNotImplemented();
    }

    function spotPrice(PoolId id) external view returns (uint256) {
        return DiscipleBook.spotPrice(_env(), id);
    }

    function liveAnchor(PoolId id) external view returns (uint256, uint256) {
        return DiscipleBook.liveAnchor(_env(), id);
    }

    function dutchQuote(PoolId id) external view returns (uint256, uint256, uint256, uint256, uint256, uint256) {
        return DiscipleLp.dutchQuote(_env(), id);
    }

    function referenceTvl(PoolId id) external view returns (uint256) {
        return BridgeStorage.layout().pools[id].ethTvl;
    }

    function dutchState(PoolId id) external view returns (uint256 bidGap, uint256 askGap, uint64 dutchAt) {
        BridgeStorage.Pool storage p = BridgeStorage.layout().pools[id];
        if (!p.exists) revert BridgeStorage.UnknownPool();
        (bidGap, askGap) = DiscipleBook.accruedGaps(id);
        dutchAt = p.dutchAt;
    }

    function floorState(PoolId id) external view returns (uint256, uint256) {
        return DiscipleBook.floorState(id);
    }

    function smoothedReference(PoolId id) external view returns (uint256) {
        return BridgeStorage.layout().pools[id].smoothedTvl;
    }

    function feeCredit(PoolId id, address user) external view returns (uint256) {
        return BridgeStorage.layout().feeCreditOf[id][user];
    }

    function bridgeQuote(PoolId id) external view returns (BridgeStorage.BridgeQuote memory) {
        return DiscipleLp.bridgeQuote(_env(), id);
    }

    function quoteExactIn(PoolKey calldata key, bool zeroForOne, uint256 amountIn)
        external
        view
        returns (uint256, uint256, bool, uint256)
    {
        return DiscipleLp.quoteExactIn(_env(), key, zeroForOne, amountIn);
    }

    function curve(PoolId id) external view returns (BridgeCurve.S memory) {
        return DiscipleBook.curve(_env(), id);
    }

    function creatorFees(PoolId id) external view returns (uint256) {
        return BridgeStorage.layout().pools[id].creatorAccrued;
    }

    function pendingFee(PoolId id, address user) external view returns (uint256) {
        return DiscipleLp.pendingFee(id, user);
    }

    function feeIndex(PoolId id) external view returns (uint256) {
        return BridgeStorage.layout().pools[id].feeIndex;
    }

    function usdgHeld(PoolId id) external view returns (uint256) {
        return BridgeStorage.layout().pools[id].usdgHeld;
    }

    function sharesOf(PoolId id, address user) external view returns (uint256) {
        return BridgeStorage.layout().sharesOf[id][user];
    }

    function usdgClaimsNorm() external view returns (uint256) {
        return BridgeStorage.layout().usdgClaimsNorm;
    }

    function anchorKind(PoolId id) external view returns (uint8) {
        return BridgeStorage.layout().pools[id].anchorKind;
    }

    function arbQuote(PoolId id) external view returns (BridgeStorage.ArbQuote memory) {
        return DiscipleLp.arbQuote(_env(), id);
    }

    function reserveOk(PoolId id) external view returns (bool) {
        return DiscipleBook.reserveOk(id);
    }

    function beforeInitialize(address, PoolKey calldata, uint160) external view returns (bytes4) {
        if (msg.sender != address(poolManager)) revert BridgeStorage.OnlyPoolManager();
        revert BridgeStorage.ExternalInit();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert BridgeStorage.HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert BridgeStorage.LiquidityDisabled();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert BridgeStorage.HookNotImplemented();
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert BridgeStorage.LiquidityDisabled();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert BridgeStorage.HookNotImplemented();
    }

    function beforeSwap(
        address sender,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        bytes calldata hookData
    ) external returns (bytes4, BeforeSwapDelta, uint24) {
        return DiscipleBook.beforeSwap(_env(), sender, key, params, hookData);
    }

    function afterSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, int128)
    {
        revert BridgeStorage.HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert BridgeStorage.HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert BridgeStorage.HookNotImplemented();
    }

    function _env() internal view returns (DiscipleBook.Env memory) {
        return DiscipleBook.Env({
            poolManager: poolManager, usdg: usdg, usdgDec: usdgDec, v2Factory: v2Factory, v3Factory: v3Factory
        });
    }
}
