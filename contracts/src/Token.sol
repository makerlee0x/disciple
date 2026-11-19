// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {Constants} from "./libraries/Constants.sol";
import {IToken} from "./interfaces/IToken.sol";

/// @dev PVE curve hook: NET positions follow pre-graduation transfers (DISCIPLE audit Medium-1).
interface IPveCurveHook {
    function onTokenTransfer(address from, address to, uint256 amount) external;
}

/// @title DISCIPLE ERC-20 launch token
/// @notice Fixed 1M supply at launch, 18 decimals, no further mint (§2 / LOCKED #7, #10). Holders may burn their own
///         tokens (`burn`) or an approved holder's (`burnFrom`): `totalSupply()` really drops (redeploy pack, lee
///         2026-10-24). PVE (Easy) coins can burn before graduation too:
///         the curve books a burn as a send to 0x…dEaD, so the burned NET leaves circulation (maker 2026-11-19).
/// @dev EIP-2612 permit enabled (single-tx sells via BondingCurve.sellWithPermit).
///      Standard CREATE deployment (no vanity). Entire supply minted once to `recipient` (the curve).
contract Token is ERC20, ERC20Permit, ERC20Burnable, IToken {
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address public immutable override creator;
    address public immutable override launchpad;
    /// @notice True for PVE coins: pre-graduation wallet→wallet transfers notify the curve. Immutable, so TRENCH /
    ///         PVP tokens pay nothing extra on transfers.
    bool public immutable pveHooks;
    /// @notice maker 2026-11-19: no Uniswap v4 pool before orbit, in every mode. Until the curve graduates, the token
    ///         refuses transfers INTO the v4 PoolManager (so nobody can seed or trade a side pool), except LockedLP's
    ///         seeding of the real pool inside the graduation transaction. address(0) (no Migration found) = off.
    address public immutable poolManager;
    address internal immutable _lockedLP;
    /// @notice The coin's curve (set once by the Launchpad, every mode; the name is kept for the ABI) and whether the
    ///         coin is still pre-orbit (cleared by the curve at graduation). One packed slot. PVE transfer
    ///         notifications run only while `pveHooks && pveLive`.
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
    /// @notice The coin is still on its curve: no v4 pool may hold it yet.
    error PoolBeforeOrbit();

    constructor(
        string memory name_,
        string memory symbol_,
        address creator_,
        address launchpad_,
        address recipient_,
        bool pveHooks_,
        address poolManager_,
        address lockedLP_
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
        poolManager = poolManager_; // address(0) leaves the pre-orbit v4 block off
        _lockedLP = lockedLP_;
        // Fixed supply at launch; no further mint (§2).
        _mint(recipient_, Constants.TOTAL_SUPPLY);
    }

    /// @notice Launchpad wires the coin's curve once (before any tokens leave the Launchpad), every mode.
    function setPveCurve(address curve) external {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        if (pveCurve != address(0)) revert AlreadySet();
        if (curve == address(0)) revert ZeroAddress();
        pveCurve = curve;
        pveLive = true;
    }

    /// @notice The curve marks the coin as orbited (stops PVE notifications, opens v4).
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
        // Pre-orbit v4 block: the curve clears pveLive at graduation; LockedLP seeds the real pool inside that tx.
        if (to == poolManager && to != address(0) && pveLive && from != _lockedLP) revert PoolBeforeOrbit();
        super._update(from, to, value);
        if (pveHooks && pveLive) {
            // creator lock (mode rules v2): the creator's balance may not drop below the First BOOST pre-graduation
            if (from == creator) {
                uint256 l = creatorLocked;
                if (l != 0 && balanceOf(from) < l) revert CreatorLocked();
            }
            if (from != to && from != address(0) && value != 0) {
                address c = pveCurve;
                // maker 2026-11-19: Easy coins can be burned any time. A burn is booked like a send to 0x…dEaD: the
                // burned NET leaves circulation (no cap, rewards or cost basis parked anywhere).
                address dst = to == address(0) ? DEAD : to;
                // curve buys/sells/graduation move tokens to/from the curve: the curve books those itself
                if (from != c && dst != c) IPveCurveHook(c).onTokenTransfer(from, dst, value);
            }
        }
    }

    function decimals() public pure override(ERC20, IToken) returns (uint8) {
        return Constants.TOKEN_DECIMALS;
    }
}
