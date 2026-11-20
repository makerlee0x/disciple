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
///      maker 2026-11-20: every coin is an EIP-1167 clone of one implementation (TokenDeployer), set up by
///      `initialize`. Per-launchpad values (launchpad, PoolManager, LockedLP) are immutables of the implementation, so
///      every clone reads them from the shared code. The permit domain is ("DISCIPLE Rocket", "1", chainid, the clone's
///      own address), which `eip712Domain()` reports. Entire supply minted once to `recipient` (the Launchpad).
contract Token is ERC20, ERC20Permit, ERC20Burnable, IToken {
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address public immutable override launchpad;
    /// @notice maker 2026-11-19: no Uniswap v4 pool before orbit, in every mode. Until the curve graduates, the token
    ///         refuses transfers INTO the v4 PoolManager (so nobody can seed or trade a side pool), except LockedLP's
    ///         seeding of the real pool inside the graduation transaction. address(0) (no Migration found) = off.
    address public immutable poolManager;
    address internal immutable _lockedLP;
    /// @dev Audit delta-2 D2-L4: the contract that created the implementation (TokenDeployer). Only it may initialize a
    ///      clone, so nobody can stand up a self-made clone of the real coin code with their own name / supply.
    address internal immutable _cloner;
    /// @notice The coin creator of record at launch (the Launchpad tracks later transfers) and whether pre-graduation
    ///         wallet→wallet transfers notify the curve (PVE coins). One packed slot, written once by `initialize`.
    address public override creator;
    bool public pveHooks;
    /// @notice The coin's curve (set once by the Launchpad, every mode; the name is kept for the ABI) and whether the
    ///         coin is still pre-orbit (cleared by the curve at graduation). One packed slot. PVE transfer
    ///         notifications run only while `pveHooks && pveLive`.
    address public pveCurve;
    bool public pveLive;
    /// @notice Mode rules v2 (PVE / Easy): the creator's First BOOST (launch buy) amount. Until graduation
    ///         (`pveLive` cleared by the curve) the creator's balance can never drop below it: no curve sell, no
    ///         transfer. Tokens the creator buys later stay free. Set once by the curve; same slot as pveCurve.
    uint88 public creatorLocked;
    string private _cloneName;
    string private _cloneSymbol;

    error ZeroAddress();
    error OnlyLaunchpad();
    error OnlyCurve();
    error AlreadySet();
    error OnlyCloner();
    error CreatorLocked();
    /// @notice The coin is still on its curve: no v4 pool may hold it yet.
    error PoolBeforeOrbit();

    /// @dev Implementation only. `creator` is set to the dead address so `initialize` can never run on it.
    constructor(address launchpad_, address poolManager_, address lockedLP_)
        ERC20("", "")
        ERC20Permit("DISCIPLE Rocket")
    {
        if (launchpad_ == address(0)) revert ZeroAddress();
        launchpad = launchpad_;
        poolManager = poolManager_; // address(0) leaves the pre-orbit v4 block off
        _lockedLP = lockedLP_;
        creator = DEAD;
        _cloner = msg.sender;
    }

    /// @notice One-time setup of a fresh clone by its TokenDeployer: name, ticker, creator, PVE flag, full supply.
    function initialize(
        string calldata name_,
        string calldata symbol_,
        address creator_,
        address recipient_,
        bool pveHooks_
    ) external {
        if (creator != address(0)) revert AlreadySet();
        if (msg.sender != _cloner) revert OnlyCloner();
        if (creator_ == address(0) || recipient_ == address(0)) revert ZeroAddress();
        creator = creator_;
        pveHooks = pveHooks_;
        _cloneName = name_;
        _cloneSymbol = symbol_;
        // Fixed supply at launch; no further mint (§2).
        _mint(recipient_, Constants.TOTAL_SUPPLY);
    }

    function name() public view override returns (string memory) {
        return _cloneName;
    }

    function symbol() public view override returns (string memory) {
        return _cloneSymbol;
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
