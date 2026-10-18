// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Constants} from "./libraries/Constants.sol";
import {IToken} from "./interfaces/IToken.sol";

/// @dev PVE curve hook: NET positions follow pre-graduation transfers (DISCIPLE audit Medium-1).
interface IPveCurveHook {
    function onTokenTransfer(address from, address to, uint256 amount) external;
}

/// @title DISCIPLE ERC-20 launch token
/// @notice Fixed 7B supply, 18 decimals, no further mint (§2 / LOCKED #7, #10).
/// @dev EIP-2612 permit enabled (single-tx sells via BondingCurve.sellWithPermit).
///      Standard CREATE deployment (no vanity). Entire supply minted once to `recipient` (the curve).
contract Token is ERC20, ERC20Permit, IToken {
    address public immutable override creator;
    address public immutable override launchpad;
    /// @notice True for PVE coins: pre-graduation wallet→wallet transfers notify the curve. Immutable, so TRENCH /
    ///         PVP tokens pay nothing extra on transfers.
    bool public immutable pveHooks;
    /// @notice PVE curve (set once by the Launchpad) and whether it still wants transfer notifications (cleared by
    ///         the curve at graduation). One packed slot.
    address public pveCurve;
    bool public pveLive;

    error ZeroAddress();
    error OnlyLaunchpad();
    error OnlyCurve();
    error AlreadySet();

    constructor(
        string memory name_,
        string memory symbol_,
        address creator_,
        address launchpad_,
        address recipient_,
        bool pveHooks_
    )
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        if (creator_ == address(0) || launchpad_ == address(0) || recipient_ == address(0)) {
            revert ZeroAddress();
        }
        creator = creator_;
        launchpad = launchpad_;
        pveHooks = pveHooks_;
        // Fixed supply at launch; no further mint (§2).
        _mint(recipient_, Constants.TOTAL_SUPPLY);
    }

    /// @notice Launchpad wires the PVE curve once (before any tokens leave the Launchpad).
    function setPveCurve(address curve) external {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        if (!pveHooks || pveCurve != address(0)) revert AlreadySet();
        if (curve == address(0)) revert ZeroAddress();
        pveCurve = curve;
        pveLive = true;
    }

    /// @notice The PVE curve stops transfer notifications at graduation.
    function endPveHooks() external {
        if (msg.sender != pveCurve) revert OnlyCurve();
        pveLive = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (pveHooks && from != to && from != address(0) && to != address(0) && value != 0) {
            address c = pveCurve;
            // curve buys/sells/graduation move tokens to/from the curve: the curve books those itself
            if (pveLive && from != c && to != c) IPveCurveHook(c).onTokenTransfer(from, to, value);
        }
    }

    function decimals() public pure override(ERC20, IToken) returns (uint8) {
        return Constants.TOKEN_DECIMALS;
    }
}
