// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title PVE login gate: EIP-712 "verified Privy login" attestations from a protocol attester key
/// @notice The backend (after a verified Privy login) signs LoginAttestation{wallet, expiry, coin}. Anyone (the wallet,
///         a relayer, or the wallet's own smart-account batch right before its first PVE buy) submits it with
///         `attest`, which records `verifiedUntil`. PVE curves read `verifiedUntil(wallet, coin)` once and cache it,
///         so repeat buys cost a single warm SLOAD. coin == address(0) = valid for every PVE coin.
/// @dev Rotating the attester does NOT revoke attestations already recorded (they expire on their own); use short
///      expiries (proposal: 24h). The owner can `revoke` a wallet (applies to curves on their next cache refresh).
contract LoginGate is EIP712 {
    bytes32 public constant LOGIN_TYPEHASH = keccak256("LoginAttestation(address wallet,uint64 expiry,address coin)");

    address public owner;
    address public attester;

    /// @dev wallet => coin (address(0) = all coins) => unix expiry
    mapping(address => mapping(address => uint64)) internal _until;

    error OnlyOwner();
    error BadSignature();
    error Expired();
    error ZeroAddress();

    event AttesterSet(address indexed attester);
    event OwnerTransferred(address indexed owner);
    event LoginAttested(address indexed wallet, address indexed coin, uint64 expiry);
    event LoginRevoked(address indexed wallet);

    constructor(address owner_, address attester_) EIP712("DisciplePVE", "1") {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        attester = attester_;
        emit AttesterSet(attester_);
    }

    function setAttester(address a) external {
        if (msg.sender != owner) revert OnlyOwner();
        attester = a;
        emit AttesterSet(a);
    }

    function transferOwnership(address o) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (o == address(0)) revert ZeroAddress();
        owner = o;
        emit OwnerTransferred(o);
    }

    /// @notice Owner kill-switch for a wallet (global + is checked by curves on their next cache refresh only).
    function revoke(address wallet, address coin) external {
        if (msg.sender != owner) revert OnlyOwner();
        delete _until[wallet][coin];
        emit LoginRevoked(wallet);
    }

    function digest(address wallet, uint64 expiry, address coin) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(LOGIN_TYPEHASH, wallet, expiry, coin)));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Record an attester-signed login. Permissionless submit; the signature binds the wallet.
    function attest(address wallet, uint64 expiry, address coin, bytes calldata sig) external {
        if (expiry <= block.timestamp) revert Expired();
        address a = attester;
        if (a == address(0) || ECDSA.recover(digest(wallet, expiry, coin), sig) != a) revert BadSignature();
        if (expiry > _until[wallet][coin]) _until[wallet][coin] = expiry;
        emit LoginAttested(wallet, coin, expiry);
    }

    /// @notice Max of the global and the coin-specific attestation expiry for `wallet`.
    function verifiedUntil(address wallet, address coin) external view returns (uint64 t) {
        t = _until[wallet][address(0)];
        if (coin != address(0)) {
            uint64 c = _until[wallet][coin];
            if (c > t) t = c;
        }
    }
}
