// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IReferralRegistry} from "./interfaces/IReferralRegistry.sol";

/// @title USDG deposit notifier for the referral gate (§4 / LOCKED #18, audit #5)
/// @notice ReferralRegistry.depositHook. Two ways to record a USDG deposit for `wallet`:
///         1. `deposit(wallet, amount)`: pulls real USDG from msg.sender and forwards it to `wallet`
///            (on-chain proof of funds, e.g. the app's "fund account" step), then notifies the registry.
///         2. `attest(wallet, amount)`: owner-set attestors (e.g. an on-ramp / bridge watcher) record deposits
///            that happened off this contract.
///         Funding a wallet cannot hijack its referrer: only the wallet itself (or a registry attestor) sets the
///         pending referrer; the deposit only finalizes what the wallet already chose.
contract UsdgDepositNotifier {
    using SafeERC20 for IERC20;

    IReferralRegistry public immutable registry;
    IERC20 public immutable usdg;
    address public owner;
    mapping(address => bool) public isAttestor;

    error OnlyOwner();
    error OnlyAttestor();
    error ZeroAmount();
    error ZeroAddress();

    event Deposited(address indexed payer, address indexed wallet, uint256 amount);
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

    function deposit(address wallet, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (wallet == address(0)) revert ZeroAddress();
        usdg.safeTransferFrom(msg.sender, wallet, amount);
        registry.onUsdgDeposit(wallet, amount);
        emit Deposited(msg.sender, wallet, amount);
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
