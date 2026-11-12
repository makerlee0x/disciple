// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title Global PVE login gate: EIP-712 attestations from the protocol attester
/// @notice A login covers every PVE coin. Users submit the signature themselves (including in an owner-signed batch).
/// @dev Audit F-05: every signature binds the wallet's global epoch; revoke increments it and clears the expiry.
///      Curves observe revocation on their next bounded cache refresh. Attester rotation does not clear stored logins.
contract LoginGate is EIP712 {
    bytes32 public constant LOGIN_TYPEHASH = keccak256("LoginAttestation(address wallet,uint64 expiry,uint64 epoch)");

    address public owner;
    address public attester;
    mapping(address => uint64) internal _until;
    /// @notice Global per-wallet revocation epoch, included in every signed login.
    mapping(address => uint64) public epoch;

    uint256 public constant MAX_TTL = 24 hours;
    error TtlTooLong();
    error OnlyOwner();
    error BadSignature();
    error Expired();
    error ZeroAddress();

    event AttesterSet(address indexed attester);
    event OwnerTransferred(address indexed owner);
    event LoginAttested(address indexed wallet, uint64 expiry);
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

    /// @notice Revoke this wallet globally; old signatures cannot restore its login.
    /// @dev Checked increment fails closed rather than allowing epoch wraparound.
    function revoke(address wallet) external {
        if (msg.sender != owner) revert OnlyOwner();
        ++epoch[wallet];
        delete _until[wallet];
        emit LoginRevoked(wallet);
    }

    function digest(address wallet, uint64 expiry) public view returns (bytes32) {
        return digest(wallet, expiry, epoch[wallet]);
    }

    /// @notice Explicit epoch for off-chain digest parity; attest always verifies the CURRENT epoch.
    function digest(address wallet, uint64 expiry, uint64 epoch_) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(LOGIN_TYPEHASH, wallet, expiry, epoch_)));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Permissionless, user-paid submission of a global login at the current wallet epoch.
    function attest(address wallet, uint64 expiry, bytes calldata sig) external {
        if (expiry <= block.timestamp) revert Expired();
        if (expiry > block.timestamp + MAX_TTL) revert TtlTooLong();
        address a = attester;
        if (a == address(0) || ECDSA.recover(digest(wallet, expiry), sig) != a) revert BadSignature();
        if (expiry > _until[wallet]) _until[wallet] = expiry;
        emit LoginAttested(wallet, expiry);
    }

    function verifiedUntil(address wallet) external view returns (uint64) {
        return _until[wallet];
    }
}
