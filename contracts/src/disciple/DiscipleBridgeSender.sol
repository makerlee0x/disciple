// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

/// @notice Arbitrum-stack delayed inbox (Robinhood Chain's on Ethereum).
interface IInbox {
    function createRetryableTicket(
        address to,
        uint256 l2CallValue,
        uint256 maxSubmissionCost,
        address excessFeeRefundAddress,
        address callValueRefundAddress,
        uint256 gasLimit,
        uint256 maxFeePerGas,
        bytes calldata data
    ) external payable returns (uint256);
}

interface IDiscipleBridgeTarget {
    function onBridgePrice(
        PoolId id,
        uint8 kind,
        address target,
        bytes32 v4Id,
        uint256 a,
        uint256 b,
        uint64 observedAt,
        address keeper,
        uint256 keeperCost
    ) external;
}

/// @title DiscipleBridgeSender
/// @notice Lives on the parent chain (Ethereum). Anyone calls `push` for a Disciple pool on the rollup (Robinhood
///         Chain): it reads the source pool's state itself, in this transaction, and sends it through the rollup's
///         own delayed inbox as a retryable ticket. No price is ever supplied by the caller, and no third-party
///         bridge or verifier is involved: the rollup delivers it and the hook checks the sender's alias.
///
///         The caller pays the ticket (submission cost + L2 gas, quoted off-chain with the Arbitrum SDK) and this
///         transaction's gas. Their cost, `msg.value + PUSH_GAS * basefee`, travels with the message; the hook
///         refunds cost * 1.2 from the pool's tank on the rollup when the price moved 1% or was a heartbeat.
///         Priority fees are not refunded (basefee only), so a keeper cannot inflate the refund.
contract DiscipleBridgeSender {
    uint8 internal constant SRC_V2 = 1;
    uint8 internal constant SRC_V3 = 2;
    uint8 internal constant SRC_V4 = 3;
    /// @dev Approximate parent-chain gas of a push (read + inbox), used only for the refund estimate.
    uint256 public constant PUSH_GAS = 130_000;

    IInbox public immutable inbox;

    event Pushed(address indexed hook, PoolId indexed id, uint256 ticket, uint256 a, uint256 b, address keeper);

    error BadSource();

    constructor(IInbox inbox_) {
        inbox = inbox_;
    }

    /// @param hook The Disciple hook on the rollup. @param target v2 pair / v3 pool / v4 PoolManager (this chain).
    function push(
        address hook,
        PoolId id,
        uint8 kind,
        address target,
        bytes32 v4Id,
        uint256 maxSubmissionCost,
        uint256 gasLimit,
        uint256 maxFeePerGas
    ) external payable returns (uint256 ticket) {
        (uint256 a, uint256 b) = read(kind, target, v4Id);
        bytes memory data = abi.encodeCall(
            IDiscipleBridgeTarget.onBridgePrice,
            (id, kind, target, v4Id, a, b, uint64(block.timestamp), msg.sender, msg.value + PUSH_GAS * block.basefee)
        );
        ticket = inbox.createRetryableTicket{value: msg.value}(
            hook, 0, maxSubmissionCost, msg.sender, msg.sender, gasLimit, maxFeePerGas, data
        );
        emit Pushed(hook, id, ticket, a, b, msg.sender);
    }

    /// @notice Raw source state: v2 (reserve0, reserve1); v3 and v4 (sqrtPriceX96, liquidity).
    function read(uint8 kind, address target, bytes32 v4Id) public view returns (uint256 a, uint256 b) {
        if (kind == SRC_V2) {
            (bool ok, bytes memory r) = target.staticcall(abi.encodeWithSignature("getReserves()"));
            if (!ok || r.length < 64) revert BadSource();
            (a, b) = abi.decode(r, (uint256, uint256));
        } else if (kind == SRC_V3) {
            (bool ok, bytes memory r) = target.staticcall(abi.encodeWithSignature("slot0()"));
            if (!ok || r.length < 32) revert BadSource();
            a = abi.decode(r, (uint160));
            (ok, r) = target.staticcall(abi.encodeWithSignature("liquidity()"));
            if (!ok || r.length < 32) revert BadSource();
            b = abi.decode(r, (uint128));
        } else if (kind == SRC_V4) {
            (uint160 sqrtP,,,) = StateLibrary.getSlot0(IPoolManager(target), PoolId.wrap(v4Id));
            a = sqrtP;
            b = StateLibrary.getLiquidity(IPoolManager(target), PoolId.wrap(v4Id));
        } else {
            revert BadSource();
        }
        if (a == 0) revert BadSource();
    }
}
