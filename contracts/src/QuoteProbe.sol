// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IQuoteProbe} from "./interfaces/IQuoteProbe.sol";
import {Owned2Step} from "./utils/Owned2Step.sol";

/// @title Minimal quote probe (§6 / LOCKED #31–#32)
/// @dev Always-pass list (STRATEGY/default, WETH, USDG). Hard-reject address(0).
///      Full honeypot/FoT simulation is future hardening; other addresses Pass for now.
contract QuoteProbe is IQuoteProbe, Owned2Step {
    mapping(address => bool) public alwaysPass;
    constructor(address owner_) Owned2Step(owner_) {}

    function setAlwaysPass(address token, bool ok) external {
        _checkOwner();
        alwaysPass[token] = ok;
    }

    /// @inheritdoc IQuoteProbe
    function probe(address quote) external override returns (ProbeResult result, string memory detail) {
        if (quote == address(0)) return (ProbeResult.RejectHoneypot, "zero quote");
        if (alwaysPass[quote]) return (ProbeResult.Pass, "allowlisted");
        return (ProbeResult.Pass, "ok");
    }
}
