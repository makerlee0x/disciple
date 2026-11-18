// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ILaunchpad} from "../interfaces/ILaunchpad.sol";

/// @dev Canonical Uniswap Permit2 (ISignatureTransfer, witness variant). Same address on every chain incl. Robinhood 4663/46630.
interface IPermit2SignatureTransfer {
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

/// @dev AnonLauncher.launchAnonWithUsdgMode (creatorFeeDestination 0).
interface IAnonLaunchUsdg {
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

/// @dev CreatorFeeHarvest.launchAnonWithUsdgMode (creatorFeeDestination 1 locked pool / 2 buy-and-burn).
interface IHarvestLaunchUsdg {
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

/// @title DisciplePermitForwarder
/// @notice The Permit2 spender for DISCIPLE's relayed (gasless) flows: withdrawals, relayed actions' USDG fee and the private
///         launch payment. It replaces the public Multicall3 as spender (Vercel finding "Public Multicall3 permits let observers
///         redirect gasless withdrawals", 2026-11-14): with Multicall3 as spender, Permit2 only checked msg.sender, so anyone
///         holding an unused signature could call Permit2 through Multicall3 with a recipient of their choice.
///
///         Here every recipient, fee, fee recipient, relayed call and launch field is part of the Permit2 WITNESS the player
///         signed, and this contract builds the transfers from that witness. Nothing about where the money goes comes from
///         the caller, so anyone may submit a signature (the relayer, the player, or someone who saw it): it can only do what
///         the player signed. The contract has no owner, no admin, no upgrade path and holds no funds between transactions.
///
/// Rules that keep that true:
///   - Relayed calls (action) are hashed into the signed witness and may never target Permit2, this contract, or the token
///     being moved, so a call can't consume another player's signature or spend a balance in flight.
///   - Every entry point is nonReentrant (a launcher or claim target can't re-enter while a launch's USDG is in flight).
///   - A launch sends any leftover of its own payment back to the signed refund address in the same transaction.
contract DisciplePermitForwarder is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // ───────── witness types (EIP-712: referenced structs in alphabetical order after the primary witness type) ─────────

    struct Withdraw {
        address to;
        uint256 fee;
        address feeTo;
    }

    string public constant WITHDRAW_TYPE = "Withdraw(address to,uint256 fee,address feeTo)";
    bytes32 public constant WITHDRAW_TYPEHASH = keccak256(bytes(WITHDRAW_TYPE));
    string public constant WITHDRAW_WITNESS_TYPE =
        "Withdraw witness)TokenPermissions(address token,uint256 amount)Withdraw(address to,uint256 fee,address feeTo)";

    struct Call {
        address target;
        bytes data;
    }

    /// @dev `callsHash` = keccak256(abi.encode(Call[])) of the calls the relayer must run, in order.
    struct Action {
        address feeTo;
        bytes32 callsHash;
    }

    string public constant ACTION_TYPE = "Action(address feeTo,bytes32 callsHash)";
    bytes32 public constant ACTION_TYPEHASH = keccak256(bytes(ACTION_TYPE));
    string public constant ACTION_WITNESS_TYPE =
        "Action witness)Action(address feeTo,bytes32 callsHash)TokenPermissions(address token,uint256 amount)";

    struct AnonLaunch {
        string name;
        string ticker;
        string imageURI;
        string description;
        string socialsURI;
        address quote;
        uint256 creatorTaxBps;
        uint256 creatorBuyQuoteIn;
        uint256 creatorBuyMinTokensOut;
        uint256 deadline;
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
        uint8 mode; // 0 Trench (Expert), 1 Easy, 2 Hard
    }

    string public constant ANON_LAUNCH_TYPE =
        "AnonLaunch(string name,string ticker,string imageURI,string description,string socialsURI,address quote,uint256 creatorTaxBps,uint256 creatorBuyQuoteIn,uint256 creatorBuyMinTokensOut,uint256 deadline,address stealthOwner,address buyRecipient,bytes ephemeralPubKey,bytes1 viewTag,uint256 maxFee,uint256 usdgIn,uint256 minQuoteIn,address refundTo,address launcher,uint8 creatorFeeDestination,uint8 mode)";
    bytes32 public constant ANON_LAUNCH_TYPEHASH = keccak256(bytes(ANON_LAUNCH_TYPE));
    string public constant ANON_LAUNCH_WITNESS_TYPE =
        "AnonLaunch witness)AnonLaunch(string name,string ticker,string imageURI,string description,string socialsURI,address quote,uint256 creatorTaxBps,uint256 creatorBuyQuoteIn,uint256 creatorBuyMinTokensOut,uint256 deadline,address stealthOwner,address buyRecipient,bytes ephemeralPubKey,bytes1 viewTag,uint256 maxFee,uint256 usdgIn,uint256 minQuoteIn,address refundTo,address launcher,uint8 creatorFeeDestination,uint8 mode)TokenPermissions(address token,uint256 amount)";

    /// @notice One-time EIP-2612 approval of Permit2 by the player (value 0 = none). Submitted with try/catch: if someone
    ///         used it first the allowance is already there, and if it is missing the Permit2 transfer reverts instead.
    struct Approval {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    error ZeroAddress();
    error FeeTooHigh();
    error CallsMismatch();
    error ForbiddenTarget(address target);
    error CallFailed(uint256 index, bytes reason);
    error AmountMismatch();
    error BadDestination();

    event Withdrawn(
        address indexed owner, address indexed token, address indexed to, uint256 net, uint256 fee, address feeTo
    );
    event ActionRelayed(
        address indexed owner, address indexed token, address indexed feeTo, uint256 fee, bytes32 callsHash
    );
    event AnonLaunchRelayed(
        address indexed owner, address indexed token, address curve, address launcher, uint256 refunded
    );

    // ───────── withdraw ─────────

    /// @notice Gasless withdrawal: moves `permit.permitted.amount` of the token from `owner`, `amount − w.fee` to `w.to` and
    ///         `w.fee` to `w.feeTo`, exactly as signed.
    function withdraw(
        IPermit2SignatureTransfer.PermitTransferFrom calldata permit,
        Withdraw calldata w,
        address owner,
        bytes calldata signature,
        Approval calldata approval
    ) external nonReentrant {
        if (w.to == address(0) || (w.fee > 0 && w.feeTo == address(0))) revert ZeroAddress();
        uint256 amount = permit.permitted.amount;
        if (w.fee > amount) revert FeeTooHigh();
        IERC20 token = IERC20(permit.permitted.token);
        _approvePermit2(address(token), owner, approval);

        IPermit2SignatureTransfer(PERMIT2)
            .permitWitnessTransferFrom(
                permit,
                IPermit2SignatureTransfer.SignatureTransferDetails({to: address(this), requestedAmount: amount}),
                owner,
                hashWithdraw(w),
                WITHDRAW_WITNESS_TYPE,
                signature
            );
        uint256 net = amount - w.fee;
        if (net > 0) token.safeTransfer(w.to, net);
        if (w.fee > 0) token.safeTransfer(w.feeTo, w.fee);
        emit Withdrawn(owner, address(token), w.to, net, w.fee, w.feeTo);
    }

    // ───────── action (relayed claim / creator transfer / tramp pull, fee in token) ─────────

    /// @notice Pays the signed fee straight to the signed fee recipient, then runs exactly the signed calls (in order, all or
    ///         nothing). The calls are the contracts' own on-behalf / signature / permissionless functions, as before.
    /// @param sweep tokens a call may pay to its caller (a claim's relayer cut, a tramp pull's keeper tip). Whatever this
    ///        contract gained in them during the calls goes to the signed fee recipient, so nothing is left here for anyone
    ///        else to take. Only this transaction's gains move, and only to `a.feeTo`, so the list needs no signature.
    function action(
        IPermit2SignatureTransfer.PermitTransferFrom calldata permit,
        Action calldata a,
        Call[] calldata calls,
        address owner,
        bytes calldata signature,
        Approval calldata approval,
        address[] calldata sweep
    ) external nonReentrant {
        if (a.feeTo == address(0)) revert ZeroAddress();
        if (keccak256(abi.encode(calls)) != a.callsHash) revert CallsMismatch();
        address token = permit.permitted.token;
        _approvePermit2(token, owner, approval);

        IPermit2SignatureTransfer(PERMIT2)
            .permitWitnessTransferFrom(
                permit,
                IPermit2SignatureTransfer.SignatureTransferDetails({
                    to: a.feeTo, requestedAmount: permit.permitted.amount
                }),
                owner,
                hashAction(a),
                ACTION_WITNESS_TYPE,
                signature
            );
        uint256[] memory held = new uint256[](sweep.length);
        for (uint256 j; j < sweep.length; ++j) {
            held[j] = IERC20(sweep[j]).balanceOf(address(this));
        }
        uint256 heldFee = IERC20(token).balanceOf(address(this));
        for (uint256 i; i < calls.length; ++i) {
            address t = calls[i].target;
            if (t == PERMIT2 || t == address(this) || t == token || t.code.length == 0) revert ForbiddenTarget(t);
            // Audit 2026-11-17 A-6: this contract is one shared identity, so a relayed call may never move or approve
            // its own balances (ERC-20 transfer/transferFrom/approve/increaseAllowance/permit, ERC-721/1155 approvals).
            bytes calldata data = calls[i].data;
            if (data.length >= 4) {
                bytes4 sel = bytes4(data[:4]);
                if (
                    sel == IERC20.transfer.selector || sel == IERC20.transferFrom.selector
                        || sel == IERC20.approve.selector || sel == 0x39509351 || sel == IERC20Permit.permit.selector
                        || sel == 0xa22cb465
                    // Audit 2026-11-18 D-2 / R4-3: non-standard move/approve selectors (ERC-677/1363, ERC-777,
                    // ERC-721/1155 transfers, legacy increaseApproval). The forwarder has no owner, so close them now.
                    || sel == 0x4000aea0 || sel == 0x1296ee62 || sel == 0xcae9ca51 || sel == 0x9bd9bbc6
                    || sel == 0x62ad1b83 || sel == 0x959b8c3f || sel == 0x42842e0e || sel == 0xb88d4fde
                    || sel == 0xf242432a || sel == 0x2eb2c2d6 || sel == 0xd73dd623
                ) revert ForbiddenTarget(t);
            }
            (bool ok, bytes memory ret) = t.call(data);
            if (!ok) revert CallFailed(i, ret);
        }
        for (uint256 j; j < sweep.length; ++j) {
            uint256 got = IERC20(sweep[j]).balanceOf(address(this)) - held[j];
            if (got > 0) IERC20(sweep[j]).safeTransfer(a.feeTo, got);
        }
        // The fee token's gains always go to the signed fee recipient, even with an empty sweep list (audit L-11).
        uint256 gotFee = IERC20(token).balanceOf(address(this)) - heldFee;
        if (gotFee > 0) IERC20(token).safeTransfer(a.feeTo, gotFee);
        emit ActionRelayed(owner, token, a.feeTo, permit.permitted.amount, a.callsHash);
    }

    // ───────── private launch (USDG launch fee + First BOOST) ─────────

    /// @notice Pulls `maxFee + usdgIn` as signed, runs the signed launch on the signed launcher, and returns any leftover of
    ///         this payment (an unused fee margin or First BOOST refund) to the signed refund address (the player when unset).
    function launchAnon(
        IPermit2SignatureTransfer.PermitTransferFrom calldata permit,
        AnonLaunch calldata l,
        address owner,
        bytes calldata signature,
        Approval calldata approval
    ) external nonReentrant returns (ILaunchpad.LaunchResult memory r) {
        if (l.creatorFeeDestination > 2) revert BadDestination();
        if (l.launcher == address(0) || l.launcher.code.length == 0) revert ForbiddenTarget(l.launcher);
        uint256 amount = l.maxFee + l.usdgIn;
        if (permit.permitted.amount != amount) revert AmountMismatch();
        IERC20 token = IERC20(permit.permitted.token);
        _approvePermit2(address(token), owner, approval);

        uint256 before = token.balanceOf(address(this));
        IPermit2SignatureTransfer(PERMIT2)
            .permitWitnessTransferFrom(
                permit,
                IPermit2SignatureTransfer.SignatureTransferDetails({to: address(this), requestedAmount: amount}),
                owner,
                hashAnonLaunch(l),
                ANON_LAUNCH_WITNESS_TYPE,
                signature
            );
        address refund = l.refundTo == address(0) ? owner : l.refundTo;
        token.forceApprove(l.launcher, amount);
        r = _launch(l, refund);
        token.forceApprove(l.launcher, 0);

        uint256 left = token.balanceOf(address(this)) - before;
        if (left > 0) token.safeTransfer(refund, left);
        emit AnonLaunchRelayed(owner, r.token, r.curve, l.launcher, left);
    }

    function _launch(AnonLaunch calldata l, address refund) private returns (ILaunchpad.LaunchResult memory r) {
        ILaunchpad.LaunchParams memory p = ILaunchpad.LaunchParams({
            name: l.name,
            ticker: l.ticker,
            imageURI: l.imageURI,
            description: l.description,
            socialsURI: l.socialsURI,
            quote: l.quote,
            creatorTaxBps: l.creatorTaxBps,
            creatorBuyQuoteIn: l.creatorBuyQuoteIn,
            creatorBuyMinTokensOut: l.creatorBuyMinTokensOut,
            deadline: l.deadline
        });
        if (l.creatorFeeDestination == 0) {
            (r,) = IAnonLaunchUsdg(l.launcher)
                .launchAnonWithUsdgMode(
                    p,
                    l.mode,
                    l.stealthOwner,
                    l.buyRecipient,
                    l.ephemeralPubKey,
                    l.viewTag,
                    l.maxFee,
                    l.usdgIn,
                    l.minQuoteIn,
                    refund
                );
        } else {
            (r,) = IHarvestLaunchUsdg(l.launcher)
                .launchAnonWithUsdgMode(
                    p,
                    l.mode,
                    l.stealthOwner,
                    l.buyRecipient,
                    l.ephemeralPubKey,
                    l.viewTag,
                    l.maxFee,
                    l.usdgIn,
                    l.minQuoteIn,
                    refund,
                    l.creatorFeeDestination
                );
        }
    }

    // ───────── witness hashes (the site computes the same: web/lib/trade/permitForwarder.ts) ─────────

    function hashWithdraw(Withdraw calldata w) public pure returns (bytes32) {
        return keccak256(abi.encode(WITHDRAW_TYPEHASH, w.to, w.fee, w.feeTo));
    }

    function hashAction(Action calldata a) public pure returns (bytes32) {
        return keccak256(abi.encode(ACTION_TYPEHASH, a.feeTo, a.callsHash));
    }

    function hashAnonLaunch(AnonLaunch calldata l) public pure returns (bytes32) {
        bytes memory head = abi.encode(
            ANON_LAUNCH_TYPEHASH,
            keccak256(bytes(l.name)),
            keccak256(bytes(l.ticker)),
            keccak256(bytes(l.imageURI)),
            keccak256(bytes(l.description)),
            keccak256(bytes(l.socialsURI)),
            l.quote,
            l.creatorTaxBps,
            l.creatorBuyQuoteIn,
            l.creatorBuyMinTokensOut,
            l.deadline
        );
        bytes memory tail = abi.encode(
            l.stealthOwner,
            l.buyRecipient,
            keccak256(l.ephemeralPubKey),
            l.viewTag,
            l.maxFee,
            l.usdgIn,
            l.minQuoteIn,
            l.refundTo,
            l.launcher,
            l.creatorFeeDestination,
            l.mode
        );
        return keccak256(bytes.concat(head, tail));
    }

    function _approvePermit2(address token, address owner, Approval calldata a) private {
        if (a.value == 0) return;
        try IERC20Permit(token).permit(owner, PERMIT2, a.value, a.deadline, a.v, a.r, a.s) {} catch {}
    }
}
