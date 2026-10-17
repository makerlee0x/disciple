// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IReferralRegistry} from "./interfaces/IReferralRegistry.sol";
import {Constants} from "./libraries/Constants.sol";

/// @title USDG deposit notifier + escrow for the referral gate (§4 / LOCKED #18, audit #5, DISCIPLE audit #7 / L5)
/// @notice ReferralRegistry.depositHook. Two ways to record a USDG deposit for `wallet`:
///         1. `deposit(wallet, amount)`: pulls real USDG (>= $10) from msg.sender INTO THIS CONTRACT as a separate
///            escrow entry for `wallet`, locked for `LOCK_PERIOD` (7 days), then notifies the registry. Anyone may fund
///            any wallet (incl. itself). Each deposit has its OWN unlock time, so a third-party gift never re-locks the
///            wallet's existing escrow. After its lock, only `wallet` can `withdraw` an entry (to itself).
///            Locked USDG can't satisfy the gate for a second wallet at the same time. Gate rate: the gate credit
///            survives withdraw, so one $10 can qualify at most one new wallet per 7 days (~52 per year).
///         2. `attest(wallet, amount)`: owner-set attestors (e.g. an on-ramp / bridge watcher) record deposits
///            that happened off this contract.
///         Funding a wallet cannot hijack its referrer: only the wallet itself (or a registry attestor) sets the
///         pending referrer; the deposit only finalizes what the wallet already chose.
contract UsdgDepositNotifier {
    using SafeERC20 for IERC20;

    /// @notice Lock per deposit entry. Proposal: 7 days.
    uint256 public constant LOCK_PERIOD = 7 days;

    IReferralRegistry public immutable registry;
    IERC20 public immutable usdg;
    address public owner;
    mapping(address => bool) public isAttestor;

    struct Escrow {
        uint192 amount;
        uint64 unlockAt;
    }

    mapping(address => Escrow[]) internal _escrows;
    /// @notice Total USDG currently escrowed for `wallet` (all entries, locked or not).
    mapping(address => uint256) public escrowedOf;

    error OnlyOwner();
    error OnlyAttestor();
    error ZeroAmount();
    error ZeroAddress();
    error NotTransferred();
    error Locked(uint256 id, uint256 unlockAt);
    error NothingEscrowed();
    error BelowMinimum(uint256 min);

    event Deposited(address indexed payer, address indexed wallet, uint256 amount);
    event Escrowed(address indexed wallet, uint256 indexed id, uint256 amount, uint256 unlockAt);
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

    /// @notice Escrow `amount` USDG (from msg.sender) for `wallet` as a new entry locked LOCK_PERIOD, and count it
    ///         for the gate. Approve THIS contract for exactly `amount` first. Returns the entry id.
    function deposit(address wallet, uint256 amount) external returns (uint256 id) {
        if (amount < Constants.REFERRAL_USDG_GATE) revert BelowMinimum(Constants.REFERRAL_USDG_GATE);
        if (wallet == address(0)) revert ZeroAddress();
        uint256 b0 = usdg.balanceOf(address(this));
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        if (usdg.balanceOf(address(this)) - b0 != amount) revert NotTransferred();
        uint256 unlockAt = block.timestamp + LOCK_PERIOD;
        id = _escrows[wallet].length;
        _escrows[wallet].push(Escrow({amount: uint192(amount), unlockAt: uint64(unlockAt)}));
        escrowedOf[wallet] += amount;
        registry.onUsdgDeposit(wallet, amount);
        emit Deposited(msg.sender, wallet, amount);
        emit Escrowed(wallet, id, amount, unlockAt);
    }

    /// @notice Number of escrow entries ever created for `wallet` (withdrawn entries stay with amount 0).
    function escrowCount(address wallet) external view returns (uint256) {
        return _escrows[wallet].length;
    }

    function escrowOf(address wallet, uint256 id) external view returns (uint256 amount, uint256 unlockAt) {
        Escrow memory e = _escrows[wallet][id];
        return (e.amount, e.unlockAt);
    }

    /// @notice Withdraw your unlocked escrow entries `ids` (to yourself). Reverts if any is still locked.
    function withdraw(uint256[] calldata ids) external returns (uint256 amount) {
        Escrow[] storage es = _escrows[msg.sender];
        for (uint256 i; i < ids.length; ++i) {
            Escrow memory e = es[ids[i]];
            if (e.amount == 0) continue;
            if (block.timestamp < e.unlockAt) revert Locked(ids[i], e.unlockAt);
            es[ids[i]].amount = 0;
            amount += e.amount;
        }
        if (amount == 0) revert NothingEscrowed();
        escrowedOf[msg.sender] -= amount;
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
