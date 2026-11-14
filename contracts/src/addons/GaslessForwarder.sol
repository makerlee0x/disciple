// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ILaunchpad} from "../interfaces/ILaunchpad.sol";

/// @dev Canonical Uniswap Permit2, ISignatureTransfer witness subset (same shape as DiscipleRouter's IPermit2Witness).
interface IPermit2Witness {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitWitnessTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;
}

interface IAnonLaunchUsdg {
    function launchAnonWithUsdg(
        ILaunchpad.LaunchParams calldata p,
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

interface IHarvestLaunchAnonUsdg {
    function launchAnonWithUsdg(
        ILaunchpad.LaunchParams calldata p,
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

/// @title GaslessForwarder
/// @notice The Permit2 spender for the app's gasless (relayer-submitted) USDG moves: withdrawals, action fees and private
///         launches. It replaces the public Multicall3 as spender (Vercel finding 2026-11-14 "Public Multicall3 permits let
///         observers redirect gasless withdrawals"): with Multicall3 as spender, anyone holding an unused signature could
///         call Permit2 through Multicall3 with a `to` of their choice, because the recipient was not signed.
///
///         Here every payout is part of the signed Permit2 witness (PermitWitnessTransferFrom), and this contract only
///         ever pays the signed addresses. Nothing the caller passes outside the signature changes where funds go, so
///         anyone may submit a signature (no trusted relayer) and a leaked or reverted signature can only do what the
///         player signed. No owner, no admin, no upgrade, holds no funds between transactions.
///
///         Same Permit2 witness pattern as DiscipleRouter.buyWithPermit2 (0x Gasless / Uniswap UniversalRouter).
contract GaslessForwarder is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @dev Canonical Uniswap Permit2, same address on every chain incl. Robinhood 4663 / 46630.
    IPermit2Witness public constant PERMIT2 = IPermit2Witness(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    // ───────── EIP-712 witness types (Permit2 appends the witness type string after "...uint256 deadline,";
    //           referenced struct types are listed in alphabetical order, as EIP-712 encodeType requires) ─────────

    string public constant WITHDRAW_TYPE = "Withdraw(address to,uint256 amount,uint256 fee,address feeTo)";
    bytes32 public constant WITHDRAW_TYPEHASH = keccak256(bytes(WITHDRAW_TYPE));
    string public constant WITHDRAW_WITNESS_TYPE =
        "Withdraw witness)TokenPermissions(address token,uint256 amount)Withdraw(address to,uint256 amount,uint256 fee,address feeTo)";

    string public constant ACTION_FEE_TYPE = "ActionFee(uint256 fee,address feeTo,bytes32 callsHash)";
    bytes32 public constant ACTION_FEE_TYPEHASH = keccak256(bytes(ACTION_FEE_TYPE));
    string public constant ACTION_FEE_WITNESS_TYPE =
        "ActionFee witness)ActionFee(uint256 fee,address feeTo,bytes32 callsHash)TokenPermissions(address token,uint256 amount)";

    string public constant ANON_LAUNCH_TYPE =
        "AnonLaunch(string name,string ticker,string imageURI,string description,string socialsURI,address quote,uint256 creatorTaxBps,uint256 creatorBuyQuoteIn,uint256 creatorBuyMinTokensOut,uint256 deadline,address stealthOwner,address buyRecipient,bytes ephemeralPubKey,bytes1 viewTag,uint256 maxFee,uint256 usdgIn,uint256 minQuoteIn,address refundTo,address launcher,uint8 creatorFeeDestination)";
    bytes32 public constant ANON_LAUNCH_TYPEHASH = keccak256(bytes(ANON_LAUNCH_TYPE));
    string public constant ANON_LAUNCH_WITNESS_TYPE =
        "AnonLaunch witness)AnonLaunch(string name,string ticker,string imageURI,string description,string socialsURI,address quote,uint256 creatorTaxBps,uint256 creatorBuyQuoteIn,uint256 creatorBuyMinTokensOut,uint256 deadline,address stealthOwner,address buyRecipient,bytes ephemeralPubKey,bytes1 viewTag,uint256 maxFee,uint256 usdgIn,uint256 minQuoteIn,address refundTo,address launcher,uint8 creatorFeeDestination)TokenPermissions(address token,uint256 amount)";

    /// @notice A withdrawal: `amount` to `to`, plus `fee` to `feeTo` (the relayer's gas, paid in the same token).
    struct Withdraw {
        address to;
        uint256 amount;
        uint256 fee;
        address feeTo;
    }

    /// @notice A relayed action's fee. `callsHash` = keccak256(abi.encode(calls)) binds the fee to exactly these calls.
    struct ActionFee {
        uint256 fee;
        address feeTo;
        bytes32 callsHash;
    }

    struct Call {
        address target;
        bytes data;
    }

    /// @notice A private launch. Same fields as the app's AnonLaunch witness (web/lib/trade/gaslessAnonLaunch.ts).
    struct AnonLaunch {
        ILaunchpad.LaunchParams p;
        address stealthOwner;
        address buyRecipient;
        bytes ephemeralPubKey;
        bytes1 viewTag;
        uint256 maxFee;
        uint256 usdgIn;
        uint256 minQuoteIn;
        address refundTo;
        address launcher;
        uint8 creatorFeeDestination;
    }

    event GaslessWithdraw(address indexed owner, address indexed token, address indexed to, uint256 amount, uint256 fee, address feeTo);
    event GaslessActionFee(address indexed owner, address indexed token, address indexed feeTo, uint256 fee, bytes32 callsHash);
    event GaslessAnonLaunch(address indexed owner, address indexed launcher, address token, uint256 refund);

    error ZeroAddress();
    error AmountMismatch();
    error CallsMismatch();
    error ForbiddenTarget(address target);
    error BadDestination();

    // ───────────────────────────────────────── withdraw ─────────────────────────────────────────

    /// @notice Moves `w.amount + w.fee` of `permit.permitted.token` from `owner`: `w.amount` to `w.to`, `w.fee` to `w.feeTo`.
    ///         The permit must be for exactly that total.
    function withdraw(
        IPermit2Witness.PermitTransferFrom calldata permit,
        address owner,
        Withdraw calldata w,
        bytes calldata signature
    ) external nonReentrant {
        if (w.to == address(0) || (w.fee != 0 && w.feeTo == address(0))) revert ZeroAddress();
        uint256 total = w.amount + w.fee;
        if (permit.permitted.amount != total) revert AmountMismatch();
        PERMIT2.permitWitnessTransferFrom(
            permit,
            IPermit2Witness.SignatureTransferDetails({to: address(this), requestedAmount: total}),
            owner,
            hashWithdraw(w),
            WITHDRAW_WITNESS_TYPE,
            signature
        );
        IERC20 token = IERC20(permit.permitted.token);
        token.safeTransfer(w.to, w.amount);
        if (w.fee != 0) token.safeTransfer(w.feeTo, w.fee);
        emit GaslessWithdraw(owner, address(token), w.to, w.amount, w.fee, w.feeTo);
    }

    // ───────────────────────────────────────── action fee ─────────────────────────────────────────

    /// @notice Pays `f.fee` from `owner` straight to `f.feeTo`, then runs `calls` (each must already authorise itself:
    ///         a *BySig call or a permissionless one; this contract has no privileges anywhere). The fee is bound to the
    ///         exact calls, so a leaked fee signature cannot be spent without running them.
    /// @dev    Calls to Permit2 or to this contract are refused: they are the only way a call could use another player's
    ///         Permit2 signature naming this contract as spender.
    function payFeeAndCall(
        IPermit2Witness.PermitTransferFrom calldata permit,
        address owner,
        ActionFee calldata f,
        Call[] calldata calls,
        bytes calldata signature
    ) external nonReentrant {
        if (f.feeTo == address(0)) revert ZeroAddress();
        if (permit.permitted.amount != f.fee) revert AmountMismatch();
        if (keccak256(abi.encode(calls)) != f.callsHash) revert CallsMismatch();
        PERMIT2.permitWitnessTransferFrom(
            permit,
            IPermit2Witness.SignatureTransferDetails({to: f.feeTo, requestedAmount: f.fee}),
            owner,
            hashActionFee(f),
            ACTION_FEE_WITNESS_TYPE,
            signature
        );
        emit GaslessActionFee(owner, permit.permitted.token, f.feeTo, f.fee, f.callsHash);
        for (uint256 i; i < calls.length; ++i) {
            address t = calls[i].target;
            if (t == address(PERMIT2) || t == address(this)) revert ForbiddenTarget(t);
            (bool ok, bytes memory ret) = t.call(calls[i].data);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }

    // ───────────────────────────────────────── private launch ─────────────────────────────────────────

    /// @notice Pulls `maxFee + usdgIn` USDG from `owner`, launches through the signed `launcher` (AnonLauncher when
    ///         `creatorFeeDestination` is 0, CreatorFeeHarvest for 1 or 2) and sends any leftover to the signed `refundTo`.
    ///         A failed launch reverts the whole call, so the player's USDG never moves.
    function launchAnon(
        IPermit2Witness.PermitTransferFrom calldata permit,
        address owner,
        AnonLaunch calldata l,
        bytes calldata signature
    ) external nonReentrant returns (ILaunchpad.LaunchResult memory r) {
        if (l.launcher == address(0) || l.refundTo == address(0)) revert ZeroAddress();
        if (l.creatorFeeDestination > 2) revert BadDestination();
        uint256 amount = l.maxFee + l.usdgIn;
        if (permit.permitted.amount != amount) revert AmountMismatch();
        IERC20 token = IERC20(permit.permitted.token);
        uint256 before = token.balanceOf(address(this));
        PERMIT2.permitWitnessTransferFrom(
            permit,
            IPermit2Witness.SignatureTransferDetails({to: address(this), requestedAmount: amount}),
            owner,
            hashAnonLaunch(l),
            ANON_LAUNCH_WITNESS_TYPE,
            signature
        );
        token.forceApprove(l.launcher, amount);
        if (l.creatorFeeDestination == 0) {
            (r,) = IAnonLaunchUsdg(l.launcher).launchAnonWithUsdg(
                l.p, l.stealthOwner, l.buyRecipient, l.ephemeralPubKey, l.viewTag, l.maxFee, l.usdgIn, l.minQuoteIn, l.refundTo
            );
        } else {
            (r,) = IHarvestLaunchAnonUsdg(l.launcher).launchAnonWithUsdg(
                l.p,
                l.stealthOwner,
                l.buyRecipient,
                l.ephemeralPubKey,
                l.viewTag,
                l.maxFee,
                l.usdgIn,
                l.minQuoteIn,
                l.refundTo,
                l.creatorFeeDestination
            );
        }
        token.forceApprove(l.launcher, 0);
        // the launcher refunds to refundTo itself; anything it left here (e.g. a fee change) goes there too
        uint256 left = token.balanceOf(address(this)) - before;
        if (left != 0) token.safeTransfer(l.refundTo, left);
        emit GaslessAnonLaunch(owner, l.launcher, r.token, left);
    }

    // ───────────────────────────────────────── hashing ─────────────────────────────────────────

    function hashWithdraw(Withdraw calldata w) public pure returns (bytes32) {
        return keccak256(abi.encode(WITHDRAW_TYPEHASH, w.to, w.amount, w.fee, w.feeTo));
    }

    function hashActionFee(ActionFee calldata f) public pure returns (bytes32) {
        return keccak256(abi.encode(ACTION_FEE_TYPEHASH, f.fee, f.feeTo, f.callsHash));
    }

    function hashCalls(Call[] calldata calls) external pure returns (bytes32) {
        return keccak256(abi.encode(calls));
    }

    function hashAnonLaunch(AnonLaunch calldata l) public pure returns (bytes32) {
        // two halves keep the encoder's stack small; same bytes as one abi.encode of all 21 words
        bytes memory a = abi.encode(
            ANON_LAUNCH_TYPEHASH,
            keccak256(bytes(l.p.name)),
            keccak256(bytes(l.p.ticker)),
            keccak256(bytes(l.p.imageURI)),
            keccak256(bytes(l.p.description)),
            keccak256(bytes(l.p.socialsURI)),
            l.p.quote,
            l.p.creatorTaxBps,
            l.p.creatorBuyQuoteIn,
            l.p.creatorBuyMinTokensOut,
            l.p.deadline
        );
        bytes memory b = abi.encode(
            l.stealthOwner,
            l.buyRecipient,
            keccak256(l.ephemeralPubKey),
            l.viewTag,
            l.maxFee,
            l.usdgIn,
            l.minQuoteIn,
            l.refundTo,
            l.launcher,
            l.creatorFeeDestination
        );
        return keccak256(bytes.concat(a, b));
    }
}
