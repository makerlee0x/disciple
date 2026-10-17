// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Constants} from "./libraries/Constants.sol";
import {IReferralRegistry} from "./interfaces/IReferralRegistry.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title First-touch referral registry (§4 / LOCKED #18–#22)
/// @dev Attribution locks after: link → account → USDG deposit ≥ $10.
///      Self-referral (same wallet) blocked only.
contract ReferralRegistry is IReferralRegistry {
    mapping(address => address) private _referrerOf;
    mapping(address => uint256) public usdgDeposited;
    mapping(address => address) public pendingReferrer; // set before deposit gate clears

    address public depositHook; // authorized USDG deposit notifier
    /// @notice $10 gate in USDG raw units: REFERRAL_GATE_USD * 10**usdg.decimals() (set at construction).
    uint256 public immutable usdgGate;
    address public owner;
    /// @notice Owner-set contracts allowed to attribute on behalf of a wallet (e.g. a router that verified the
    ///         wallet's intent). Audit #3: everyone else may only attribute msg.sender itself.
    mapping(address => bool) public isAttestor;

    error OnlyOwner();
    error OnlyDepositHook();
    error SelfReferral();
    error AlreadyAttributed();
    error NotWalletOrAttestor();

    event ReferrerPending(address indexed wallet, address indexed referrer);
    event ReferrerAttributed(address indexed wallet, address indexed referrer);
    event AttestorSet(address indexed attestor, bool allowed);
    event DepositHookSet(address indexed hook);
    event UsdgDepositRecorded(address indexed wallet, uint256 amount, uint256 total);

    constructor(address owner_, address usdg_) {
        owner = owner_;
        usdgGate = Constants.REFERRAL_GATE_USD * 10 ** uint256(IERC20Metadata(usdg_).decimals());
    }

    function setDepositHook(address hook) external {
        if (msg.sender != owner) revert OnlyOwner();
        depositHook = hook;
        emit DepositHookSet(hook);
    }

    function setAttestor(address attestor, bool allowed) external {
        if (msg.sender != owner) revert OnlyOwner();
        isAttestor[attestor] = allowed;
        emit AttestorSet(attestor, allowed);
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert OnlyOwner();
        owner = newOwner;
    }

    /// @inheritdoc IReferralRegistry
    function referrerOf(address wallet) external view override returns (address) {
        return _referrerOf[wallet];
    }

    /// @inheritdoc IReferralRegistry
    /// @dev Stores pending referrer; attribution finalizes on USDG gate.
    ///      Audit #3: caller must be `wallet` itself (EOA, or a smart account such as the session-key path
    ///      `account.execute(registry.tryAttribute(account, ref))`) or an owner-trusted attestor.
    ///      First-touch: the first pending referrer is kept; later different referrers are ignored (no overwrite).
    function tryAttribute(address wallet, address referrer) external override returns (bool attributed) {
        if (msg.sender != wallet && !isAttestor[msg.sender]) revert NotWalletOrAttestor();
        if (referrer == wallet) revert SelfReferral();
        if (_referrerOf[wallet] != address(0)) revert AlreadyAttributed();
        if (referrer == address(0)) return false;

        address pending = pendingReferrer[wallet];
        if (pending == address(0)) {
            pendingReferrer[wallet] = referrer;
            emit ReferrerPending(wallet, referrer);
        } else if (pending != referrer) {
            return false; // first touch wins
        }

        // If gate already satisfied (deposit happened first), attribute now.
        if (usdgDeposited[wallet] >= usdgGate) {
            _finalize(wallet, referrer);
            return true;
        }
        return false;
    }

    /// @inheritdoc IReferralRegistry
    function onUsdgDeposit(address wallet, uint256 amount) external override {
        if (msg.sender != depositHook) revert OnlyDepositHook();
        usdgDeposited[wallet] += amount;
        emit UsdgDepositRecorded(wallet, amount, usdgDeposited[wallet]);

        address pending = pendingReferrer[wallet];
        if (
            _referrerOf[wallet] == address(0) && pending != address(0) && pending != wallet
                && usdgDeposited[wallet] >= usdgGate
        ) {
            _finalize(wallet, pending);
        }
    }

    function _finalize(address wallet, address referrer) internal {
        _referrerOf[wallet] = referrer;
        delete pendingReferrer[wallet];
        emit ReferrerAttributed(wallet, referrer);
    }
}
