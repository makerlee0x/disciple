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

interface ICreatorFeeHarvest {
    function creatorFeeDestinationOf(address token) external view returns (uint8);
    function depositRocketTokens(address token, uint256 amount) external;
}

interface ILaunchpadAdmin {
    function defaultQuote() external view returns (address);
    function curveRouter() external view returns (address);
    function updateMetadata(address token, string calldata img, string calldata desc, string calldata socials) external;
    function transferCreator(address token, address newCreator) external;
}

/// @dev The public First BOOST path (DiscipleRouter.launchWithUsdg). AnonLauncher calls this so it stays the
///      on-chain creator; a player calling the router directly would become Token.creator.
interface IRouterLaunchWithUsdg {
    function launchWithUsdg(ILaunchpad.LaunchParams calldata p, uint8 mode, uint256 usdgIn, uint256 minQuoteIn)
        external
        returns (ILaunchpad.LaunchResult memory r, uint256 usdgRefund);
}

/// @notice ERC-5564 singleton announcer (deployed at 0x55649E01B5Df198D18D95b5cc5051630cfD45564).
/// @dev Launchpad.launchWithMode (0 Trench, 1 Easy, 2 Hard) and the Easy creator lock read on the new token.
interface ILaunchpadModes {
    function launchWithMode(ILaunchpad.LaunchParams calldata p, uint8 mode)
        external
        returns (ILaunchpad.LaunchResult memory);
}

interface ICreatorLockView {
    function creatorLockActive() external view returns (bool);
}

/// @dev Easy curves pay holder rewards (crew tips) on the NET position; the held First BOOST earns them here.
interface IPveRewards {
    function pendingRewards(address holder) external view returns (uint256);
    function claim() external returns (uint256);
    function quote() external view returns (address);
}

/// @dev maker 2026-11-19: DiscipleHook holds post-graduation fees until a public claim pays the creator (this contract).
interface IHookCreatorClaims {
    function claimable(address token, uint8 share) external view returns (uint256 quoteAmount, uint256 tokenAmount);
    function claimCreatorFees(address token) external returns (uint256 quoteAmount, uint256 tokenAmount);
    function creatorQuotePaidTo(address token, address payee) external view returns (uint256);
}

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
///      Gas sponsorship happens off-chain. Hidden launches are free: `launchFee` is the constant 0 (maker 2026-11-17).
///      Pseudonymous, not anonymous: the payer of the creator buy is visible on-chain.
///      v2: claims pay BOTH creator fee sides — quote (FeeRouter.creatorAccrued) and the post-graduation launch-token
///      share (FeeRouter.creatorTokenAccrued), which v1 could not reach. Ownership is two-step (Owned2Step).
///      The EIP-712 Claim struct and domain ("DISCIPLE AnonLauncher", "1") are unchanged; the domain binds
///      verifyingContract, so v1 and v2 signatures never cross-replay.
contract AnonLauncher is EIP712, ReentrancyGuard, Owned2Step {
    using SafeERC20 for IERC20;

    /// @notice Hidden launches are free forever (maker 2026-11-17). Kept as a view so existing callers still read 0.
    uint256 public constant launchFee = 0;
    /// @dev maker 2026-11-17: "the cut is 0". The signed relayerFeeBps field stays for the ABI; any non-zero value reverts.
    uint256 public constant MAX_RELAYER_FEE_BPS = 0;
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

    /// @notice Later-send contract. When set, coins it marks as destination 1 or 2 cannot be claimed here.
    address public creatorFeeHarvest;

    /// @notice DiscipleHook (post-graduation creator share). Write-once; unset = FeeRouter only.
    IHookCreatorClaims public hook;
    /// @notice Hook quote-side creator fees already paid on to the stealth owner, per coin. Anyone can trigger the
    ///         hook's creator claim, which pushes quote here; the hook's per-coin `creatorQuotePaidTo` tally minus this
    ///         is what that coin is still owed, so pooled quote (e.g. USDG) never mixes between coins.
    mapping(address => uint256) public hookQuoteSettled;

    mapping(address => address) public stealthOwnerOf; // token => stealth owner
    mapping(address => uint256) public nonces;

    /// @notice Easy (mode 1) First BOOST held here while the Token creator lock is on (this contract is the
    ///         on-chain creator, so the lock binds here). `releaseBoost` sends it to `recipient` after orbit.
    struct HeldBoost {
        address recipient;
        uint96 amount;
        address curve;
    }

    mapping(address => HeldBoost) public heldBoost; // token => held First BOOST

    struct ClaimReq {
        address owner;
        address[] tokens;
        address to;
        uint256 relayerFeeBps;
        uint256 deadline;
        bytes sig;
    }

    error ZeroAddress();
    error BadRefundTo();
    error RouterUnset();
    error FeeTooHigh();
    error NotStealthOwner();
    error Expired();
    error BadSignature();
    error NothingToClaim();
    /// @notice This coin's creator fees are sent later to the locked pool or the burn, not to the stealth owner.
    error CreatorFeesRouted();
    error NothingHeld();
    /// @notice maker 2026-11-19: hidden launches can't do a First BOOST (no quote / USDG ever passes through here).
    error NoFirstBoost();

    event AnonLaunched(
        address indexed token, address indexed curve, address indexed stealthOwner, uint256 tokensBought
    );
    event StealthOwnerTransferred(address indexed token, address indexed from, address indexed to);
    event Claimed(address indexed token, address indexed stealthOwner, address to, address asset, uint256 amount);
    event CreatorFeeHarvestSet(address harvest);
    event BoostHeld(address indexed token, address indexed recipient, uint256 amount);
    event BoostReleased(address indexed token, address indexed recipient, uint256 tokens, uint256 rewards);

    constructor(
        address owner_,
        address launchpad_,
        address feeRouter_,
        address feeToken_,
        address announcer_
    ) EIP712("DISCIPLE AnonLauncher", "1") Owned2Step(owner_) {
        if (owner_ == address(0) || launchpad_ == address(0) || feeRouter_ == address(0)) {
            revert ZeroAddress();
        }
        launchpad = ILaunchpad(launchpad_);
        feeRouter = IFeeRouterClaims(feeRouter_);
        feeToken = IERC20(feeToken_);
        announcer = IERC5564Announcer(announcer_);
    }

    // ───────────────────────────── admin ─────────────────────────────

    /// @notice Owner points claims at the later-send contract. Write-once and contracts only (audit L-14), matching
    ///         FeeRouter's harvest pointer. Unset keeps today's claim behavior.
    function setCreatorFeeHarvest(address harvest) external {
        _checkOwner();
        if (creatorFeeHarvest != address(0) || harvest.code.length == 0) revert ZeroAddress();
        creatorFeeHarvest = harvest;
        emit CreatorFeeHarvestSet(harvest);
    }

    /// @notice Owner points claims at DiscipleHook once (contracts only).
    function setHook(address hook_) external {
        _checkOwner();
        if (address(hook) != address(0) || hook_.code.length == 0) revert ZeroAddress();
        hook = IHookCreatorClaims(hook_);
    }

    // ───────────────────────────── launch ─────────────────────────────

    /// @notice Launch with a stealth creator. Payer (msg.sender, e.g. a sponsored smart account) pays
    ///         the optional creator buy (there is no launch fee); tokens bought go to `buyRecipient`.
    /// @param ephemeralPubKey ERC-5564 ephemeral pubkey (empty = no announcement).
    /// @param viewTag ERC-5564 view tag (first metadata byte).
    ///      The last argument (maxFee) is unused: kept so existing callers keep the same ABI. The fee is always 0.
    function launchAnon(
        ILaunchpad.LaunchParams calldata p,
        address stealthOwner,
        address buyRecipient,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag,
        uint256 /* maxFee */
    ) external nonReentrant returns (ILaunchpad.LaunchResult memory r) {
        r = _launchAnon(p, 0, stealthOwner, buyRecipient, ephemeralPubKey, viewTag);
    }

    /// @notice `launchAnon` on any difficulty: `mode` 0 Trench (Expert), 1 Easy, 2 Hard. On Easy the First BOOST
    ///         is locked on the creator (this contract) until orbit, so it is held here and `releaseBoost` sends it
    ///         to `buyRecipient` after graduation.
    function launchAnonWithMode(
        ILaunchpad.LaunchParams calldata p,
        uint8 mode,
        address stealthOwner,
        address buyRecipient,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag,
        uint256 /* maxFee */
    ) external nonReentrant returns (ILaunchpad.LaunchResult memory r) {
        r = _launchAnon(p, mode, stealthOwner, buyRecipient, ephemeralPubKey, viewTag);
    }

    function _launchAnon(
        ILaunchpad.LaunchParams calldata p,
        uint8 mode,
        address stealthOwner,
        address buyRecipient,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag
    ) internal returns (ILaunchpad.LaunchResult memory r) {
        if (stealthOwner == address(0)) revert ZeroAddress();
        if (buyRecipient == address(0)) buyRecipient = stealthOwner;


        if (p.creatorBuyQuoteIn != 0) revert NoFirstBoost();

        r = ILaunchpadModes(address(launchpad)).launchWithMode(p, mode);
        stealthOwnerOf[r.token] = stealthOwner;
        _sendBoost(r, buyRecipient);

        if (ephemeralPubKey.length > 0 && address(announcer) != address(0)) {
            announcer.announce(SCHEME_ID, stealthOwner, ephemeralPubKey, abi.encodePacked(viewTag, r.token));
        }
        emit AnonLaunched(r.token, r.curve, stealthOwner, r.creatorTokensBought);
    }

    /// @notice Same as `launchAnon`, but the optional First BOOST is paid in USDG (`feeToken`) through
    ///         DiscipleRouter.launchWithUsdg: USDG is swapped to the pair token when needed, the curve buy
    ///         runs in the same transaction, and any leftover is refunded in USDG to `refundTo`. Trench mode, like
    ///         `launchAnon`; `launchAnonWithUsdgMode` picks the difficulty. `p.creatorBuyQuoteIn` is ignored (the router overwrites it). Tokens
    ///         bought go to `buyRecipient` (the stealth owner when that is empty).
    /// @param refundTo recipient of leftover USDG (the unused First BOOST after a partial fill, including
    ///        pair-token leftovers the router already swapped back to USDG). address(0) means msg.sender.
    ///        Cannot be this launcher. The First BOOST USDG is still pulled from msg.sender.
    function launchAnonWithUsdg(
        ILaunchpad.LaunchParams calldata p,
        address stealthOwner,
        address buyRecipient,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag,
        uint256 /* maxFee */,
        uint256 usdgIn,
        uint256 minQuoteIn,
        address refundTo
    ) external nonReentrant returns (ILaunchpad.LaunchResult memory r, uint256 usdgRefund) {
        (r, usdgRefund) = _launchAnonWithUsdg(
            p, 0, stealthOwner, buyRecipient, ephemeralPubKey, viewTag, usdgIn, minQuoteIn, refundTo
        );
    }

    /// @notice `launchAnonWithUsdg` on any difficulty (`mode` 0 Trench, 1 Easy, 2 Hard). Easy holds the First
    ///         BOOST here until orbit, like `launchAnonWithMode`.
    function launchAnonWithUsdgMode(
        ILaunchpad.LaunchParams calldata p,
        uint8 mode,
        address stealthOwner,
        address buyRecipient,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag,
        uint256 /* maxFee */,
        uint256 usdgIn,
        uint256 minQuoteIn,
        address refundTo
    ) external nonReentrant returns (ILaunchpad.LaunchResult memory r, uint256 usdgRefund) {
        (r, usdgRefund) = _launchAnonWithUsdg(
            p, mode, stealthOwner, buyRecipient, ephemeralPubKey, viewTag, usdgIn, minQuoteIn, refundTo
        );
    }

    function _launchAnonWithUsdg(
        ILaunchpad.LaunchParams calldata p,
        uint8 mode,
        address stealthOwner,
        address buyRecipient,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag,
        uint256 usdgIn,
        uint256 minQuoteIn,
        address refundTo
    ) internal returns (ILaunchpad.LaunchResult memory r, uint256 usdgRefund) {
        if (stealthOwner == address(0)) revert ZeroAddress();
        if (buyRecipient == address(0)) buyRecipient = stealthOwner;
        address refund = refundTo == address(0) ? msg.sender : refundTo;
        if (refund == address(this)) revert BadRefundTo();


        address router = ILaunchpadAdmin(address(launchpad)).curveRouter();
        if (router == address(0)) revert RouterUnset();

        if (usdgIn != 0 || p.creatorBuyQuoteIn != 0) revert NoFirstBoost();

        (r, usdgRefund) = IRouterLaunchWithUsdg(router).launchWithUsdg(p, mode, 0, minQuoteIn);

        stealthOwnerOf[r.token] = stealthOwner;
        _sendBoost(r, buyRecipient);

        if (ephemeralPubKey.length > 0 && address(announcer) != address(0)) {
            announcer.announce(SCHEME_ID, stealthOwner, ephemeralPubKey, abi.encodePacked(viewTag, r.token));
        }
        emit AnonLaunched(r.token, r.curve, stealthOwner, r.creatorTokensBought);
    }

    /// @dev Trench / Hard: forward the First BOOST now. Easy: the Token creator lock keeps it on this contract until
    ///      orbit, so record it for `releaseBoost`.
    function _sendBoost(ILaunchpad.LaunchResult memory r, address to) internal {
        uint256 amt = r.creatorTokensBought;
        if (amt == 0) return;
        if (ICreatorLockView(r.token).creatorLockActive()) {
            heldBoost[r.token] = HeldBoost({recipient: to, amount: uint96(amt), curve: r.curve});
            emit BoostHeld(r.token, to, amt);
        } else {
            IERC20(r.token).safeTransfer(to, amt);
        }
    }

    /// @notice Anyone: send an Easy coin's held First BOOST to its recipient once the creator lock is off (orbit),
    ///         plus the Easy holder rewards it earned on the curve. Before orbit it only pays out the rewards so far.
    function releaseBoost(address token) external nonReentrant {
        HeldBoost memory h = heldBoost[token];
        if (h.recipient == address(0)) revert NothingHeld();
        uint256 rewards;
        IPveRewards c = IPveRewards(h.curve);
        if (c.pendingRewards(address(this)) != 0) {
            rewards = c.claim();
            IERC20(c.quote()).safeTransfer(h.recipient, rewards);
        }
        uint256 tokens;
        if (!ICreatorLockView(token).creatorLockActive()) {
            tokens = h.amount;
            delete heldBoost[token];
            IERC20(token).safeTransfer(h.recipient, tokens);
        }
        if (tokens == 0 && rewards == 0) revert NothingToClaim();
        emit BoostReleased(token, h.recipient, tokens, rewards);
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
        unchecked {
            ++nonces[msg.sender]; // audit L-01: a direct transfer also voids the old owner's pending signatures
        }
        emit StealthOwnerTransferred(token, msg.sender, newOwner);
    }

    // ───────────────────────────── claims ─────────────────────────────

    /// @notice Claimable for `token`: quote accrued in FeeRouter, plus the launch-token side = post-graduation
    ///         creator share accrued in FeeRouter (creatorTokenAccrued) + any `token` balance held here,
    ///         minus a held Easy First BOOST (`heldBoost`).
    function pending(address token) public view returns (address quote, uint256 quoteAmt, uint256 tokenAmt) {
        quote = feeRouter.tokenQuote(token);
        quoteAmt = feeRouter.creatorAccrued(token, address(this));
        if (stealthOwnerOf[token] != address(0)) {
            tokenAmt = feeRouter.creatorTokenAccrued(token, address(this)) + IERC20(token).balanceOf(address(this))
                - heldBoost[token].amount;
            IHookCreatorClaims h = hook;
            if (address(h) != address(0)) {
                quoteAmt += h.creatorQuotePaidTo(token, address(this)) - hookQuoteSettled[token];
                if (launchpad.creatorOf(token) == address(this)) {
                    (uint256 hq, uint256 ht) = h.claimable(token, 0);
                    quoteAmt += hq;
                    tokenAmt += ht;
                }
            }
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
            if (_feesRouted(token)) revert CreatorFeesRouted();
            uint256 qAmt = fr.creatorAccrued(token, address(this));
            if (qAmt > 0) qAmt = fr.claimCreatorFees(token);
            qAmt += _hookQuote(token);
            if (qAmt > 0) _pay(token, so, fr.tokenQuote(token), qAmt, to, relayerFeeBps);
            if (fr.creatorTokenAccrued(token, address(this)) > 0) fr.claimCreatorTokenFees(token);
            uint256 tAmt = IERC20(token).balanceOf(address(this)) - heldBoost[token].amount;
            if (tAmt > 0) _pay(token, so, token, tAmt, to, relayerFeeBps);
            if (qAmt == 0 && tAmt == 0) revert NothingToClaim();
        }
    }

    /// @dev Pull this coin's hook creator share here (rocket tokens land in the balance read below) and return the
    ///      hook quote this coin is owed (including any quote a third party's public claim already pushed here).
    function _hookQuote(address token) internal returns (uint256 q) {
        IHookCreatorClaims h = hook;
        if (address(h) == address(0)) return 0;
        (uint256 hq, uint256 ht) = h.claimable(token, 0);
        if ((hq != 0 || ht != 0) && launchpad.creatorOf(token) == address(this)) h.claimCreatorFees(token);
        uint256 paid = h.creatorQuotePaidTo(token, address(this));
        q = paid - hookQuoteSettled[token];
        hookQuoteSettled[token] = paid;
    }

    /// @dev Destination 1 or 2 on the later-send contract. Unset harvest means every coin is still claimable here.
    function _feesRouted(address token) internal view returns (bool) {
        address harvest = creatorFeeHarvest;
        if (harvest == address(0)) return false;
        uint8 dest = ICreatorFeeHarvest(harvest).creatorFeeDestinationOf(token);
        return dest == 1 || dest == 2;
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
