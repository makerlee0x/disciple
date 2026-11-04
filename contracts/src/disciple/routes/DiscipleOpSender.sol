// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {DiscipleSourceReader} from "./DiscipleSourceReader.sol";

/// @notice OP Stack deposit entry on Ethereum (Base's OptimismPortal).
interface IOptimismPortal {
    function depositTransaction(address to, uint256 value, uint64 gasLimit, bool isCreation, bytes calldata data)
        external
        payable;
}

/// @title DiscipleOpSender
/// @notice Route: Ethereum -> an OP Stack rollup (Base), through the rollup's own OptimismPortal deposit. Deploy one
///         per rollup. Anyone calls `push`; it reads the source itself. The rollup delivers the call from this
///         contract's aliased address (same alias offset as Arbitrum), which the hook checks. L2 gas is bought by
///         burning L1 gas inside the portal, so the call carries no ETH. Typically lands in 1-3 minutes.
///         Keeper cost estimate: PUSH_GAS * basefee (includes a typical portal gas burn for `gasLimit` <= 300k).
contract DiscipleOpSender is DiscipleSourceReader {
    uint256 public constant PUSH_GAS = 200_000;
    uint64 public constant MAX_L2_GAS = 1_000_000;

    IOptimismPortal public immutable portal;

    event Pushed(address indexed hook, PoolId indexed id, uint256 a, uint256 b, address keeper);

    constructor(IOptimismPortal portal_) {
        portal = portal_;
    }

    function push(address hook, PoolId id, uint8 kind, address target, bytes32 v4Id, uint64 gasLimit) external {
        if (gasLimit > MAX_L2_GAS) gasLimit = MAX_L2_GAS;
        (uint256 a, uint256 b) = read(kind, target, v4Id);
        portal.depositTransaction(
            hook, 0, gasLimit, false, _payload(id, kind, target, v4Id, a, b, PUSH_GAS * block.basefee)
        );
        emit Pushed(hook, id, a, b, msg.sender);
    }
}
