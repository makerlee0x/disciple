// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Constants} from "../libraries/Constants.sol";

interface IFeeRouterClaimRouterPull {
    function creatorAccrued(address token, address creator) external view returns (uint256);
    function creatorTokenAccrued(address token, address creator) external view returns (uint256);
    function claimCreatorFeesFor(address token, address creator) external returns (uint256);
    function claimCreatorTokenFeesFor_15(address token, address creator) external returns (uint256);
}

interface ICurveFeeVaultRouterPull {
    function claimCreatorFeesToRouter(address token, address creator) external returns (uint256);
}

interface ILaunchpadCurve {
    function curveOf(address token) external view returns (address);
}

interface ICurveQuote {
    function quote() external view returns (address);
}

/// @title Owner-yes creator claim for normal rockets
/// @notice A normal rocket's creator signs a yes; anyone (the gasless relayer) submits it; the creator is paid.
/// @dev Reuses two things that already exist, and changes neither:
///      1. The signed claim of private launches: AnonLauncher.claimManyBySig / CurveFeeVault.claimManyAsStealthBySig.
///         Same EIP-712 `Claim` struct and the same rules (deadline, per-owner nonce, relayer fee <= 5% to
///         msg.sender, an empty token list only uses up the nonce). Domain: "DISCIPLE CreatorClaim" "1".
///      2. The claim-router pull: FeeRouter.claimCreatorFeesFor / claimCreatorTokenFeesFor_15 and
///         CurveFeeVault.claimCreatorFeesToRouter, which pay the calling router. They only accept a router the
///         FeeRouter owner approved with setClaimRouter. Until the owner approves this contract, every claim here
///         reverts in FeeRouter / the vault (OnlyAuthorized / OnlyClaimRouter).
///      The paid wallet is the address ECDSA.recover returns for the signature. `owner` in the request only names it
///      (it is part of the signed struct and picks the nonce) and must equal the recovered signer. Only that
///      wallet's accrued balances are pulled. Payout is the pair coin and the rocket token, straight to `to`, the
///      same shape as a private-launch claim. No owner, no admin, holds nothing between calls.
contract CreatorClaimBySig is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_RELAYER_FEE_BPS = 500; // 5%, same cap as AnonLauncher / CurveFeeVault
    /// @notice Same struct string as AnonLauncher.CLAIM_TYPEHASH (the domain binds this contract).
    bytes32 public constant CLAIM_TYPEHASH = keccak256(
        "Claim(address owner,address[] tokens,address to,uint256 relayerFeeBps,uint256 nonce,uint256 deadline)"
    );

    IFeeRouterClaimRouterPull public immutable feeRouter;
    ILaunchpadCurve public immutable launchpad;

    mapping(address => uint256) public nonces;

    /// @dev Same tuple as AnonLauncher.ClaimReq.
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
    error Expired();
    error BadSignature();
    error UnknownToken(address token);
    error NothingToClaim();

    event CreatorClaimedBySig(
        address indexed token, address indexed creator, address to, uint256 quoteAmount, uint256 tokenAmount
    );

    constructor(address feeRouter_, address launchpad_) EIP712("DISCIPLE CreatorClaim", "1") {
        if (feeRouter_ == address(0) || launchpad_ == address(0)) revert ZeroAddress();
        feeRouter = IFeeRouterClaimRouterPull(feeRouter_);
        launchpad = ILaunchpadCurve(launchpad_);
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

    /// @notice Pay the signer's creator fees on `c.tokens` to `c.to`. Per token: the curve-phase vault balance
    ///         (when the coin has a vault), the FeeRouter quote balance and the FeeRouter rocket-token balance.
    ///         A token with nothing on any side reverts NothingToClaim.
    /// @return creator the wallet that signed (and was paid for)
    function claimCreatorFeesBySig(ClaimReq calldata c) external nonReentrant returns (address creator) {
        if (c.to == address(0)) revert ZeroAddress();
        if (c.relayerFeeBps > MAX_RELAYER_FEE_BPS) revert FeeTooHigh();
        if (block.timestamp > c.deadline) revert Expired();
        bytes32 d = claimDigest(c.owner, c.tokens, c.to, c.relayerFeeBps, nonces[c.owner], c.deadline);
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(d, c.sig);
        if (err != ECDSA.RecoverError.NoError || signer == address(0) || signer != c.owner) revert BadSignature();
        creator = signer;
        unchecked {
            ++nonces[creator];
        }
        for (uint256 i; i < c.tokens.length; ++i) {
            _claimOne(c.tokens[i], creator, c.to, c.relayerFeeBps);
        }
    }

    function _claimOne(address token, address creator, address to, uint256 relayerFeeBps) internal {
        address curve = launchpad.curveOf(token);
        if (curve == address(0)) revert UnknownToken(token);
        address quote = ICurveQuote(curve).quote();
        IFeeRouterClaimRouterPull fr = feeRouter;
        uint256 q;
        address v = _feeVaultOf(curve);
        if (v != address(0)) q = ICurveFeeVaultRouterPull(v).claimCreatorFeesToRouter(token, creator);
        if (fr.creatorAccrued(token, creator) != 0) q += fr.claimCreatorFeesFor(token, creator);
        uint256 t;
        if (fr.creatorTokenAccrued(token, creator) != 0) t = fr.claimCreatorTokenFeesFor_15(token, creator);
        if (q == 0 && t == 0) revert NothingToClaim();
        if (q != 0) _pay(quote, q, to, relayerFeeBps);
        if (t != 0) _pay(token, t, to, relayerFeeBps);
        emit CreatorClaimedBySig(token, creator, to, q, t);
    }

    function _pay(address asset, uint256 amount, address to, uint256 relayerFeeBps) internal {
        uint256 rf = (amount * relayerFeeBps) / Constants.BPS_DENOM;
        if (rf != 0) IERC20(asset).safeTransfer(msg.sender, rf);
        IERC20(asset).safeTransfer(to, amount - rf);
    }

    /// @dev lp-accrue curves expose `feeVault()`; older curves don't (address(0): FeeRouter only). Same probe as
    ///      DiscipleRouter._feeVaultOf.
    function _feeVaultOf(address curve) internal view returns (address v) {
        (bool ok, bytes memory r) = curve.staticcall(abi.encodeWithSignature("feeVault()"));
        if (ok && r.length >= 32) v = abi.decode(r, (address));
    }
}
