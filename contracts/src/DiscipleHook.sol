// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";
import {Constants} from "./libraries/Constants.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IQuotePricer} from "./interfaces/IQuotePricer.sol";
import {McapMath} from "./libraries/McapMath.sol";

interface IMigrationLockedLP {
    function lockedLP() external view returns (address);
}

/// @title Post-grad 1% trade-fee hook (§3 / LOCKED #11)
/// @notice Pool LP fee is 0. This hook does two things and nothing else:
///         1. beforeInitialize: only LockedLP (via Migration at graduation) may create a pool on this hook, so nobody
///            can pre-create a DISCIPLE pool at a bad price.
///         2. afterSwap: takes 1% of the swap's unspecified (output-side) amount and sends it to FeeRouter
///            (33/33/33/1). This is the standard v4 fee-taking-hook pattern (afterSwapReturnDelta).
///         No beforeSwap, no liquidity gate, no price tracking, no compounding and no events: trades, prices and
///         market caps are read off-chain from the PoolManager's own Swap event. LP compounding is a separate,
///         keeper-run LockedLP.flush outside swaps.
/// @dev Must be mined to an address with BEFORE_INITIALIZE_FLAG | AFTER_SWAP_FLAG | AFTER_SWAP_RETURNS_DELTA_FLAG.
///      The view helpers below (metaOf, quoteUsdOf, mcapUsdFromSqrt, impactBpsFromSqrt) are read by DiscipleRouter
///      quotes and MarketLens only; none of them runs on the swap path.
contract DiscipleHook is IHooks {
    using PoolIdLibrary for PoolKey;
    using SafeCast for uint256;

    IPoolManager public immutable poolManager;
    IFeeRouter public immutable feeRouter;

    struct PoolMeta {
        address token;
        address quote;
        address creator;
        bool registered;
        uint256 quotePriceUsd; // launch-time USD WAD per 1e18 raw quote (quoteUsdOf fallback)
    }

    mapping(PoolId => PoolMeta) public metaOf;

    address public admin;
    address public migration;
    /// @notice Live quote/USD oracle, read only by the view `quoteUsdOf`. Never called during a swap.
    IQuotePricer public pricer;

    event AdminTransferred(address indexed admin);

    error OnlyPoolManager();
    error OnlyMigration();
    error HookNotImplemented();
    error NotRegistered();
    error OnlyAdmin();
    error OnlyLockedLP();

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
        require(migration == address(0) && m.code.length != 0, "DiscipleHook: mig"); // F-L11: contract only
        migration = m;
    }

    function setPricer(address p) external {
        if (msg.sender != admin) revert OnlyAdmin();
        pricer = IQuotePricer(p);
    }

    function transferAdmin(address a) external {
        if (msg.sender != admin) revert OnlyAdmin();
        require(a != address(0), "DiscipleHook: admin"); // F-I4
        admin = a;
        emit AdminTransferred(a);
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
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

    /// @notice Called by Migration at graduation to bind pool → token/quote/creator (fee routing + view helpers).
    function registerPool(PoolKey calldata key, address token, address quote, address creator, uint256 quotePriceUsd)
        external
    {
        if (msg.sender != migration) revert OnlyMigration();
        metaOf[key.toId()] =
            PoolMeta({token: token, quote: quote, creator: creator, registered: true, quotePriceUsd: quotePriceUsd});
    }

    /// @dev Only LockedLP (seeding at graduation, called by Migration) may initialize.
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

    /// @dev 1% of the unspecified (output for exact-in) amount, taken by the PoolManager straight to FeeRouter and
    ///      returned as the hook delta, so the swapper's BalanceDelta already shows the net amount.
    function afterSwap(
        address sender,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        PoolMeta memory m = metaOf[key.toId()];
        if (!m.registered) revert NotRegistered();

        bool specifiedTokenIs0 = (params.amountSpecified < 0 == params.zeroForOne);
        (Currency feeCurrency, int128 swapAmount) =
            specifiedTokenIs0 ? (key.currency1, delta.amount1()) : (key.currency0, delta.amount0());
        if (swapAmount < 0) swapAmount = -swapAmount;

        uint256 feeAmount = uint256(uint128(swapAmount)) * Constants.TRADE_FEE_BPS / Constants.BPS_DENOM;
        if (feeAmount > 0) {
            poolManager.take(feeCurrency, address(feeRouter), feeAmount);
            // `sender` is the contract that called PoolManager.swap (DiscipleRouter for site trades). Referral
            // credit is not taken from hookData; the referral slice goes to FeeRouter's referral sink.
            feeRouter.routeHookFee(m.token, Currency.unwrap(feeCurrency), sender, m.creator, feeAmount);
        }
        return (IHooks.afterSwap.selector, feeAmount.toInt128());
    }

    // ── views (not on the swap path) ────────────────────────────────────────

    /// @notice Live quote/USD price (falls back to launch-time). DiscipleRouter.quoteExactIn's mcapAfterUsd uses it.
    function quoteUsdOf(PoolId id) external view returns (uint256) {
        PoolMeta memory m = metaOf[id];
        if (address(pricer) != address(0)) {
            try pricer.quotePriceUsd(m.quote) returns (uint256 p) {
                if (p > 0) return p;
            } catch {}
        }
        return m.quotePriceUsd;
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

    // ── unused hooks revert ──────────────────────────────────────────────────
    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
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

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
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
