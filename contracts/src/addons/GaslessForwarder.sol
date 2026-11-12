// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ILaunchpad} from "../interfaces/ILaunchpad.sol";
import {IPermit2Witness} from "../DiscipleRouter.sol";

interface IAnonLaunchWithUsdg {
    function feeToken() external view returns (address);
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

/// @title Gasless private launch and USDG withdraw, with this contract as the Permit2 spender
/// @notice The player signs ONE Permit2 PermitWitnessTransferFrom whose spender is this contract and whose witness is
///         the whole action: every launch field plus the leftover recipient for a private launch, and the recipient,
///         fee and fee recipient for a withdraw. Permit2 only lets the spender named in the signature redeem it, and
///         this contract always pulls the funds to itself and then does exactly what the witness says, so a leaked or
///         replayed signature cannot be pointed at any other recipient. Any relayer may submit it and pays the gas.
/// @dev Same pattern as UniswapX reactors and 0x Settler meta-transactions (SettlerMetaTxn), and the one this repo
///      already uses in DiscipleRouter.buyWithPermit2: the protocol contract is the Permit2 spender, receives the
///      funds, and the witness binds the action. Permit2's unordered nonces and the deadline stop replays. Holds no
///      funds between transactions. Replaces the earlier Multicall3 batch, whose spender (Multicall3) anyone could call.
contract GaslessForwarder is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Canonical Permit2 (same address on Robinhood Chain 4663 and testnet 46630).
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @notice AnonLauncher this forwarder launches through. The signed `launcher` field must equal it.
    IAnonLaunchWithUsdg public immutable anonLauncher;
    /// @notice USDG: the only token either action pulls.
    IERC20 public immutable usdg;

    /// @notice The signed private launch (Permit2 witness). Permit amount must equal maxFee + usdgIn.
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
    }

    /// @notice The signed withdraw (Permit2 witness): `to` gets permit amount - fee, `feeTo` gets `fee`.
    struct Withdraw {
        address to;
        uint256 fee;
        address feeTo;
    }

    /// @notice One-time EIP-2612 approval of PERMIT2 bundled into the call (value 0 = skipped). Same as DiscipleRouter.
    struct Erc2612 {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    string internal constant ANON_LAUNCH_TYPE = "AnonLaunch(string name,string ticker,string imageURI,"
        "string description,string socialsURI,address quote,uint256 creatorTaxBps,uint256 creatorBuyQuoteIn,"
        "uint256 creatorBuyMinTokensOut,uint256 deadline,address stealthOwner,address buyRecipient,"
        "bytes ephemeralPubKey,bytes1 viewTag,uint256 maxFee,uint256 usdgIn,uint256 minQuoteIn,address refundTo,"
        "address launcher)";
    string internal constant TOKEN_PERMISSIONS_TYPE = "TokenPermissions(address token,uint256 amount)";
    string internal constant WITHDRAW_TYPE = "Withdraw(address to,uint256 fee,address feeTo)";

    bytes32 public constant ANON_LAUNCH_TYPEHASH = keccak256(bytes(ANON_LAUNCH_TYPE));
    bytes32 public constant WITHDRAW_TYPEHASH = keccak256(bytes(WITHDRAW_TYPE));
    /// @dev Permit2 appends these to "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256
    ///      nonce,uint256 deadline,". EIP-712 lists referenced types in name order (what wallets and viem sign):
    ///      AnonLaunch < TokenPermissions < Withdraw.
    string public constant ANON_LAUNCH_WITNESS_TYPE =
        string(abi.encodePacked("AnonLaunch witness)", ANON_LAUNCH_TYPE, TOKEN_PERMISSIONS_TYPE));
    string public constant WITHDRAW_WITNESS_TYPE =
        string(abi.encodePacked("Withdraw witness)", TOKEN_PERMISSIONS_TYPE, WITHDRAW_TYPE));

    error ZeroAddress();
    error BadPermit();
    error BadLauncher();
    error BadRecipient();
    error FeeTooHigh();

    event GaslessAnonLaunch(address indexed signer, address indexed relayer, address indexed token, uint256 nonce);
    event GaslessWithdraw(
        address indexed signer, address indexed to, address indexed feeTo, uint256 amount, uint256 fee, uint256 nonce
    );

    constructor(address anonLauncher_) {
        if (anonLauncher_ == address(0)) revert ZeroAddress();
        anonLauncher = IAnonLaunchWithUsdg(anonLauncher_);
        address u = IAnonLaunchWithUsdg(anonLauncher_).feeToken();
        if (u == address(0)) revert ZeroAddress();
        usdg = IERC20(u);
    }

    // ───────────────────────────── private launch ─────────────────────────────

    /// @notice Gasless private launch. Pulls permit amount (maxFee + usdgIn) USDG from `signer` to this contract,
    ///         runs AnonLauncher.launchAnonWithUsdg with the signed fields, and sends every leftover USDG (an unused
    ///         First BOOST, and maxFee - launchFee) to the signed `refundTo`.
    function launchAnon(
        address signer,
        IPermit2Witness.PermitTransferFrom calldata permit,
        AnonLaunch calldata l,
        bytes calldata signature,
        Erc2612 calldata approval
    ) external nonReentrant returns (ILaunchpad.LaunchResult memory r, uint256 refund) {
        if (signer == address(0)) revert ZeroAddress();
        if (l.launcher != address(anonLauncher)) revert BadLauncher();
        if (l.refundTo == address(0) || l.refundTo == address(this)) revert BadRecipient();
        uint256 amount = l.maxFee + l.usdgIn;
        IERC20 u = usdg;
        if (permit.permitted.token != address(u) || permit.permitted.amount != amount) revert BadPermit();
        _approvePermit2(signer, approval);

        uint256 b0 = u.balanceOf(address(this));
        IPermit2Witness(PERMIT2).permitWitnessTransferFrom(
            permit,
            IPermit2Witness.SignatureTransferDetails({to: address(this), requestedAmount: amount}),
            signer,
            anonLaunchWitnessHash(l),
            ANON_LAUNCH_WITNESS_TYPE,
            signature
        );

        address launcher = address(anonLauncher);
        u.forceApprove(launcher, amount);
        (r,) = anonLauncher.launchAnonWithUsdg(
            _params(l), l.stealthOwner, l.buyRecipient, l.ephemeralPubKey, l.viewTag, l.maxFee, l.usdgIn, l.minQuoteIn,
            l.refundTo
        );
        u.forceApprove(launcher, 0);
        // AnonLauncher already refunded the unused First BOOST to refundTo; what is left here is maxFee - launchFee.
        refund = u.balanceOf(address(this)) - b0;
        if (refund != 0) u.safeTransfer(l.refundTo, refund);
        emit GaslessAnonLaunch(signer, msg.sender, r.token, permit.nonce);
    }

    /// @notice EIP-712 struct hash of `l` (the Permit2 witness). Off-chain signers can cross-check against it.
    function anonLaunchWitnessHash(AnonLaunch calldata l) public pure returns (bytes32) {
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
            l.launcher
        );
        return keccak256(bytes.concat(head, tail));
    }

    function _params(AnonLaunch calldata l) internal pure returns (ILaunchpad.LaunchParams memory p) {
        p = ILaunchpad.LaunchParams({
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
    }

    // ───────────────────────────── withdraw ─────────────────────────────

    /// @notice Gasless USDG withdraw. Pulls permit amount from `signer` to this contract, then sends
    ///         amount - fee to the signed `w.to` and `w.fee` to the signed `w.feeTo` (the relayer that quoted it).
    function withdraw(
        address signer,
        IPermit2Witness.PermitTransferFrom calldata permit,
        Withdraw calldata w,
        bytes calldata signature,
        Erc2612 calldata approval
    ) external nonReentrant {
        if (signer == address(0)) revert ZeroAddress();
        if (w.to == address(0) || w.to == address(this)) revert BadRecipient();
        uint256 amount = permit.permitted.amount;
        IERC20 u = usdg;
        if (permit.permitted.token != address(u)) revert BadPermit();
        if (w.fee >= amount) revert FeeTooHigh();
        if (w.fee != 0 && (w.feeTo == address(0) || w.feeTo == address(this))) revert BadRecipient();
        _approvePermit2(signer, approval);
        IPermit2Witness(PERMIT2).permitWitnessTransferFrom(
            permit,
            IPermit2Witness.SignatureTransferDetails({to: address(this), requestedAmount: amount}),
            signer,
            withdrawWitnessHash(w),
            WITHDRAW_WITNESS_TYPE,
            signature
        );
        u.safeTransfer(w.to, amount - w.fee);
        if (w.fee != 0) u.safeTransfer(w.feeTo, w.fee);
        emit GaslessWithdraw(signer, w.to, w.feeTo, amount, w.fee, permit.nonce);
    }

    /// @notice EIP-712 struct hash of `w` (the Permit2 witness).
    function withdrawWitnessHash(Withdraw calldata w) public pure returns (bytes32) {
        return keccak256(abi.encode(WITHDRAW_TYPEHASH, w.to, w.fee, w.feeTo));
    }

    /// @dev try/catch: a front-run permit (same signature) must not brick the call; Permit2 then just needs the
    ///      allowance. Same as DiscipleRouter._approvePermit2.
    function _approvePermit2(address signer, Erc2612 calldata a) private {
        if (a.value == 0) return;
        try IERC20Permit(address(usdg)).permit(signer, PERMIT2, a.value, a.deadline, a.v, a.r, a.s) {} catch {}
    }
}
