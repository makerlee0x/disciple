// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IQuotePricer} from "./interfaces/IQuotePricer.sol";

/// @title Launch-time quote/USD oracle (USDG = $1, others via a registered quote/USDG v4 pool spot)
/// @notice Curve mcap targets ($7K / $33K) are USD. At launch the Launchpad asks this contract for the
///         quote's USD price exactly once and bakes it into the curve geometry (immutable thereafter).
/// @dev Trust assumptions (documented in README):
///      - USDG is treated as exactly $1 (no depeg handling).
///      - Non-USDG quotes are priced from the *spot* sqrtPriceX96 of an owner-registered quote/USDG v4 pool.
///        Spot is manipulable within one block; a launcher who skews it only mis-scales their own curve
///        (USD tiers/graduation threshold), funds are never at risk. `minLiquidity` raises the cost.
///      - Owner (multisig) chooses which pool is canonical for each quote. No pool → launch reverts.
contract QuotePricer is IQuotePricer {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager public immutable poolManager;
    address public immutable usdg;
    uint8 public immutable usdgDecimals;
    address public owner;
    /// @notice Minimum in-range liquidity of a reference pool at pricing time.
    uint128 public minLiquidity;

    mapping(address => PoolKey) internal _poolOf;
    mapping(address => bool) public hasPricePool;

    error OnlyOwner();
    error NoPricePool(address quote);
    error BadPool();
    error ThinPool(uint128 liquidity);
    error ZeroPrice();

    event PricePoolSet(address indexed quote, bytes32 indexed poolId, uint24 fee, int24 tickSpacing, address hooks);
    event PricePoolCleared(address indexed quote);
    event MinLiquiditySet(uint128 minLiquidity);
    event OwnerTransferred(address indexed owner);

    constructor(address owner_, IPoolManager poolManager_, address usdg_) {
        owner = owner_;
        poolManager = poolManager_;
        usdg = usdg_;
        usdgDecimals = IERC20Metadata(usdg_).decimals();
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    function transferOwnership(address o) external onlyOwner {
        owner = o;
        emit OwnerTransferred(o);
    }

    function setMinLiquidity(uint128 l) external onlyOwner {
        minLiquidity = l;
        emit MinLiquiditySet(l);
    }

    /// @notice Register the canonical quote/USDG v4 pool for `quote`. Pool must exist (initialized).
    function setPricePool(address quote, PoolKey calldata key) external onlyOwner {
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        if (quote == usdg || !((c0 == quote && c1 == usdg) || (c0 == usdg && c1 == quote))) revert BadPool();
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        if (sqrtP == 0) revert BadPool();
        _poolOf[quote] = key;
        hasPricePool[quote] = true;
        emit PricePoolSet(quote, PoolId.unwrap(key.toId()), key.fee, key.tickSpacing, address(key.hooks));
    }

    function clearPricePool(address quote) external onlyOwner {
        delete _poolOf[quote];
        hasPricePool[quote] = false;
        emit PricePoolCleared(quote);
    }

    function pricePoolOf(address quote) external view returns (PoolKey memory) {
        return _poolOf[quote];
    }

    /// @inheritdoc IQuotePricer
    function quotePriceUsd(address quote) external view override returns (uint256 p) {
        // USD WAD per 1e18 raw units: usdg raw unit = 10^-dec USD → 1e18 raw = 1e(36-dec) USD WAD
        uint256 usdgScale = 10 ** (36 - uint256(usdgDecimals));
        if (quote == usdg) return usdgScale;
        if (!hasPricePool[quote]) revert NoPricePool(quote);

        PoolKey memory key = _poolOf[quote];
        PoolId id = key.toId();
        (uint160 sqrtP,,,) = poolManager.getSlot0(id);
        if (sqrtP == 0) revert BadPool();
        uint128 liq = poolManager.getLiquidity(id);
        if (liq < minLiquidity || liq == 0) revert ThinPool(liq);

        // priceX128 = currency1 raw per currency0 raw, X128
        uint256 priceX128 = Math.mulDiv(sqrtP, sqrtP, 1 << 64);
        if (Currency.unwrap(key.currency0) == quote) {
            // usdg raw per quote raw = priceX128 / 2^128
            p = Math.mulDiv(priceX128, usdgScale, 1 << 128);
        } else {
            // usdg raw per quote raw = 2^128 / priceX128
            p = Math.mulDiv(1 << 128, usdgScale, priceX128);
        }
        if (p == 0) revert ZeroPrice();
    }
}
