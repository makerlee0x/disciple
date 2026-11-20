// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Token} from "./Token.sol";

/// @title Coin factory for Launchpad (maker 2026-11-19 EIP-170, 2026-11-20 clones)
/// @notice Launchpad creates this in its own constructor. It deploys one Token implementation and gives every coin an
///         EIP-1167 clone of it (about 45 bytes), so a launch no longer pays to deploy the full token code. Only that
///         Launchpad may create coins; the Launchpad is the coin's `launchpad` and mint recipient.
contract TokenDeployer {
    address public immutable launchpad;
    address public immutable implementation;

    error OnlyLaunchpad();

    constructor(address poolManager_, address lockedLP_) {
        launchpad = msg.sender;
        implementation = address(new Token(msg.sender, poolManager_, lockedLP_));
    }

    function deploy(string calldata name_, string calldata symbol_, address creator_, bool pveHooks_)
        external
        returns (address token)
    {
        address lp = launchpad;
        if (msg.sender != lp) revert OnlyLaunchpad();
        token = Clones.clone(implementation);
        Token(token).initialize(name_, symbol_, creator_, lp, pveHooks_);
    }
}
