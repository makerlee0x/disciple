// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IQuoteProbe} from "./interfaces/IQuoteProbe.sol";

/// @title Minimal quote probe (§6 / LOCKED #31–#32)
/// @dev Always-pass list (STRATEGY/default, WETH, USDG). Hard-reject address(0).
///      Full honeypot/FoT simulation is future hardening; other addresses Pass for now.
contract QuoteProbe is IQuoteProbe {
    mapping(address => bool) public alwaysPass;
    address public owner;

    error OnlyOwner();

    constructor(address owner_) {
        owner = owner_;
    }

    function setAlwaysPass(address token, bool ok) external {
        if (msg.sender != owner) revert OnlyOwner();
        alwaysPass[token] = ok;
    }

    /// @inheritdoc IQuoteProbe
    function probe(address quote) external override returns (ProbeResult result, string memory detail) {
        if (quote == address(0)) return (ProbeResult.RejectHoneypot, "zero quote");
        if (alwaysPass[quote]) return (ProbeResult.Pass, "allowlisted");
        return (ProbeResult.Pass, "ok");
    }
}
