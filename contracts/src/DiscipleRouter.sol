// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {CurrencySettler} from "./libraries/CurrencySettler.sol";
import {LockedLP} from "./LockedLP.sol";

/// @title Thin post-graduation router for DISCIPLE v4 pools (exact-in buy/sell)
/// @notice Pre-grad trades go to the token's BondingCurve directly; post-grad trades go here.
///         Users approve this router once per asset (or use the *WithPermit variants) — no custody.
///         For quotes use the official Uniswap V4Quoter (quoteExactInputSingle with the pool key from
///         `poolKeyOf(token)`); the DiscipleHook 1% fee is applied inside the simulated swap.
contract DiscipleRouter is IUnlockCallback {
    using CurrencySettler for Currency;

    IPoolManager public immutable poolManager;
    LockedLP public immutable lockedLP;
    address public immutable hook;

    error OnlyPoolManager();
    error Expired();
    error Slippage();
    error NotGraduated();
    error ZeroAmount();
    error ZeroRecipient();
    error QuoteResult(uint256 amountOut);

    struct CallbackData {
        address payer;
        address recipient;
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
        bool simulate;
    }

    constructor(IPoolManager poolManager_, LockedLP lockedLP_, address hook_) {
        poolManager = poolManager_;
        lockedLP = lockedLP_;
        hook = hook_;
    }

    /// @notice The graduated v4 pool key for `token` (reverts if not graduated).
    function poolKeyOf(address token) public view returns (PoolKey memory key) {
        key = lockedLP.getPoolKey(token);
        if (address(key.hooks) != hook || address(key.hooks) == address(0)) revert NotGraduated();
    }

    /// @notice Exact-in buy: spend `quoteIn` of the pool's quote asset for `token`, sent to `recipient`.
    function buyExactIn(address token, uint256 quoteIn, uint256 minTokensOut, address recipient, uint256 deadline)
        public
        returns (uint256 tokensOut)
    {
        PoolKey memory key = poolKeyOf(token);
        bool tokenIsC0 = Currency.unwrap(key.currency0) == token;
        // buying token: quote → token
        tokensOut = _swap(key, !tokenIsC0, quoteIn, minTokensOut, recipient, deadline);
    }

    /// @notice Exact-in sell: sell `tokensIn` of `token` for the quote asset, sent to `recipient`.
    function sellExactIn(address token, uint256 tokensIn, uint256 minQuoteOut, address recipient, uint256 deadline)
        public
        returns (uint256 quoteOut)
    {
        PoolKey memory key = poolKeyOf(token);
        bool tokenIsC0 = Currency.unwrap(key.currency0) == token;
        quoteOut = _swap(key, tokenIsC0, tokensIn, minQuoteOut, recipient, deadline);
    }

    /// @notice buyExactIn with an EIP-2612 permit on the quote asset (try/catch: front-run safe).
    function buyExactInWithPermit(
        address token,
        uint256 quoteIn,
        uint256 minTokensOut,
        address recipient,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256) {
        PoolKey memory key = poolKeyOf(token);
        address q =
            Currency.unwrap(key.currency0) == token ? Currency.unwrap(key.currency1) : Currency.unwrap(key.currency0);
        try IERC20Permit(q).permit(msg.sender, address(this), quoteIn, deadline, v, r, s) {} catch {}
        return buyExactIn(token, quoteIn, minTokensOut, recipient, deadline);
    }

    /// @notice sellExactIn with an EIP-2612 permit on the launch token.
    function sellExactInWithPermit(
        address token,
        uint256 tokensIn,
        uint256 minQuoteOut,
        address recipient,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256) {
        try IERC20Permit(token).permit(msg.sender, address(this), tokensIn, deadline, v, r, s) {} catch {}
        return sellExactIn(token, tokensIn, minQuoteOut, recipient, deadline);
    }

    /// @notice Exact-in quote incl. the 1% hook fee, by simulating the swap and reverting.
    /// @dev Not `view` (v4 has no view swaps) — call it with eth_call / viem `simulateContract`.
    function quoteExactIn(address token, bool isBuy, uint256 amountIn) external returns (uint256 amountOut) {
        PoolKey memory key = poolKeyOf(token);
        bool tokenIsC0 = Currency.unwrap(key.currency0) == token;
        bool zeroForOne = isBuy ? !tokenIsC0 : tokenIsC0;
        try poolManager.unlock(
            abi.encode(
                CallbackData({
                    payer: address(0),
                    recipient: address(0),
                    key: key,
                    zeroForOne: zeroForOne,
                    amountIn: amountIn,
                    simulate: true
                })
            )
        ) {
            revert();
        } catch (bytes memory reason) {
            if (reason.length != 36 || bytes4(reason) != QuoteResult.selector) {
                assembly ("memory-safe") {
                    revert(add(reason, 32), mload(reason))
                }
            }
            assembly ("memory-safe") {
                amountOut := mload(add(reason, 36))
            }
        }
    }

    function _swap(
        PoolKey memory key,
        bool zeroForOne,
        uint256 amountIn,
        uint256 minOut,
        address recipient,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert Expired();
        if (amountIn == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroRecipient();
        bytes memory res = poolManager.unlock(
            abi.encode(
                CallbackData({
                    payer: msg.sender,
                    recipient: recipient,
                    key: key,
                    zeroForOne: zeroForOne,
                    amountIn: amountIn,
                    simulate: false
                })
            )
        );
        amountOut = abi.decode(res, (uint256));
        if (amountOut < minOut) revert Slippage();
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        CallbackData memory d = abi.decode(raw, (CallbackData));

        BalanceDelta delta = poolManager.swap(
            d.key,
            IPoolManager.SwapParams({
                zeroForOne: d.zeroForOne,
                amountSpecified: -int256(d.amountIn),
                sqrtPriceLimitX96: d.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            abi.encode(d.payer) // hook attributes trade/referral to the real trader
        );

        (Currency cin, Currency cout) =
            d.zeroForOne ? (d.key.currency0, d.key.currency1) : (d.key.currency1, d.key.currency0);
        int128 dIn = d.zeroForOne ? delta.amount0() : delta.amount1();
        int128 dOut = d.zeroForOne ? delta.amount1() : delta.amount0();

        uint256 paid = uint256(uint128(-dIn));
        uint256 out = uint256(uint128(dOut));
        if (d.simulate) revert QuoteResult(out);
        cin.settle(poolManager, d.payer, paid, false);
        cout.take(poolManager, d.recipient, out, false);
        return abi.encode(out);
    }
}
