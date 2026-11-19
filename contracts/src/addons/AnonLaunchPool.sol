// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ILaunchpad} from "../interfaces/ILaunchpad.sol";
import {Owned2Step} from "../utils/Owned2Step.sol";

/// @dev AnonLauncher.launchAnonWithUsdgMode (creator fees kept, destination 0).
interface IPoolAnonLauncher {
    function launchAnonWithUsdgMode(
        ILaunchpad.LaunchParams calldata p,
        uint8 mode,
        address stealthOwner,
        address buyRecipient,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag,
        uint256 maxFee,
        uint256 usdgIn,
        uint256 minQuoteIn,
        address refundTo
    ) external returns (ILaunchpad.LaunchResult memory r, uint256 usdgRefund);
}

/// @dev CreatorFeeHarvest.launchAnonWithUsdgMode (destination 1 locked pool, 2 buy-and-burn).
interface IPoolHarvestLauncher {
    function launchAnonWithUsdgMode(
        ILaunchpad.LaunchParams calldata p,
        uint8 mode,
        address stealthOwner,
        address buyRecipient,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag,
        uint256 maxFee,
        uint256 usdgIn,
        uint256 minQuoteIn,
        address refundTo,
        uint8 creatorFeeDestination
    ) external returns (ILaunchpad.LaunchResult memory r, uint256 usdgRefund);
}

/// @title DISCIPLE anon launch pool
/// @notice Pays hidden launches from one shared USDG pool so the launcher's wallet is never in the launch transaction
///         (maker 2026-11-19: "if your wallet is connected thats not anon").
///
///         Players top up their anon balance by sending USDG here (`deposit`, or a plain / gasless transfer). The site
///         keeps each player's balance in its own ledger. To launch, the site signs a `PoolLaunch` for the exact launch,
///         a relayer submits it, and this contract pays the First BOOST from the pool and calls AnonLauncher (or
///         CreatorFeeHarvest for pool / burn fee routing) with `refundTo` = this pool. The launch transaction holds only
///         the relayer, this pool, the launcher and the stealth owner: no player wallet, no player signature, no refund
///         to a player. A partial-fill refund stays in the pool and the site credits it back.
///
///         Cashing out the anon balance is a signed `Payout` to any address.
///
/// @dev Trust: the pool is custodial. The spend signer (the site) decides who may spend what, and the owner (the Safe)
///      can rotate that signer and pause. The owner cannot move funds itself. Every spend is single-use (nonce) and
///      expires (deadline), and `dailyLimit` caps total outflow per UTC day so a leaked signer key cannot empty the
///      pool in one go. Unlinkability is off-chain: the deposit (wallet -> pool) and the launch (pool -> launcher) are
///      two unrelated transactions; only amount and timing can hint at a link.
contract AnonLaunchPool is EIP712, ReentrancyGuard, Owned2Step {
    using SafeERC20 for IERC20;

    bytes32 public constant POOL_LAUNCH_TYPEHASH =
        keccak256("PoolLaunch(bytes32 launchHash,uint256 usdgIn,uint256 nonce,uint256 deadline)");
    bytes32 public constant PAYOUT_TYPEHASH =
        keccak256("Payout(address to,uint256 amount,uint256 nonce,uint256 deadline)");

    IERC20 public immutable usdg;
    /// @notice AnonLauncher (destination 0).
    address public immutable anonLauncher;
    /// @notice CreatorFeeHarvest (destinations 1 and 2). address(0) = pool / burn routing off.
    address public immutable harvest;

    /// @notice The site's key that signs launches and payouts.
    address public spendSigner;
    bool public paused;
    /// @notice Max USDG out per UTC day (launch spends + payouts). 0 = no outflow.
    uint256 public dailyLimit;
    uint256 public spentDay;
    uint256 public spentToday;

    mapping(uint256 => bool) public usedNonce;

    struct LaunchArgs {
        ILaunchpad.LaunchParams p;
        uint8 mode; // 0 Trench (Expert), 1 Easy, 2 Hard
        address stealthOwner;
        address buyRecipient;
        bytes ephemeralPubKey;
        bytes1 viewTag;
        uint256 minQuoteIn;
        uint8 creatorFeeDestination; // 0 keep, 1 locked pool, 2 buy-and-burn
    }

    error ZeroAddress();
    error Paused();
    error Expired();
    error NonceUsed();
    error BadSignature();
    error BadDestination();
    error OverDailyLimit();

    event Deposited(address indexed from, uint256 amount);
    event PoolLaunched(
        address indexed token, address indexed curve, uint256 indexed nonce, uint256 usdgIn, uint256 spent
    );
    event PaidOut(uint256 indexed nonce, address indexed to, uint256 amount);
    event SpendSignerSet(address signer);
    event PausedSet(bool paused);
    event DailyLimitSet(uint256 limit);

    constructor(
        address owner_,
        address usdg_,
        address anonLauncher_,
        address harvest_,
        address spendSigner_,
        uint256 dailyLimit_
    ) EIP712("DISCIPLE AnonLaunchPool", "1") Owned2Step(owner_) {
        if (usdg_ == address(0) || anonLauncher_ == address(0) || spendSigner_ == address(0)) {
            revert ZeroAddress();
        }
        usdg = IERC20(usdg_);
        anonLauncher = anonLauncher_;
        harvest = harvest_;
        spendSigner = spendSigner_;
        dailyLimit = dailyLimit_;
        emit SpendSignerSet(spendSigner_);
        emit DailyLimitSet(dailyLimit_);
    }

    // ───────────────────────────── admin (Safe) ─────────────────────────────

    function setSpendSigner(address s) external {
        _checkOwner();
        if (s == address(0)) revert ZeroAddress();
        spendSigner = s;
        emit SpendSignerSet(s);
    }

    function setPaused(bool p) external {
        _checkOwner();
        paused = p;
        emit PausedSet(p);
    }

    function setDailyLimit(uint256 limit) external {
        _checkOwner();
        dailyLimit = limit;
        emit DailyLimitSet(limit);
    }

    // ───────────────────────────── deposit ─────────────────────────────

    /// @notice Top up an anon balance. A plain USDG transfer to this address works the same; the site credits either.
    function deposit(uint256 amount) external nonReentrant {
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    // ───────────────────────────── launch ─────────────────────────────

    /// @notice The hash the spend signer binds: every launch field, so a relayer cannot change any of them.
    function launchHash(LaunchArgs calldata a) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                a.p,
                a.mode,
                a.stealthOwner,
                a.buyRecipient,
                keccak256(a.ephemeralPubKey),
                a.viewTag,
                a.minQuoteIn,
                a.creatorFeeDestination
            )
        );
    }

    function launchDigest(bytes32 lh, uint256 usdgIn, uint256 nonce, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(POOL_LAUNCH_TYPEHASH, lh, usdgIn, nonce, deadline)));
    }

    function payoutDigest(address to, uint256 amount, uint256 nonce, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(PAYOUT_TYPEHASH, to, amount, nonce, deadline)));
    }

    /// @notice Anyone may submit a signed launch (the relayer does). The First BOOST (`usdgIn`, may be 0) comes from
    ///         the pool and any unused part comes back to the pool in the same transaction.
    function launch(LaunchArgs calldata a, uint256 usdgIn, uint256 nonce, uint256 deadline, bytes calldata sig)
        external
        nonReentrant
        returns (ILaunchpad.LaunchResult memory r, uint256 spent)
    {
        if (a.creatorFeeDestination > 2) revert BadDestination();
        address target = a.creatorFeeDestination == 0 ? anonLauncher : harvest;
        if (target == address(0)) revert BadDestination();
        _useSig(launchDigest(launchHash(a), usdgIn, nonce, deadline), nonce, deadline, sig);

        uint256 b0 = usdg.balanceOf(address(this));
        if (usdgIn != 0) usdg.forceApprove(target, usdgIn);
        if (a.creatorFeeDestination == 0) {
            (r,) = IPoolAnonLauncher(target)
                .launchAnonWithUsdgMode(
                    a.p,
                    a.mode,
                    a.stealthOwner,
                    a.buyRecipient,
                    a.ephemeralPubKey,
                    a.viewTag,
                    0,
                    usdgIn,
                    a.minQuoteIn,
                    address(this)
                );
        } else {
            (r,) = IPoolHarvestLauncher(target)
                .launchAnonWithUsdgMode(
                    a.p,
                    a.mode,
                    a.stealthOwner,
                    a.buyRecipient,
                    a.ephemeralPubKey,
                    a.viewTag,
                    0,
                    usdgIn,
                    a.minQuoteIn,
                    address(this),
                    a.creatorFeeDestination
                );
        }
        if (usdgIn != 0) usdg.forceApprove(target, 0);
        spent = b0 - usdg.balanceOf(address(this));
        _countOut(spent);
        emit PoolLaunched(r.token, r.curve, nonce, usdgIn, spent);
    }

    // ───────────────────────────── payout ─────────────────────────────

    /// @notice Cash out an anon balance (or a refund) to `to`, as the spend signer signed.
    function payout(address to, uint256 amount, uint256 nonce, uint256 deadline, bytes calldata sig)
        external
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        _useSig(payoutDigest(to, amount, nonce, deadline), nonce, deadline, sig);
        _countOut(amount);
        usdg.safeTransfer(to, amount);
        emit PaidOut(nonce, to, amount);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ───────────────────────────── internal ─────────────────────────────

    function _useSig(bytes32 digest, uint256 nonce, uint256 deadline, bytes calldata sig) internal {
        if (paused) revert Paused();
        if (block.timestamp > deadline) revert Expired();
        if (usedNonce[nonce]) revert NonceUsed();
        if (!SignatureChecker.isValidSignatureNow(spendSigner, digest, sig)) revert BadSignature();
        usedNonce[nonce] = true;
    }

    function _countOut(uint256 amount) internal {
        uint256 day = block.timestamp / 1 days;
        uint256 today = day == spentDay ? spentToday : 0;
        today += amount;
        if (today > dailyLimit) revert OverDailyLimit();
        spentDay = day;
        spentToday = today;
    }
}
