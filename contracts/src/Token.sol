// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Constants} from "./libraries/Constants.sol";
import {IToken} from "./interfaces/IToken.sol";

/// @title DISCIPLE ERC-20 launch token
/// @notice Fixed 7B supply, 18 decimals, no further mint (§2 / LOCKED #7, #10).
/// @dev EIP-2612 permit enabled (single-tx sells via BondingCurve.sellWithPermit).
///      Standard CREATE deployment (no vanity). Entire supply minted once to `recipient` (the curve).
contract Token is ERC20, ERC20Permit, IToken {
    address public immutable override creator;
    address public immutable override launchpad;

    error ZeroAddress();

    constructor(string memory name_, string memory symbol_, address creator_, address launchpad_, address recipient_)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        if (creator_ == address(0) || launchpad_ == address(0) || recipient_ == address(0)) {
            revert ZeroAddress();
        }
        creator = creator_;
        launchpad = launchpad_;
        // Fixed supply at launch; no further mint (§2).
        _mint(recipient_, Constants.TOTAL_SUPPLY);
    }

    function decimals() public pure override(ERC20, IToken) returns (uint8) {
        return Constants.TOKEN_DECIMALS;
    }
}
