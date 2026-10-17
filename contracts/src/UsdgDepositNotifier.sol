// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IReferralRegistry} from "./interfaces/IReferralRegistry.sol";
import {Constants} from "./libraries/Constants.sol";

/// @title USDG deposit notifier + escrow for the referral gate (§4 / LOCKED #18, audit #5, DISCIPLE audit #7)
/// @notice ReferralRegistry.depositHook. Two ways to record a USDG deposit for `wallet`:
///         1. `deposit(wallet, amount)`: pulls real USDG from msg.sender INTO THIS CONTRACT and locks it for
///            `LOCK_PERIOD` (7 days, proposal) as `wallet`'s escrow, then notifies the registry. Anyone may fund any
///            wallet (incl. itself). After the lock, only `wallet` can `withdraw()` its escrow (to itself).
///            Because counted USDG sits locked here, the same USDG can't satisfy the $10 gate for two wallets at
///            once (cycling it needs a 7-day wait per hop).
///         2. `attest(wallet, amount)`: owner-set attestors (e.g. an on-ramp / bridge watcher) record deposits
///            that happened off this contract.
///         Funding a wallet cannot hijack its referrer: only the wallet itself (or a registry attestor) sets the
///         pending referrer; the deposit only finalizes what the wallet already chose.
contract UsdgDepositNotifier {
    using SafeERC20 for IERC20;

    /// @notice Escrow lock per deposit (each new deposit re-locks the wallet's whole escrow). Proposal: 7 days.
    uint256 public constant LOCK_PERIOD = 7 days;

    IReferralRegistry public immutable registry;
    IERC20 public immutable usdg;
    address public owner;
    mapping(address => bool) public isAttestor;

    struct Escrow {
        uint192 amount;
        uint64 unlockAt;
    }

    mapping(address => Escrow) public escrowOf;

    error OnlyOwner();
    error OnlyAttestor();
    error ZeroAmount();
    error ZeroAddress();
    error NotTransferred();
    error Locked(uint256 unlockAt);
    error NothingEscrowed();
    error BelowMinimum(uint256 min);

    event Deposited(address indexed payer, address indexed wallet, uint256 amount);
    event Escrowed(address indexed wallet, uint256 total, uint256 unlockAt);
    event Withdrawn(address indexed wallet, uint256 amount);
    event Attested(address indexed attestor, address indexed wallet, uint256 amount);
    event AttestorSet(address indexed attestor, bool allowed);
    event OwnerTransferred(address indexed owner);

    constructor(address owner_, IReferralRegistry registry_, IERC20 usdg_) {
        if (owner_ == address(0) || address(registry_) == address(0) || address(usdg_) == address(0)) {
            revert ZeroAddress();
        }
        owner = owner_;
        registry = registry_;
        usdg = usdg_;
    }

    /// @notice Escrow `amount` USDG (from msg.sender) for `wallet`, locked LOCK_PERIOD, and count it for the gate.
    /// @dev Approve THIS contract for exactly `amount` first. Only the escrowed amount (balance delta) is counted.
    function deposit(address wallet, uint256 amount) external {
        // Each deposit re-locks the escrow; a $10 minimum makes lock-extension griefing cost $10 locked per week.
        if (amount < Constants.REFERRAL_USDG_GATE) revert BelowMinimum(Constants.REFERRAL_USDG_GATE);
        if (wallet == address(0)) revert ZeroAddress();
        uint256 b0 = usdg.balanceOf(address(this));
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        if (usdg.balanceOf(address(this)) - b0 != amount) revert NotTransferred();
        Escrow memory e = escrowOf[wallet];
        e.amount += uint192(amount);
        e.unlockAt = uint64(block.timestamp + LOCK_PERIOD);
        escrowOf[wallet] = e;
        registry.onUsdgDeposit(wallet, amount);
        emit Deposited(msg.sender, wallet, amount);
        emit Escrowed(wallet, e.amount, e.unlockAt);
    }

    /// @notice Withdraw your whole escrow after the lock. The referral (if finalized) stays.
    function withdraw() external returns (uint256 amount) {
        Escrow memory e = escrowOf[msg.sender];
        amount = e.amount;
        if (amount == 0) revert NothingEscrowed();
        if (block.timestamp < e.unlockAt) revert Locked(e.unlockAt);
        delete escrowOf[msg.sender];
        usdg.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function attest(address wallet, uint256 amount) external {
        if (!isAttestor[msg.sender]) revert OnlyAttestor();
        if (amount == 0) revert ZeroAmount();
        registry.onUsdgDeposit(wallet, amount);
        emit Attested(msg.sender, wallet, amount);
    }

    function setAttestor(address a, bool allowed) external {
        if (msg.sender != owner) revert OnlyOwner();
        isAttestor[a] = allowed;
        emit AttestorSet(a, allowed);
    }

    function transferOwnership(address o) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (o == address(0)) revert ZeroAddress();
        owner = o;
        emit OwnerTransferred(o);
    }
}
