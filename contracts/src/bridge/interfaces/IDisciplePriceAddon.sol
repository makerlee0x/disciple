// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Optional price add-on
/// @notice A separate contract may implement this. DiscipleHook does not store its address, does not
///         call it, and does not read a return value from it. An add-on that wants the hook to use a
///         price puts that price into a same-chain v2, v3, or v4 pool, then calls `poke` on the hook.
///         The hook only accepts the three same-chain reads. This file is the extension point.
interface IDisciplePriceAddon {
    /// @dev The add-on's own refresh. The hook never calls this.
    function refresh(bytes32 poolId) external;
}
