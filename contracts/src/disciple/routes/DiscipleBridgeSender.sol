// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {DiscipleSourceReader} from "./DiscipleSourceReader.sol";

/// @notice Arbitrum-stack delayed inbox (Robinhood Chain's and Arbitrum One's, on Ethereum).
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

/// @title DiscipleBridgeSender
/// @notice Route: Ethereum -> an Arbitrum-stack rollup (Robinhood Chain, Arbitrum One), through the rollup's own
///         delayed inbox as a retryable ticket. Deploy one per rollup (its inbox is immutable). Anyone calls `push`;
///         it reads the source itself. No third-party bridge or verifier: the rollup delivers the message from this
///         contract's aliased address, which the hook checks.
///
///         The caller pays the ticket (submission cost + L2 gas, quoted off-chain with the Arbitrum SDK) and this
///         transaction's gas. Their cost, `msg.value + PUSH_GAS * basefee`, travels with the message; the hook
///         refunds cost * 1.2 (capped) from the pool's tank when the price moved 1% or was a heartbeat. Basefee
///         only, so a keeper cannot inflate the refund with priority fees. Unused L2 gas is refunded by the rollup.
contract DiscipleBridgeSender is DiscipleSourceReader {
    /// @dev Approximate parent-chain gas of a push (read + inbox), used only for the refund estimate.
    uint256 public constant PUSH_GAS = 130_000;

    IInbox public immutable inbox;

    event Pushed(address indexed hook, PoolId indexed id, uint256 ticket, uint256 a, uint256 b, address keeper);

    constructor(IInbox inbox_) {
        inbox = inbox_;
    }

    /// @param hook The Disciple hook on the rollup.
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
        bytes memory data = _payload(id, kind, target, v4Id, a, b, msg.value + PUSH_GAS * block.basefee);
        ticket = inbox.createRetryableTicket{value: msg.value}(
            hook, 0, maxSubmissionCost, msg.sender, msg.sender, gasLimit, maxFeePerGas, data
        );
        emit Pushed(hook, id, ticket, a, b, msg.sender);
    }
}
