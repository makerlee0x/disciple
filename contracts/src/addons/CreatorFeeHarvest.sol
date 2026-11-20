// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ILaunchpad} from "../interfaces/ILaunchpad.sol";
import {Owned2Step} from "../utils/Owned2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPermit2Witness} from "../interfaces/IPermit2Witness.sol";

interface ILaunchpadEpoch {
    function creatorEpoch(address token) external view returns (uint256);
}

interface ILaunchpadFor {
    function launchFor(address creator, ILaunchpad.LaunchParams calldata params, uint8 mode)
        external
        returns (ILaunchpad.LaunchResult memory);
    function defaultQuote() external view returns (address);
    function creatorOf(address token) external view returns (address);
}

interface IFeePull {
    function creatorAccrued(address token, address creator) external view returns (uint256);
    function creatorTokenAccrued(address token, address creator) external view returns (uint256);
    function claimCreatorFeesFor(address token, address creator) external returns (uint256);
    function claimCreatorTokenFeesFor_15(address token, address creator) external returns (uint256);
    function tokenQuote(address token) external view returns (address);
}

interface IVaultPull {
    function claimCreatorFeesToRouter(address token, address creator) external returns (uint256);
}

interface ILockedDeposit {
    function depositCreatorFees_57(address token, address quote, uint256 tokenAmount, uint256 quoteAmount)
        external
        returns (uint256);
    function getPoolKey(address token) external view returns (PoolKey memory);
    function isGraduated(address token) external view returns (bool);
}

interface IHarvestRouter {
    function usdg() external view returns (address);
    function swapUsdgToQuote(address quote, uint256 usdgIn, uint256 minOut, address recipient, uint256 deadline)
        external
        returns (uint256);
    function swapQuoteToUsdg(address quote, uint256 quoteIn, uint256 minOut, address recipient, uint256 deadline)
        external
        returns (uint256);
}

interface IHarvestAnon {
    function launchFee() external view returns (uint256);
    function feeToken() external view returns (address);
    function launchAnonWithMode(
        ILaunchpad.LaunchParams calldata p,
        uint8 mode,
        address stealthOwner,
        address buyRecipient,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag,
        uint256 maxFee
    ) external returns (ILaunchpad.LaunchResult memory);
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
    ) external returns (ILaunchpad.LaunchResult memory, uint256 usdgRefund);
    function forwardTokenFees(address token) external;
}

/// @title Later send for a coin's creator fees
/// @notice Trades keep paying the launcher. This contract is not `creatorOf`. Anyone may later call `route`.
///         Quote fees are pulled with `FeeRouter.claimCreatorFeesFor` (the claim-router path
///         `DiscipleRouter.claimCreatorFeesToUsdg` uses). Rocket-token fees are pulled with
///         `claimCreatorTokenFeesFor_15`, the same pull extended to the token half. The caller is paid nothing,
///         the same way as `FeeRouter.claimTreasury` and the crew tip: the trade only accrues, and a later call
///         moves the tokens. Destination 1 or 2 cannot be self-claimed, on a public coin or a private one.
/// @dev Destination 0 is not routed. The launcher claims exactly as today.
///      Destination 1 deposits into that rocket's locked liquidity, which cannot be withdrawn.
///      Destination 2 burns the quote. On the curve the fee is already quote, so it is burned. After orbit the
///      quote half is burned and the rocket-token half is sent straight to the dead address (no sell).
///      `route` pulls both halves itself. The launcher does not claim, approve, or deposit.
contract CreatorFeeHarvest is ReentrancyGuard, Owned2Step, EIP712 {
    using SafeERC20 for IERC20;

    /// @notice Creator fees are deposited into the rocket's locked liquidity pool, and that liquidity is renounced.
    uint8 public constant DEST_LOCKED_LP = 1;
    /// @notice Creator fees are burned: the quote, and after orbit the rocket tokens too (no sell).
    uint8 public constant DEST_BURN_QUOTE = 2;

    /// @notice Nobody can move tokens sent here.
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    ILaunchpadFor public launchpad;
    IFeePull public feeRouter;
    ILockedDeposit public lockedLP;
    IHarvestRouter public router;
    IPoolManager public poolManager;
    IHarvestAnon public anon;
    /// @notice Curve-phase creator fees settle here (#312). `route` pulls them. Trades do not read this.
    IVaultPull public feeVault;

    /// @notice Fixed at launch. 0 (or unset) means the launcher keeps the fees. 1 locks them. 2 burns the quote.
    mapping(address token => uint8 dest) public creatorFeeDestinationOf;
    /// @notice `creatorOf` at the moment the choice was recorded. `route` also pulls this address when a later
    ///         `transferCreator` moved the role, so fees that accrued to the original launcher are not stuck.
    mapping(address token => address launcher) public launcherOf;
    /// @notice Rocket-token fees handed over with `depositRocketTokens`, waiting for the next `route`.
    mapping(address token => uint256 amount) public rocketDeposited;
    /// @notice Pays to (maker 2026-11-19): the wallet a creator picked for one coin's creator fees, keyed by that
    ///         creator. Only the current `creatorOf` sets it. A new creator after `transferCreator` starts with no
    ///         pick (the old creator's pick only applies to the old creator's own leftover fees).
    mapping(address token => mapping(address creator => address payee)) internal _payeeOf;
    /// @dev Launchpad.creatorEpoch(token) when `_payeeOf[token][creator]` was set (audit delta-2 M-01).
    mapping(address token => mapping(address creator => uint256)) internal _payeeEpoch;

    error ZeroAddress();
    error AlreadyWired();
    error BadDestination();
    /// @notice A leftover refund cannot be sent to this contract, where nobody could take it out.
    error BadRefundTo();
    error NotLauncher();
    error NothingToRoute();
    /// @notice Rocket-token fees are waiting for orbit. There is no quote fee to burn yet.
    error AwaitingOrbit();
    error Expired();
    error Slippage();
    error NotCreator();

    /// @notice `launcher` is who FeeRouter pays (`creatorOf`): the wallet, or AnonLauncher for a private coin.
    event CreatorFeeDestinationSet(address indexed token, address indexed launcher, uint8 destination);
    /// @notice `quoteAmount` and `rocketTokenAmount` were locked or burned. `quoteBought` is always 0 (kept for
    ///         indexers): burn mode sends rocket tokens to the dead address instead of selling them.
    event CreatorFeesRouted(
        address indexed token, uint8 destination, uint256 quoteAmount, uint256 rocketTokenAmount, uint256 quoteBought
    );
    event RocketTokensDeposited(address indexed token, address indexed from, uint256 amount);
    event OwnershipRenounced();
    event CreatorFeeRecipientSet(address indexed token, address indexed creator, address recipient);

    constructor(address owner_) Owned2Step(owner_) EIP712("DISCIPLE CreatorFeeHarvest", "1") {
        if (owner_ == address(0)) revert ZeroAddress();
    }

    /// @notice Owner wires the live stack once. This contract must also be `Launchpad.setTrustedRouter` and
    ///         `FeeRouter.setClaimRouter`, the same allowlist DiscipleRouter is on for `claimCreatorFeesFor`.
    function wire(
        address launchpad_,
        address feeRouter_,
        address lockedLP_,
        address router_,
        address poolManager_
    ) external {
        _checkOwner();
        if (address(launchpad) != address(0)) revert AlreadyWired();
        if (
            launchpad_ == address(0) || feeRouter_ == address(0) || lockedLP_ == address(0) || router_ == address(0)
                || poolManager_ == address(0)
        ) revert ZeroAddress();
        // F-L11: one-shot (LockedLP stores this harvest as an immutable), so every pointer must be a contract.
        if (
            launchpad_.code.length == 0 || feeRouter_.code.length == 0 || lockedLP_.code.length == 0
                || router_.code.length == 0 || poolManager_.code.length == 0
        ) revert ZeroAddress();
        launchpad = ILaunchpadFor(launchpad_);
        feeRouter = IFeePull(feeRouter_);
        lockedLP = ILockedDeposit(lockedLP_);
        router = IHarvestRouter(router_);
        poolManager = IPoolManager(poolManager_);
    }

    /// @notice Final setup step: drops the owner for good, so no pointer here can ever change again. Needs the stack
    ///         wired and the curve fee vault + AnonLauncher set first.
    function renounceOwnership() external {
        _checkOwner();
        if (address(launchpad) == address(0) || address(feeVault) == address(0) || address(anon) == address(0)) {
            revert ZeroAddress();
        }
        owner = address(0);
        pendingOwner = address(0);
        emit OwnershipRenounced();
    }

    /// @notice CurveFeeVault that holds this chain's curve-phase creator fees. `route` pulls it.
    function setFeeVault(address vault_) external {
        _checkOwner();
        // Audit L-12 / L-02: write-once, contracts only.
        if (address(feeVault) != address(0) || vault_.code.length == 0) revert ZeroAddress();
        feeVault = IVaultPull(vault_);
    }

    /// @notice Private launches. The stealth owner is not paid when the destination is 1 or 2.
    function setAnonLauncher(address anon_) external {
        _checkOwner();
        if (address(anon) != address(0) || anon_.code.length == 0) revert ZeroAddress();
        anon = IHarvestAnon(anon_);
    }

    /// @notice Launch as `msg.sender`. Pass `creatorFeeDestination` here. It is not a LaunchParams field.
    ///         0 keeps the fees. 1 locks them. 2 burns the quote. The choice is fixed in this transaction.
    function launch(ILaunchpad.LaunchParams calldata params, uint8 creatorFeeDestination)
        external
        returns (ILaunchpad.LaunchResult memory result)
    {
        return _launch(params, 0, creatorFeeDestination);
    }

    /// @notice Same as `launch`, with a bonding-curve mode (0 Trench, 1 Easy, 2 Hard).
    function launchWithMode(ILaunchpad.LaunchParams calldata params, uint8 mode, uint8 creatorFeeDestination)
        external
        returns (ILaunchpad.LaunchResult memory result)
    {
        return _launch(params, mode, creatorFeeDestination);
    }

    /// @notice Same creator and same choice as `launchWithMode`, paying the First BOOST in USDG.
    ///         `params.creatorBuyQuoteIn` is ignored. Leftover pair-coin is returned to the caller in USDG.
    function launchWithUsdg(
        ILaunchpad.LaunchParams calldata params,
        uint8 mode,
        uint256 usdgIn,
        uint256 minQuoteIn,
        uint8 creatorFeeDestination
    ) external nonReentrant returns (ILaunchpad.LaunchResult memory result, uint256 usdgRefund) {
        address u = router.usdg();
        if (usdgIn != 0) {
            if (u == address(0)) revert ZeroAddress();
            IERC20(u).safeTransferFrom(msg.sender, address(this), usdgIn);
        }
        return _launchUsdg(msg.sender, params, mode, usdgIn, minQuoteIn, creatorFeeDestination);
    }

    // ── gasless coin creators (maker 2026-11-19: players hold USDG only) ──

    /// @notice Canonical Permit2 (same address on Robinhood Chain 4663 and testnet 46630).
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @notice The signed launch (Permit2 witness). `paramsHash` = keccak256(abi.encode(params)). `gasFee` USDG goes to
    ///         the submitter (the relayer pays the ETH); the permit amount is `usdgIn + gasFee`.
    struct GaslessLaunch {
        bytes32 paramsHash;
        uint8 mode;
        uint256 usdgIn;
        uint256 minQuoteIn;
        uint8 creatorFeeDestination;
        uint256 gasFee;
    }

    bytes32 public constant GASLESS_LAUNCH_TYPEHASH = keccak256(
        "GaslessLaunch(bytes32 paramsHash,uint8 mode,uint256 usdgIn,uint256 minQuoteIn,uint8 creatorFeeDestination,uint256 gasFee)"
    );
    string public constant GASLESS_LAUNCH_WITNESS_TYPE = "GaslessLaunch witness)GaslessLaunch(bytes32 paramsHash,uint8 mode,"
        "uint256 usdgIn,uint256 minQuoteIn,uint8 creatorFeeDestination,uint256 gasFee)TokenPermissions(address token,uint256 amount)";

    error BadPermit();

    /// @notice Gasless wallet launch: anyone submits the signer's Permit2 signature; the signer is the coin creator,
    ///         pays the First BOOST and the network fee in USDG, and gets any leftover back in USDG.
    function launchWithPermit2(
        address signer,
        IPermit2Witness.PermitTransferFrom calldata permit,
        ILaunchpad.LaunchParams calldata params,
        GaslessLaunch calldata w,
        bytes calldata sig
    ) external nonReentrant returns (ILaunchpad.LaunchResult memory result, uint256 usdgRefund) {
        address u = router.usdg();
        uint256 total = w.usdgIn + w.gasFee;
        // the network fee is at most $3 (a launch is ~6.7M gas; room for an ETH or gas price spike)
        if (
            signer == address(0) || u == address(0) || w.paramsHash != keccak256(abi.encode(params))
                || permit.permitted.token != u || permit.permitted.amount != total
                || w.gasFee > 3 * 10 ** IERC20Metadata(u).decimals()
        ) revert BadPermit();
        IPermit2Witness(PERMIT2).permitWitnessTransferFrom(
            permit,
            IPermit2Witness.SignatureTransferDetails({to: address(this), requestedAmount: total}),
            signer,
            keccak256(
                abi.encode(
                    GASLESS_LAUNCH_TYPEHASH, w.paramsHash, w.mode, w.usdgIn, w.minQuoteIn, w.creatorFeeDestination, w.gasFee
                )
            ),
            GASLESS_LAUNCH_WITNESS_TYPE,
            sig
        );
        if (w.gasFee != 0) IERC20(u).safeTransfer(msg.sender, w.gasFee);
        return _launchUsdg(signer, params, w.mode, w.usdgIn, w.minQuoteIn, w.creatorFeeDestination);
    }

    /// @dev `usdgIn` USDG is already here. Launches for `creator`, refunds the unspent First BOOST to `creator`.
    function _launchUsdg(
        address creator,
        ILaunchpad.LaunchParams calldata params,
        uint8 mode,
        uint256 usdgIn,
        uint256 minQuoteIn,
        uint8 creatorFeeDestination
    ) internal returns (ILaunchpad.LaunchResult memory result, uint256 usdgRefund) {
        if (creatorFeeDestination > 2) revert BadDestination();
        if (block.timestamp > params.deadline) revert Expired();
        ILaunchpadFor pad = launchpad;
        IHarvestRouter rtr = router;
        address q = params.quote == address(0) ? pad.defaultQuote() : params.quote;
        ILaunchpad.LaunchParams memory m = params;
        m.quote = q;
        address u = rtr.usdg();
        // Audit CH-02: snapshot before any quote arrives, so `left` is only the unspent First BOOST. On a USDG pair the
        // First BOOST USDG is already here, so it is taken out of the snapshot.
        uint256 bal0 = IERC20(q).balanceOf(address(this)) - (q == u ? usdgIn : 0);
        uint256 quoteAmt;
        if (usdgIn != 0) {
            if (q == u) {
                quoteAmt = usdgIn;
            } else {
                // Audit RT-02: the swap leg needs a real minimum.
                if (minQuoteIn == 0) revert Slippage();
                IERC20(u).forceApprove(address(rtr), usdgIn);
                quoteAmt = rtr.swapUsdgToQuote(q, usdgIn, minQuoteIn, address(this), params.deadline);
            }
            if (quoteAmt < minQuoteIn) revert Slippage();
        }
        m.creatorBuyQuoteIn = quoteAmt;
        if (quoteAmt != 0) IERC20(q).forceApprove(address(pad), quoteAmt);
        result = pad.launchFor(creator, m, mode);
        uint256 left = IERC20(q).balanceOf(address(this)) - bal0;
        if (left != 0) {
            if (u == address(0) || q == u) {
                IERC20(q).safeTransfer(creator, left);
                usdgRefund = left;
            } else {
                IERC20(q).forceApprove(address(rtr), left);
                usdgRefund = rtr.swapQuoteToUsdg(q, left, 1, creator, params.deadline);
            }
        }
        _record(result.token, creatorFeeDestination);
    }

    /// @notice Private launch. AnonLauncher stays `creatorOf`. `creatorFeeDestination` is recorded here. Trench;
    ///         `launchAnonWithMode` picks the difficulty.
    function launchAnon(
        ILaunchpad.LaunchParams calldata params,
        address stealthOwner,
        address buyRecipient,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag,
        uint256 maxFee,
        uint8 creatorFeeDestination
    ) external nonReentrant returns (ILaunchpad.LaunchResult memory result) {
        result = _launchAnon(
            params, 0, stealthOwner, buyRecipient, ephemeralPubKey, viewTag, maxFee, creatorFeeDestination
        );
    }

    /// @notice Private launch on any difficulty (`mode` 0 Trench, 1 Easy, 2 Hard). An Easy First BOOST is held on
    ///         AnonLauncher until orbit (AnonLauncher.releaseBoost).
    function launchAnonWithMode(
        ILaunchpad.LaunchParams calldata params,
        uint8 mode,
        address stealthOwner,
        address buyRecipient,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag,
        uint256 maxFee,
        uint8 creatorFeeDestination
    ) external nonReentrant returns (ILaunchpad.LaunchResult memory result) {
        result = _launchAnon(
            params, mode, stealthOwner, buyRecipient, ephemeralPubKey, viewTag, maxFee, creatorFeeDestination
        );
    }

    function _launchAnon(
        ILaunchpad.LaunchParams calldata params,
        uint8 mode,
        address stealthOwner,
        address buyRecipient,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag,
        uint256 maxFee,
        uint8 creatorFeeDestination
    ) internal returns (ILaunchpad.LaunchResult memory result) {
        if (creatorFeeDestination > 2) revert BadDestination();
        IHarvestAnon a = anon;
        if (address(a) == address(0)) revert ZeroAddress();
        address q = params.quote == address(0) ? launchpad.defaultQuote() : params.quote;
        uint256 bal0 = IERC20(q).balanceOf(address(this));
        uint256 fee = a.launchFee();
        address feeToken = fee != 0 ? a.feeToken() : address(0);
        if (fee != 0) {
            IERC20(feeToken).safeTransferFrom(msg.sender, address(this), fee);
            IERC20(feeToken).forceApprove(address(a), fee);
        }
        if (params.creatorBuyQuoteIn != 0) {
            IERC20(q).safeTransferFrom(msg.sender, address(this), params.creatorBuyQuoteIn);
            // Audit CH-03: when the fee is paid in the pair coin, one approval must cover both pulls.
            uint256 allow = feeToken == q ? fee + params.creatorBuyQuoteIn : params.creatorBuyQuoteIn;
            IERC20(q).forceApprove(address(a), allow);
        }
        result = a.launchAnonWithMode(params, mode, stealthOwner, buyRecipient, ephemeralPubKey, viewTag, maxFee);
        uint256 left = IERC20(q).balanceOf(address(this)) - bal0;
        if (left != 0) IERC20(q).safeTransfer(msg.sender, left);
        _record(result.token, creatorFeeDestination);
    }

    /// @notice Private launch whose First BOOST is paid in USDG. AnonLauncher stays `creatorOf`.
    /// @param refundTo receives leftover USDG. address(0) means msg.sender. A relayer batch (Multicall3) passes the
    ///        player here, the same rule as `AnonLauncher.launchAnonWithUsdg`, so a leftover is never left on the
    ///        batch contract. The launch fee and First BOOST are still pulled from msg.sender.
    function launchAnonWithUsdg(
        ILaunchpad.LaunchParams calldata params,
        address stealthOwner,
        address buyRecipient,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag,
        uint256 maxFee,
        uint256 usdgIn,
        uint256 minQuoteIn,
        address refundTo,
        uint8 creatorFeeDestination
    ) external nonReentrant returns (ILaunchpad.LaunchResult memory result, uint256 usdgRefund) {
        (result, usdgRefund) = _launchAnonWithUsdg(
            params,
            0,
            stealthOwner,
            buyRecipient,
            ephemeralPubKey,
            viewTag,
            maxFee,
            usdgIn,
            minQuoteIn,
            refundTo,
            creatorFeeDestination
        );
    }

    /// @notice `launchAnonWithUsdg` on any difficulty (`mode` 0 Trench, 1 Easy, 2 Hard).
    function launchAnonWithUsdgMode(
        ILaunchpad.LaunchParams calldata params,
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
    ) external nonReentrant returns (ILaunchpad.LaunchResult memory result, uint256 usdgRefund) {
        (result, usdgRefund) = _launchAnonWithUsdg(
            params,
            mode,
            stealthOwner,
            buyRecipient,
            ephemeralPubKey,
            viewTag,
            maxFee,
            usdgIn,
            minQuoteIn,
            refundTo,
            creatorFeeDestination
        );
    }

    function _launchAnonWithUsdg(
        ILaunchpad.LaunchParams calldata params,
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
    ) internal returns (ILaunchpad.LaunchResult memory result, uint256 usdgRefund) {
        if (creatorFeeDestination > 2) revert BadDestination();
        address refund = refundTo == address(0) ? msg.sender : refundTo;
        if (refund == address(this)) revert BadRefundTo();
        IHarvestAnon a = anon;
        if (address(a) == address(0)) revert ZeroAddress();
        address feeToken = a.feeToken();
        uint256 fee = a.launchFee();
        uint256 pull = fee + usdgIn;
        if (pull != 0) {
            IERC20(feeToken).safeTransferFrom(msg.sender, address(this), pull);
            IERC20(feeToken).forceApprove(address(a), pull);
        }
        // Leftover USDG goes straight to `refund`. AnonLauncher would otherwise refund this contract.
        (result, usdgRefund) = a.launchAnonWithUsdgMode(
            params, mode, stealthOwner, buyRecipient, ephemeralPubKey, viewTag, maxFee, usdgIn, minQuoteIn, refund
        );
        _record(result.token, creatorFeeDestination);
    }

    /// @notice Optional handover of rocket tokens the caller already holds. `route` does not need this.
    ///         Destination 1 or 2 cannot be self-claimed, so a launcher cannot fill this from FeeRouter.
    function depositRocketTokens(address token, uint256 amount) external {
        uint8 dest = creatorFeeDestinationOf[token];
        if (dest != DEST_LOCKED_LP && dest != DEST_BURN_QUOTE) revert BadDestination();
        if (msg.sender != launchpad.creatorOf(token)) revert NotLauncher();
        if (amount == 0) revert NothingToRoute();
        // Audit CH-06: LockedLP only has a position to add rocket tokens to after orbit.
        if (dest == DEST_LOCKED_LP && !lockedLP.isGraduated(token)) revert AwaitingOrbit();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        rocketDeposited[token] += amount;
        emit RocketTokensDeposited(token, msg.sender, amount);
    }

    struct Pulled {
        address current;
        uint256 quoteAmount;
        uint256 rockets;
    }

    /// @notice Send this coin's accrued creator fees where the launcher chose. Anyone may call it.
    ///         The caller receives nothing. Curve-phase quote is pulled from CurveFeeVault. Post-graduation
    ///         quote is pulled with `claimCreatorFeesFor`, and rocket tokens with `claimCreatorTokenFeesFor_15`.
    ///         The launcher does not claim, approve, or deposit. Fees of the current `creatorOf` and of the
    ///         launcher recorded at launch are both pulled.
    function route(address token)
        external
        nonReentrant
        returns (uint256 quoteAmount, uint256 rocketTokenAmount, uint256 quoteBought)
    {
        return _route(token, address(0));
    }

    /// @notice Same as `route`, also pulling the fees that accrued to `pastCreator`. Audit CH-04: after two
    ///         `transferCreator` calls (A -> B -> C), `route` only reaches C (current) and A (recorded at launch),
    ///         so B's fees would be stranded: B cannot self-claim a destination-1/2 coin either. Anyone may call
    ///         this; an address that never held the role has nothing accrued, so `who` cannot misdirect anything.
    function routeWith(address token, address pastCreator)
        external
        nonReentrant
        returns (uint256 quoteAmount, uint256 rocketTokenAmount, uint256 quoteBought)
    {
        return _route(token, pastCreator);
    }

    function _route(address token, address extra)
        internal
        returns (uint256 quoteAmount, uint256 rocketTokenAmount, uint256 quoteBought)
    {
        uint8 dest = creatorFeeDestinationOf[token];
        Pulled memory pulled = _pull(token, dest, extra);
        address quote = feeRouter.tokenQuote(token);
        if (dest == DEST_LOCKED_LP) {
            _lock(token, quote, pulled.rockets, pulled.quoteAmount);
            if (pulled.rockets != 0) rocketDeposited[token] = 0;
            quoteAmount = pulled.quoteAmount;
            rocketTokenAmount = pulled.rockets;
        } else {
            if (pulled.quoteAmount != 0) {
                IERC20(quote).safeTransfer(BURN, pulled.quoteAmount);
                quoteAmount = pulled.quoteAmount;
            }
            if (pulled.rockets != 0) {
                IERC20(token).safeTransfer(BURN, pulled.rockets);
                rocketDeposited[token] = 0;
                rocketTokenAmount = pulled.rockets;
            }
        }
        emit CreatorFeesRouted(token, dest, quoteAmount, rocketTokenAmount, quoteBought);
    }

    /// @dev Reads both creators, then pulls both halves.
    function _pull(address token, uint8 dest, address extra) internal returns (Pulled memory pulled) {
        if (dest != DEST_LOCKED_LP && dest != DEST_BURN_QUOTE) revert BadDestination();
        pulled.current = launchpad.creatorOf(token);
        address original = launcherOf[token];
        if (original == pulled.current) original = address(0);
        if (extra == pulled.current || extra == original) extra = address(0);
        IFeePull fr = feeRouter;
        uint256 qCurrent = fr.creatorAccrued(token, pulled.current);
        uint256 tCurrent = fr.creatorTokenAccrued(token, pulled.current);
        uint256 qOriginal;
        uint256 tOriginal;
        if (original != address(0)) {
            qOriginal = fr.creatorAccrued(token, original);
            tOriginal = fr.creatorTokenAccrued(token, original);
        }
        uint256 qExtra;
        uint256 tExtra;
        if (extra != address(0)) {
            qExtra = fr.creatorAccrued(token, extra);
            tExtra = fr.creatorTokenAccrued(token, extra);
        }
        uint256 parked = rocketDeposited[token];
        uint256 qVault = _pullVault(token, pulled.current) + _pullVault(token, original) + _pullVault(token, extra);
        pulled.quoteAmount = qCurrent + qOriginal + qExtra + qVault;
        pulled.rockets = tCurrent + tOriginal + tExtra + parked;
        if (pulled.quoteAmount == 0 && pulled.rockets == 0) revert NothingToRoute();
        if (qCurrent != 0) qCurrent = fr.claimCreatorFeesFor(token, pulled.current);
        if (qOriginal != 0) qOriginal = fr.claimCreatorFeesFor(token, original);
        if (qExtra != 0) qExtra = fr.claimCreatorFeesFor(token, extra);
        pulled.quoteAmount = qCurrent + qOriginal + qExtra + qVault;
        if (tCurrent != 0) tCurrent = fr.claimCreatorTokenFeesFor_15(token, pulled.current);
        if (tOriginal != 0) tOriginal = fr.claimCreatorTokenFeesFor_15(token, original);
        if (tExtra != 0) tExtra = fr.claimCreatorTokenFeesFor_15(token, extra);
        pulled.rockets = tCurrent + tOriginal + tExtra + parked;
        if (pulled.rockets != 0) rocketDeposited[token] = pulled.rockets;
    }

    /// @dev Curve-phase quote for `who`. Settles the coin first. Returns 0 when this harvest has no vault.
    function _pullVault(address token, address who) internal returns (uint256 q) {
        IVaultPull v = feeVault;
        if (address(v) == address(0) || who == address(0)) return 0;
        q = v.claimCreatorFeesToRouter(token, who);
    }

    function _launch(ILaunchpad.LaunchParams calldata params, uint8 mode, uint8 creatorFeeDestination)
        internal
        returns (ILaunchpad.LaunchResult memory result)
    {
        if (creatorFeeDestination > 2) revert BadDestination();
        ILaunchpadFor pad = launchpad;
        address q = params.quote == address(0) ? pad.defaultQuote() : params.quote;
        uint256 bal0 = IERC20(q).balanceOf(address(this));
        if (params.creatorBuyQuoteIn != 0) {
            IERC20(q).safeTransferFrom(msg.sender, address(this), params.creatorBuyQuoteIn);
            IERC20(q).forceApprove(address(pad), params.creatorBuyQuoteIn);
        }
        result = pad.launchFor(msg.sender, params, mode);
        uint256 left = IERC20(q).balanceOf(address(this)) - bal0;
        if (left != 0) IERC20(q).safeTransfer(msg.sender, left);
        _record(result.token, creatorFeeDestination);
    }

    /// @notice The coin's current creator picks where its creator fees go (curve and pool claims, quote and rocket
    ///         token). address(0) or the creator's own address clears it. Any wallet or contract can be picked.
    function setCreatorFeeRecipient(address token, address recipient) external {
        if (msg.sender != launchpad.creatorOf(token) || msg.sender == address(0)) revert NotCreator();
        unchecked {
            ++sigNonces[msg.sender]; // audit delta-2 L-01: a direct pick voids pending signed picks
        }
        _setPayee(token, msg.sender, recipient);
    }

    bytes32 public constant SET_RECIPIENT_TYPEHASH =
        keccak256("SetCreatorFeeRecipient(address token,address recipient,uint256 nonce,uint256 deadline)");
    /// @notice Per coin creator, for `setCreatorFeeRecipientBySig`.
    mapping(address => uint256) public sigNonces;

    /// @notice Gasless `setCreatorFeeRecipient`: anyone submits the current coin creator's EIP-712 signature.
    function setCreatorFeeRecipientBySig(address token, address recipient, uint256 deadline, bytes calldata sig)
        external
    {
        address c = launchpad.creatorOf(token);
        if (block.timestamp > deadline) revert Expired();
        bytes32 d = _hashTypedDataV4(keccak256(abi.encode(SET_RECIPIENT_TYPEHASH, token, recipient, sigNonces[c], deadline)));
        if (c == address(0) || !SignatureChecker.isValidSignatureNow(c, d, sig)) revert NotCreator();
        unchecked {
            ++sigNonces[c];
        }
        _setPayee(token, c, recipient);
    }

    function _setPayee(address token, address c, address recipient) internal {
        if (recipient == c) recipient = address(0);
        _payeeOf[token][c] = recipient;
        _payeeEpoch[token][c] = ILaunchpadEpoch(address(launchpad)).creatorEpoch(token);
        emit CreatorFeeRecipientSet(token, c, recipient);
    }

    /// @notice Where `creator`'s fees for `token` are paid: their pick, else `creator`.
    function creatorFeeRecipientOf(address token, address creator) external view returns (address) {
        address p = _payeeOf[token][creator];
        // audit delta-2 M-01: a pick made in an earlier creator epoch (A → B → A) is void
        if (p == address(0) || _payeeEpoch[token][creator] != ILaunchpadEpoch(address(launchpad)).creatorEpoch(token)) {
            return creator;
        }
        return p;
    }

    function _record(address token, uint8 dest) internal {
        address launcher = launchpad.creatorOf(token);
        if (dest != 0) {
            creatorFeeDestinationOf[token] = dest;
            launcherOf[token] = launcher;
        }
        emit CreatorFeeDestinationSet(token, launcher, dest);
    }

    function _lock(address token, address quote, uint256 tokenAmount, uint256 quoteAmount) internal {
        ILockedDeposit lp = lockedLP;
        if (quoteAmount != 0) {
            IERC20(quote).forceApprove(address(lp), quoteAmount);
            lp.depositCreatorFees_57(token, quote, 0, quoteAmount);
        }
        if (tokenAmount != 0) {
            IERC20(token).forceApprove(address(lp), tokenAmount);
            lp.depositCreatorFees_57(token, quote, tokenAmount, 0);
        }
    }
}
