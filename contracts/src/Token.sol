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
/// @notice Fixed 1M supply, 18 decimals, no further mint (§2 / LOCKED #7, #10).
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
    /// @notice Mode rules v2 (PVE / Easy): the creator's First BOOST (launch buy) amount. Until graduation
    ///         (`pveLive` cleared by the curve) the creator's balance can never drop below it: no curve sell, no
    ///         transfer. Tokens the creator buys later stay free. Set once by the curve; same slot as pveCurve.
    uint88 public creatorLocked;

    error ZeroAddress();
    error OnlyLaunchpad();
    error OnlyCurve();
    error AlreadySet();
    error CreatorLocked();

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

    /// @notice The PVE curve records the creator's First BOOST once (in the launch tx, right after the buy).
    function lockCreator(uint256 amount) external {
        if (msg.sender != pveCurve) revert OnlyCurve();
        if (creatorLocked != 0) revert AlreadySet();
        creatorLocked = uint88(amount); // <= 1.2% of supply (FIRST_BOOST_MAX_BPS_PVE) << 2^88
    }

    /// @notice True while the creator's First BOOST is locked (PVE, not graduated, lock recorded).
    function creatorLockActive() external view returns (bool) {
        return pveLive && creatorLocked != 0;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (pveHooks && pveLive) {
            // creator lock (mode rules v2): the creator's balance may not drop below the First BOOST pre-graduation
            if (from == creator) {
                uint256 l = creatorLocked;
                if (l != 0 && balanceOf(from) < l) revert CreatorLocked();
            }
            if (from != to && from != address(0) && to != address(0) && value != 0) {
                address c = pveCurve;
                // curve buys/sells/graduation move tokens to/from the curve: the curve books those itself
                if (from != c && to != c) IPveCurveHook(c).onTokenTransfer(from, to, value);
            }
        }
    }

    function decimals() public pure override(ERC20, IToken) returns (uint8) {
        return Constants.TOKEN_DECIMALS;
    }
}
