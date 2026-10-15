// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title Quote token probe (§6 / LOCKED #31–#32)
/// @dev Hard reject honeypot / FoT; soft warn thin depth; WETH / USDG always pass.
interface IQuoteProbe {
    enum ProbeResult {
        Pass,
        SoftWarnThinDepth,
        RejectHoneypot,
        RejectFeeOnTransfer
    }

    function probe(address quote) external returns (ProbeResult result, string memory detail);
}
