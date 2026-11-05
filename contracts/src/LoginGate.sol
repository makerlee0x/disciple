// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title PVE login gate: EIP-712 "verified Privy login" attestations from a protocol attester key
/// @notice The backend (after a verified Privy login) signs LoginAttestation{wallet, expiry, coin, epoch, walletGen}. Anyone (the wallet,
///         a relayer, or the wallet's own smart-account batch right before its first PVE buy) submits it with
///         `attest`, which records `verifiedUntil`. PVE curves read `verifiedUntil(wallet, coin)` once and cache it,
///         so repeat buys cost a single warm SLOAD. coin == address(0) = valid for every PVE coin.
/// @dev Rotating the attester does NOT revoke attestations already recorded (they expire on their own); use short
///      expiries (proposal: 24h). The owner can `revoke` a wallet (applies to curves on their next cache refresh).
///      Audit F-05: attestations bind to `epoch[wallet][coin]` AND `walletGen[wallet]`; revoke increments the relevant
///      epoch so an old signature cannot be replayed. Owner-confirmed precedence: a revoke at either level wins —
///      coin-specific revoke blocks falling back to a still-valid global attestation for that coin; global revoke
///      invalidates outstanding coin-specific attestations until they are re-attested under the new walletGen.
contract LoginGate is EIP712 {
    bytes32 public constant LOGIN_TYPEHASH =
        keccak256("LoginAttestation(address wallet,uint64 expiry,address coin,uint64 epoch,uint64 walletGen)");

    address public owner;
    address public attester;

    /// @dev wallet => coin (address(0) = all coins) => unix expiry
    mapping(address => mapping(address => uint64)) internal _until;

    /// @notice Per-(wallet, coin) revocation epoch; included in the signed attestation (audit F-05).
    mapping(address => mapping(address => uint64)) public epoch;

    /// @notice Bumped on global revoke (coin == address(0)); invalidates prior coin-specific signatures and stored slots.
    mapping(address => uint64) public walletGen;

    /// @dev wallet => coin => walletGen at last successful attest of that slot
    mapping(address => mapping(address => uint64)) internal _slotWalletGen;

    /// @dev coin-specific revoke blocks using a global attestation for that coin until a fresh coin attest
    mapping(address => mapping(address => bool)) internal _coinBlocksGlobal;

    /// @notice Max attestation lifetime (audit L2): a careless/compromised attester can't mint long sessions.
    uint256 public constant MAX_TTL = 24 hours;
    error TtlTooLong();
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

    /// @notice Owner kill-switch for a wallet/coin slot (applies to curves on their next cache refresh only).
    /// @dev Increments the slot epoch (invalidates outstanding signatures) and clears the stored expiry.
    ///      coin == address(0): also bumps walletGen so prior coin-specific attestations stop covering.
    ///      coin != address(0): blocks global fallback for that coin until a fresh coin-specific attest.
    function revoke(address wallet, address coin) external {
        if (msg.sender != owner) revert OnlyOwner();
        unchecked {
            ++epoch[wallet][coin];
        }
        delete _until[wallet][coin];
        if (coin == address(0)) {
            unchecked {
                ++walletGen[wallet];
            }
        } else {
            _coinBlocksGlobal[wallet][coin] = true;
        }
        emit LoginRevoked(wallet);
    }

    /// @notice Digest for the current slot AND global epochs of `(wallet, coin)`.
    function digest(address wallet, uint64 expiry, address coin) public view returns (bytes32) {
        return digest(wallet, expiry, coin, epoch[wallet][coin]);
    }

    function digest(address wallet, uint64 expiry, address coin, uint64 epoch_) public view returns (bytes32) {
        return digest(wallet, expiry, coin, epoch_, walletGen[wallet]);
    }

    /// @notice Explicit epochs for off-chain digest parity; attest always verifies the CURRENT epochs.
    function digest(address wallet, uint64 expiry, address coin, uint64 epoch_, uint64 walletGen_)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(LOGIN_TYPEHASH, wallet, expiry, coin, epoch_, walletGen_)));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Record an attester-signed login. Permissionless submit; the signature binds the wallet + current slot AND global epochs.
    function attest(address wallet, uint64 expiry, address coin, bytes calldata sig) external {
        if (expiry <= block.timestamp) revert Expired();
        if (expiry > block.timestamp + MAX_TTL) revert TtlTooLong(); // audit L2
        uint64 e = epoch[wallet][coin];
        address a = attester;
        if (a == address(0) || ECDSA.recover(digest(wallet, expiry, coin, e), sig) != a) revert BadSignature();
        uint64 generation = walletGen[wallet];
        // A globally invalidated slot must not revive its older, possibly longer expiry on fresh attestation.
        if (_slotWalletGen[wallet][coin] != generation || expiry > _until[wallet][coin]) {
            _until[wallet][coin] = expiry;
        }
        _slotWalletGen[wallet][coin] = generation;
        if (coin != address(0)) _coinBlocksGlobal[wallet][coin] = false;
        emit LoginAttested(wallet, coin, expiry);
    }

    /// @notice Effective login expiry for `wallet` on `coin`.
    /// @dev Owner-confirmed precedence: a revoke at either level wins.
    ///      - Coin-specific revoke → do not fall back to global for that coin until re-attested at coin scope.
    ///      - Global revoke → coin-specific slots attested under an older walletGen are ignored until re-attested.
    function verifiedUntil(address wallet, address coin) external view returns (uint64 t) {
        if (coin == address(0)) return _until[wallet][address(0)];
        if (_coinBlocksGlobal[wallet][coin]) return _until[wallet][coin];
        uint64 c = _until[wallet][coin];
        if (_slotWalletGen[wallet][coin] != walletGen[wallet]) c = 0;
        t = _until[wallet][address(0)];
        if (c > t) t = c;
    }
}
