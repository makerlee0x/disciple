// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ILaunchpad} from "../interfaces/ILaunchpad.sol";
import {Owned2Step} from "../utils/Owned2Step.sol";

interface IFeeRouterClaims {
    function creatorAccrued(address token, address creator) external view returns (uint256);
    function claimCreatorFees(address token) external returns (uint256);
    /// @dev Post-graduation creator share charged in the launch token itself (hook fee on buys).
    function creatorTokenAccrued(address token, address creator) external view returns (uint256);
    function claimCreatorTokenFees(address token) external returns (uint256);
    function tokenQuote(address token) external view returns (address);
}

interface ILaunchpadAdmin {
    function defaultQuote() external view returns (address);
    function updateMetadata(address token, string calldata img, string calldata desc, string calldata socials) external;
    function transferCreator(address token, address newCreator) external;
}

/// @notice ERC-5564 singleton announcer (deployed at 0x55649E01B5Df198D18D95b5cc5051630cfD45564).
interface IERC5564Announcer {
    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata)
        external;
}

/// @title DISCIPLE pseudonymous launch add-on (v2, no ZK)
/// @notice Wraps the live Launchpad without redeploying it. This contract is the on-chain `creator`
///         of every coin it launches and keeps an internal registry token => stealth owner. The stealth
///         owner is a one-time ERC-5564-style address; it never needs gas: metadata, creator transfer and
///         fee claims are EIP-712 signatures that anyone (a relayer) can submit.
/// @dev Fees are unchanged (1% protocol, 33/33/33/1 split in FeeRouter). The creator buy goes through
///      Launchpad -> curve.buyFor (anti-snipe exempt, capped by Launchpad.creatorBuyMaxBps snapshotted per coin)
///      and the tokens are forwarded to `buyRecipient`.
///      Gas sponsorship happens off-chain (ERC-4337 paymaster); `launchFee` (USDG) recoups it to treasury.
///      Pseudonymous, not anonymous: the payer of the launch fee / creator buy is visible on-chain.
///      v2: claims pay BOTH creator fee sides — quote (FeeRouter.creatorAccrued) and the post-graduation launch-token
///      share (FeeRouter.creatorTokenAccrued), which v1 could not reach. Ownership is two-step (Owned2Step).
///      The EIP-712 Claim struct and domain ("DISCIPLE AnonLauncher", "1") are unchanged; the domain binds
///      verifyingContract, so v1 and v2 signatures never cross-replay.
contract AnonLauncher is EIP712, ReentrancyGuard, Owned2Step {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_LAUNCH_FEE = 5 ether; // $5 in 18-dec USDG
    uint256 public constant MAX_RELAYER_FEE_BPS = 500; // 5%
    uint256 public constant SCHEME_ID = 1; // ERC-5564 secp256k1

    bytes32 public constant CLAIM_TYPEHASH = keccak256(
        "Claim(address owner,address[] tokens,address to,uint256 relayerFeeBps,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant TRANSFER_TYPEHASH =
        keccak256("TransferCreator(address token,address newOwner,uint256 nonce,uint256 deadline)");
    bytes32 public constant METADATA_TYPEHASH = keccak256(
        "UpdateMetadata(address token,string imageURI,string description,string socialsURI,uint256 nonce,uint256 deadline)"
    );

    ILaunchpad public immutable launchpad;
    IFeeRouterClaims public immutable feeRouter;
    IERC20 public immutable feeToken; // USDG
    IERC5564Announcer public immutable announcer; // may be address(0)

    address public treasury;
    uint256 public launchFee;

    mapping(address => address) public stealthOwnerOf; // token => stealth owner
    mapping(address => uint256) public nonces;

    struct ClaimReq {
        address owner;
        address[] tokens;
        address to;
        uint256 relayerFeeBps;
        uint256 deadline;
        bytes sig;
    }

    error ZeroAddress();
    error FeeTooHigh();
    error NotStealthOwner();
    error Expired();
    error BadSignature();
    error NothingToClaim();

    event AnonLaunched(
        address indexed token, address indexed curve, address indexed stealthOwner, uint256 tokensBought
    );
    event LaunchFeePaid(address indexed token, uint256 amount);
    event StealthOwnerTransferred(address indexed token, address indexed from, address indexed to);
    event Claimed(address indexed token, address indexed stealthOwner, address to, address asset, uint256 amount);
    event LaunchFeeUpdated(uint256 fee);
    event TreasuryUpdated(address treasury);

    constructor(
        address owner_,
        address launchpad_,
        address feeRouter_,
        address feeToken_,
        address treasury_,
        address announcer_,
        uint256 launchFee_
    ) EIP712("DISCIPLE AnonLauncher", "1") Owned2Step(owner_) {
        if (owner_ == address(0) || launchpad_ == address(0) || feeRouter_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (launchFee_ > MAX_LAUNCH_FEE) revert FeeTooHigh();
        launchpad = ILaunchpad(launchpad_);
        feeRouter = IFeeRouterClaims(feeRouter_);
        feeToken = IERC20(feeToken_);
        treasury = treasury_;
        announcer = IERC5564Announcer(announcer_);
        launchFee = launchFee_;
    }

    // ───────────────────────────── admin ─────────────────────────────

    function setLaunchFee(uint256 fee) external {
        _checkOwner();
        if (fee > MAX_LAUNCH_FEE) revert FeeTooHigh();
        launchFee = fee;
        emit LaunchFeeUpdated(fee);
    }

    function setTreasury(address t) external {
        _checkOwner();
        if (t == address(0)) revert ZeroAddress();
        treasury = t;
        emit TreasuryUpdated(t);
    }

    // ───────────────────────────── launch ─────────────────────────────

    /// @notice Launch with a stealth creator. Payer (msg.sender, e.g. a sponsored smart account) pays the
    ///         USDG `launchFee` and the optional creator buy; tokens bought go to `buyRecipient`.
    /// @param ephemeralPubKey ERC-5564 ephemeral pubkey (empty = no announcement).
    /// @param viewTag ERC-5564 view tag (first metadata byte).
    function launchAnon(
        ILaunchpad.LaunchParams calldata p,
        address stealthOwner,
        address buyRecipient,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag
    ) external nonReentrant returns (ILaunchpad.LaunchResult memory r) {
        if (stealthOwner == address(0)) revert ZeroAddress();
        if (buyRecipient == address(0)) buyRecipient = stealthOwner;

        uint256 fee = launchFee;
        if (fee > 0) feeToken.safeTransferFrom(msg.sender, treasury, fee);

        if (p.creatorBuyQuoteIn > 0) {
            address q = p.quote == address(0) ? ILaunchpadAdmin(address(launchpad)).defaultQuote() : p.quote;
            IERC20(q).safeTransferFrom(msg.sender, address(this), p.creatorBuyQuoteIn);
            IERC20(q).forceApprove(address(launchpad), p.creatorBuyQuoteIn);
        }

        r = launchpad.launch(p);
        stealthOwnerOf[r.token] = stealthOwner;
        if (r.creatorTokensBought > 0) IERC20(r.token).safeTransfer(buyRecipient, r.creatorTokensBought);

        if (ephemeralPubKey.length > 0 && address(announcer) != address(0)) {
            announcer.announce(SCHEME_ID, stealthOwner, ephemeralPubKey, abi.encodePacked(viewTag, r.token));
        }
        emit LaunchFeePaid(r.token, fee);
        emit AnonLaunched(r.token, r.curve, stealthOwner, r.creatorTokensBought);
    }

    // ───────────────────────────── creator pack ─────────────────────────────

    function updateMetadataBySig(
        address token,
        string calldata imageURI,
        string calldata description,
        string calldata socialsURI,
        uint256 deadline,
        bytes calldata sig
    ) external {
        address so = stealthOwnerOf[token];
        bytes32 h = keccak256(
            abi.encode(
                METADATA_TYPEHASH,
                token,
                keccak256(bytes(imageURI)),
                keccak256(bytes(description)),
                keccak256(bytes(socialsURI)),
                nonces[so],
                deadline
            )
        );
        _useSig(so, h, deadline, sig);
        ILaunchpadAdmin(address(launchpad)).updateMetadata(token, imageURI, description, socialsURI);
    }

    /// @notice Move the stealth owner role. `newOwner` = address(0) is rejected. Unclaimed fees move with it.
    function transferCreatorBySig(address token, address newOwner, uint256 deadline, bytes calldata sig) external {
        if (newOwner == address(0)) revert ZeroAddress();
        address so = stealthOwnerOf[token];
        _useSig(so, keccak256(abi.encode(TRANSFER_TYPEHASH, token, newOwner, nonces[so], deadline)), deadline, sig);
        stealthOwnerOf[token] = newOwner;
        emit StealthOwnerTransferred(token, so, newOwner);
    }

    /// @notice Direct transfer by a stealth owner that does hold gas (or a smart account).
    function transferCreator(address token, address newOwner) external {
        if (stealthOwnerOf[token] != msg.sender) revert NotStealthOwner();
        if (newOwner == address(0)) revert ZeroAddress();
        stealthOwnerOf[token] = newOwner;
        emit StealthOwnerTransferred(token, msg.sender, newOwner);
    }

    // ───────────────────────────── claims ─────────────────────────────

    /// @notice Claimable for `token`: quote accrued in FeeRouter, plus the launch-token side = post-graduation
    ///         creator share accrued in FeeRouter (creatorTokenAccrued) + any `token` balance held here.
    function pending(address token) public view returns (address quote, uint256 quoteAmt, uint256 tokenAmt) {
        quote = feeRouter.tokenQuote(token);
        quoteAmt = feeRouter.creatorAccrued(token, address(this));
        if (stealthOwnerOf[token] != address(0)) {
            tokenAmt = feeRouter.creatorTokenAccrued(token, address(this)) + IERC20(token).balanceOf(address(this));
        }
    }

    function claimMany(address[] calldata tokens, address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        _claim(msg.sender, tokens, to, 0);
    }

    function claimManyBySig(ClaimReq calldata c) external nonReentrant {
        _claimBySig(c);
    }

    /// @notice Relayer batches many stealth owners' signed claims in one tx.
    function claimManyBySigBatch(ClaimReq[] calldata cs) external nonReentrant {
        for (uint256 i; i < cs.length; ++i) {
            _claimBySig(cs[i]);
        }
    }

    function claimDigest(
        address owner_,
        address[] calldata tokens,
        address to,
        uint256 relayerFeeBps,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    CLAIM_TYPEHASH, owner_, keccak256(abi.encodePacked(tokens)), to, relayerFeeBps, nonce, deadline
                )
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _claimBySig(ClaimReq calldata c) internal {
        if (c.to == address(0)) revert ZeroAddress();
        if (c.relayerFeeBps > MAX_RELAYER_FEE_BPS) revert FeeTooHigh();
        if (block.timestamp > c.deadline) revert Expired();
        bytes32 d = claimDigest(c.owner, c.tokens, c.to, c.relayerFeeBps, nonces[c.owner], c.deadline);
        if (!SignatureChecker.isValidSignatureNow(c.owner, d, c.sig)) revert BadSignature();
        unchecked {
            ++nonces[c.owner];
        }
        _claim(c.owner, c.tokens, c.to, c.relayerFeeBps);
    }

    /// @dev Per token: claim + pay the quote side and the launch-token side (each net of the same relayer fee).
    ///      FeeRouter reverts NothingToClaim on a zero balance, so each side is checked first and skipped when 0;
    ///      a token reverts NothingToClaim only when BOTH sides are 0. An empty `tokens` list is a no-op
    ///      (claimManyBySig with no tokens just burns the nonce).
    function _claim(address so, address[] calldata tokens, address to, uint256 relayerFeeBps) internal {
        IFeeRouterClaims fr = feeRouter;
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            if (stealthOwnerOf[token] != so) revert NotStealthOwner();
            uint256 qAmt = fr.creatorAccrued(token, address(this));
            if (qAmt > 0) {
                qAmt = fr.claimCreatorFees(token);
                _pay(token, so, fr.tokenQuote(token), qAmt, to, relayerFeeBps);
            }
            if (fr.creatorTokenAccrued(token, address(this)) > 0) fr.claimCreatorTokenFees(token);
            uint256 tAmt = IERC20(token).balanceOf(address(this));
            if (tAmt > 0) _pay(token, so, token, tAmt, to, relayerFeeBps);
            if (qAmt == 0 && tAmt == 0) revert NothingToClaim();
        }
    }

    function _pay(address token, address so, address asset, uint256 amt, address to, uint256 relayerFeeBps) internal {
        uint256 rf = (amt * relayerFeeBps) / 10_000;
        if (rf > 0) IERC20(asset).safeTransfer(msg.sender, rf);
        IERC20(asset).safeTransfer(to, amt - rf);
        emit Claimed(token, so, to, asset, amt - rf);
    }

    function _useSig(address so, bytes32 structHash, uint256 deadline, bytes calldata sig) internal {
        if (so == address(0)) revert NotStealthOwner();
        if (block.timestamp > deadline) revert Expired();
        if (!SignatureChecker.isValidSignatureNow(so, _hashTypedDataV4(structHash), sig)) revert BadSignature();
        unchecked {
            ++nonces[so];
        }
    }
}
