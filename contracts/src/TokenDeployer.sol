// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Token} from "./Token.sol";

/// @title Token code holder for Launchpad (EIP-170, maker 2026-11-19)
/// @notice Launchpad creates this in its own constructor so the Token creation code lives here instead of in
///         Launchpad's runtime code. Only that Launchpad may deploy tokens; the Token is unchanged (same args, same
///         `launchpad` pointer and mint recipient), only the creating address differs.
contract TokenDeployer {
    address public immutable launchpad;

    error OnlyLaunchpad();

    constructor() {
        launchpad = msg.sender;
    }

    function deploy(
        string calldata name_,
        string calldata symbol_,
        address creator_,
        bool pveHooks_,
        address poolManager_,
        address lockedLP_
    ) external returns (address) {
        address lp = launchpad;
        if (msg.sender != lp) revert OnlyLaunchpad();
        return address(new Token(name_, symbol_, creator_, lp, lp, pveHooks_, poolManager_, lockedLP_));
    }
}
