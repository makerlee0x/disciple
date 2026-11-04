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

    /// @dev (1400 + 6 * dataLength) * baseFee (0 = this block's basefee).
    function calculateRetryableSubmissionFee(uint256 dataLength, uint256 baseFee) external view returns (uint256);
}

/// @title DiscipleBridgeSender
/// @notice Route: Ethereum -> an Arbitrum-stack rollup (Robinhood Chain, Arbitrum One), through the rollup's own
///         delayed inbox as a retryable ticket. Deploy one per rollup (its inbox is immutable). Anyone calls `push`;
///         it reads the source itself. No third-party bridge or verifier: the rollup delivers the message from this
///         contract's aliased address, which the hook checks.
///
///         The caller prepays the ticket (maxSubmissionCost + gasLimit * maxFeePerGas) and pays this transaction's
///         gas. The rollup refunds the unused part of the prepayment to the caller's address on the rollup
///         (excess submission fee and unused L2 gas; aliased if the caller is a contract). So the cost carried in
///         the message is only what is actually spent on this side: the real submission fee for this payload at
///         this basefee, plus PUSH_GAS * basefee. The hook adds the rollup-side execution (its BRIDGE_L2_GAS at the
///         rollup's basefee) and refunds the total * 1.2 (capped) from the pool's tank when the price moved 1% or
///         was a heartbeat. Basefee only, so a keeper cannot inflate the refund with priority fees or by
///         over-funding the ticket.
contract DiscipleBridgeSender is DiscipleSourceReader {
    /// @dev Approximate parent-chain gas of a push (read + inbox), used only for the refund estimate.
    uint256 public constant PUSH_GAS = 130_000;
    /// @dev Length of the onBridgePrice calldata (selector + 10 static words); fixed, so the fee is known up front.
    uint256 public constant DATA_LEN = 4 + 32 * 10;

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
        uint256 spent = inbox.calculateRetryableSubmissionFee(DATA_LEN, 0) + PUSH_GAS * block.basefee;
        bytes memory data = _payload(id, kind, target, v4Id, a, b, spent);
        ticket = inbox.createRetryableTicket{value: msg.value}(
            hook, 0, maxSubmissionCost, msg.sender, msg.sender, gasLimit, maxFeePerGas, data
        );
        emit Pushed(hook, id, ticket, a, b, msg.sender);
    }
}
