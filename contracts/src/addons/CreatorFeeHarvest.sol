// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {ILaunchpad} from "../interfaces/ILaunchpad.sol";
import {Owned2Step} from "../utils/Owned2Step.sol";

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
    function quoteExactIn(address token, bool isBuy, uint256 amountIn)
        external
        returns (uint256 amountOut, uint256 impactBps, uint256 mcapAfterUsd);
    function sellExactIn(address token, uint256 tokensIn, uint256 minQuoteOut, address recipient, uint256 deadline)
        external
        returns (uint256 quoteOut);
}

interface IHarvestAnon {
    function launchFee() external view returns (uint256);
    function feeToken() external view returns (address);
    function launchAnon(
        ILaunchpad.LaunchParams calldata p,
        address stealthOwner,
        address buyRecipient,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag,
        uint256 maxFee
    ) external returns (ILaunchpad.LaunchResult memory);
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
    ) external returns (ILaunchpad.LaunchResult memory, uint256 usdgRefund);
    function forwardTokenFees(address token) external;
}

interface IHookGuard {
    function swappedInTx(PoolId id) external view returns (bool);
    function compoundRefs(PoolId id) external view returns (uint160 refBlock, uint160 refEma);
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
///      quote half is burned and the rocket-token half is sold for more quote, which is burned.
///      `route` pulls both halves itself. The launcher does not claim, approve, or deposit.
contract CreatorFeeHarvest is ReentrancyGuard, Owned2Step {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    /// @notice Creator fees are deposited into the rocket's locked liquidity pool, and that liquidity is renounced.
    uint8 public constant DEST_LOCKED_LP = 1;
    /// @notice Creator fees buy and burn the quote token.
    uint8 public constant DEST_BURN_QUOTE = 2;

    /// @notice Nobody can move tokens sent here.
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    /// @notice Spot must be within this many bps of the hook's block-start price and its EMA before a sell.
    ///         Same 3% band LockedLP uses for compounding. A same-transaction swap is refused outright.
    uint256 public constant MAX_DEV_BPS = 300;
    /// @notice Minimum quote out of the sell, versus a same-transaction quote of that exact sell.
    uint256 public constant SLIPPAGE_BPS = 100;
    /// @notice Audit CH-01: one burn sell may move the pool at most this much. A larger balance is halved until a
    ///         chunk fits (up to MAX_SELL_HALVINGS times); the rest stays parked for a later `route`.
    uint256 public constant MAX_SELL_IMPACT_BPS = MAX_DEV_BPS;
    uint256 public constant MAX_SELL_HALVINGS = 12;
    /// @notice Audit CH-01: the sell must also return at least the EMA value of the chunk, less this many bps
    ///         (the 3% guard band, the 3% impact cap and the 1% swap fee). A same-transaction quote cannot
    ///         protect a sell whose pool was pushed in an earlier transaction; the EMA can.
    uint256 public constant EMA_FLOOR_SLACK_BPS = 2 * MAX_DEV_BPS + MAX_SELL_IMPACT_BPS + 100;

    ILaunchpadFor public launchpad;
    IFeePull public feeRouter;
    ILockedDeposit public lockedLP;
    IHarvestRouter public router;
    IHookGuard public hook;
    IPoolManager public poolManager;
    IHarvestAnon public anon;
    /// @notice Curve-phase creator fees settle here (#312). `route` pulls them. Trades do not read this.
    IVaultPull public feeVault;

    /// @notice Fixed at launch. 0 (or unset) means the launcher keeps the fees. 1 locks them. 2 burns the quote.
    mapping(address token => uint8 dest) public creatorFeeDestinationOf;
    /// @notice `creatorOf` at the moment the choice was recorded. `route` also pulls this address when a later
    ///         `transferCreator` moved the role, so fees that accrued to the original launcher are not stuck.
    mapping(address token => address launcher) public launcherOf;
    /// @notice Rocket-token fees already pulled, waiting for a sell that the price guard refused.
    mapping(address token => uint256 amount) public rocketDeposited;

    error ZeroAddress();
    error AlreadyWired();
    error BadDestination();
    /// @notice A leftover refund cannot be sent to this contract, where nobody could take it out.
    error BadRefundTo();
    error NotLauncher();
    error NothingToRoute();
    /// @notice Rocket-token fees are waiting for orbit. There is no quote fee to burn yet.
    error AwaitingOrbit();
    /// @notice The quote-token buy was refused because the pool price is outside the guard, or the sell failed.
    error PriceGuard();
    error Expired();
    error Slippage();

    /// @notice `launcher` is who FeeRouter pays (`creatorOf`): the wallet, or AnonLauncher for a private coin.
    event CreatorFeeDestinationSet(address indexed token, address indexed launcher, uint8 destination);
    /// @notice `quoteAmount` was locked or burned. `rocketTokenAmount` was locked or sold.
    ///         `quoteBought` is quote from that sale, including the creator fee the sale itself accrued, then burned.
    event CreatorFeesRouted(
        address indexed token, uint8 destination, uint256 quoteAmount, uint256 rocketTokenAmount, uint256 quoteBought
    );
    event RocketTokensDeposited(address indexed token, address indexed from, uint256 amount);

    constructor(address owner_) Owned2Step(owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
    }

    /// @notice Owner wires the live stack once. This contract must also be `Launchpad.setTrustedRouter` and
    ///         `FeeRouter.setClaimRouter`, the same allowlist DiscipleRouter is on for `claimCreatorFeesFor`.
    function wire(
        address launchpad_,
        address feeRouter_,
        address lockedLP_,
        address router_,
        address hook_,
        address poolManager_
    ) external {
        _checkOwner();
        if (address(launchpad) != address(0)) revert AlreadyWired();
        if (
            launchpad_ == address(0) || feeRouter_ == address(0) || lockedLP_ == address(0) || router_ == address(0)
                || hook_ == address(0) || poolManager_ == address(0)
        ) revert ZeroAddress();
        launchpad = ILaunchpadFor(launchpad_);
        feeRouter = IFeePull(feeRouter_);
        lockedLP = ILockedDeposit(lockedLP_);
        router = IHarvestRouter(router_);
        hook = IHookGuard(hook_);
        poolManager = IPoolManager(poolManager_);
    }

    /// @notice CurveFeeVault that holds this chain's curve-phase creator fees. `route` pulls it.
    function setFeeVault(address vault_) external {
        _checkOwner();
        if (vault_ == address(0)) revert ZeroAddress();
        feeVault = IVaultPull(vault_);
    }

    /// @notice Private launches. The stealth owner is not paid when the destination is 1 or 2.
    function setAnonLauncher(address anon_) external {
        _checkOwner();
        if (anon_ == address(0)) revert ZeroAddress();
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
        if (creatorFeeDestination > 2) revert BadDestination();
        if (block.timestamp > params.deadline) revert Expired();
        ILaunchpadFor pad = launchpad;
        IHarvestRouter rtr = router;
        address q = params.quote == address(0) ? pad.defaultQuote() : params.quote;
        ILaunchpad.LaunchParams memory m = params;
        m.quote = q;
        address u = rtr.usdg();
        // Audit CH-02: snapshot before any USDG or quote arrives, so `left` is only the unspent First BOOST.
        uint256 bal0 = IERC20(q).balanceOf(address(this));
        uint256 quoteAmt;
        if (usdgIn != 0) {
            if (u == address(0)) revert ZeroAddress();
            IERC20(u).safeTransferFrom(msg.sender, address(this), usdgIn);
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
        result = pad.launchFor(msg.sender, m, mode);
        uint256 left = IERC20(q).balanceOf(address(this)) - bal0;
        if (left != 0) {
            if (u == address(0) || q == u) {
                IERC20(q).safeTransfer(msg.sender, left);
                usdgRefund = left;
            } else {
                IERC20(q).forceApprove(address(rtr), left);
                usdgRefund = rtr.swapQuoteToUsdg(q, left, 1, msg.sender, params.deadline);
            }
        }
        _record(result.token, creatorFeeDestination);
    }

    /// @notice Private launch. AnonLauncher stays `creatorOf`. `creatorFeeDestination` is recorded here.
    function launchAnon(
        ILaunchpad.LaunchParams calldata params,
        address stealthOwner,
        address buyRecipient,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag,
        uint256 maxFee,
        uint8 creatorFeeDestination
    ) external nonReentrant returns (ILaunchpad.LaunchResult memory result) {
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
        result = a.launchAnon(params, stealthOwner, buyRecipient, ephemeralPubKey, viewTag, maxFee);
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
        (result, usdgRefund) = a.launchAnonWithUsdg(
            params, stealthOwner, buyRecipient, ephemeralPubKey, viewTag, maxFee, usdgIn, minQuoteIn, refund
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
        bool sellNow;
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
            if (pulled.sellNow) {
                try this.executeSell(token, pulled.rockets, pulled.current) returns (uint256 sold, uint256 bought) {
                    // Audit CH-01: a chunked sell leaves the unsold rest parked for the next `route`.
                    rocketDeposited[token] = pulled.rockets - sold;
                    rocketTokenAmount = sold;
                    quoteBought = bought;
                } catch {
                    // Quote already burned stays burned. Rocket tokens stay here for a later route.
                    if (pulled.quoteAmount == 0) revert PriceGuard();
                }
            }
        }
        emit CreatorFeesRouted(token, dest, quoteAmount, rocketTokenAmount, quoteBought);
    }

    /// @dev Reads both creators, decides whether a burn-destination sell is allowed, then pulls both halves.
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
        if (dest == DEST_BURN_QUOTE && pulled.rockets != 0) {
            if (!lockedLP.isGraduated(token)) {
                if (pulled.quoteAmount == 0) revert AwaitingOrbit();
            } else if (_priceOk(token)) {
                pulled.sellNow = true;
            } else if (pulled.quoteAmount == 0) {
                revert PriceGuard();
            }
        }
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

    /// @notice Sells `amount` of the rocket for its quote and burns that quote, including the creator fee
    ///         the sell just accrued to `launcher`. Only this contract may call it, so a failed sell does not
    ///         undo a quote burn already done in `route`.
    function executeSell(address token, uint256 amount, address launcher)
        external
        returns (uint256 sold, uint256 quoteBurned)
    {
        if (msg.sender != address(this)) revert NotLauncher();
        address quote = feeRouter.tokenQuote(token);
        IHarvestRouter rtr = router;
        // Audit CH-01: sell at most a chunk that moves the pool <= MAX_SELL_IMPACT_BPS (halving a lump that the
        // router would refuse or that would move the price too far), and floor the output at the EMA value.
        uint256 quoted;
        for (uint256 i;; ++i) {
            try rtr.quoteExactIn(token, false, amount) returns (uint256 out, uint256 impactBps, uint256) {
                if (impactBps <= MAX_SELL_IMPACT_BPS) {
                    quoted = out;
                    break;
                }
            } catch {}
            if (i == MAX_SELL_HALVINGS) revert PriceGuard();
            amount /= 2;
            if (amount == 0) revert PriceGuard();
        }
        uint256 minOut = quoted - Math.mulDiv(quoted, SLIPPAGE_BPS, 10_000);
        uint256 emaFloor = _emaValue(token, amount);
        emaFloor -= Math.mulDiv(emaFloor, EMA_FLOOR_SLACK_BPS, 10_000);
        if (emaFloor > minOut) minOut = emaFloor;
        if (minOut == 0) revert PriceGuard();
        IERC20(token).forceApprove(address(rtr), amount);
        uint256 got = rtr.sellExactIn(token, amount, minOut, address(this), block.timestamp);
        uint256 extra = feeRouter.creatorAccrued(token, launcher);
        if (extra != 0) extra = feeRouter.claimCreatorFeesFor(token, launcher);
        quoteBurned = got + extra;
        IERC20(quote).safeTransfer(BURN, quoteBurned);
        sold = amount;
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

    /// @dev Refuses a sell in a transaction that already swapped this pool, or when spot is more than MAX_DEV_BPS
    ///      from the hook EMA (and from this block's start price, when the pool has traded this block).
    function _priceOk(address token) internal view returns (bool) {
        PoolKey memory key = lockedLP.getPoolKey(token);
        if (address(key.hooks) == address(0)) return false;
        PoolId id = key.toId();
        if (hook.swappedInTx(id)) return false;
        (uint160 refBlock, uint160 refEma) = hook.compoundRefs(id);
        if (refEma == 0) return false;
        (uint160 sqrtP,,,) = poolManager.getSlot0(id);
        if (_deviationBps(sqrtP, refEma) > MAX_DEV_BPS) return false;
        if (refBlock != 0 && _deviationBps(sqrtP, refBlock) > MAX_DEV_BPS) return false;
        return true;
    }

    /// @dev Quote value of `amount` rocket tokens at the hook's EMA price (0 when the hook has no EMA yet, in which
    ///      case `_priceOk` already refused the sell).
    function _emaValue(address token, uint256 amount) internal view returns (uint256) {
        PoolKey memory key = lockedLP.getPoolKey(token);
        (, uint160 ema) = hook.compoundRefs(key.toId());
        if (ema == 0) return 0;
        uint256 q96 = 1 << 96;
        if (Currency.unwrap(key.currency0) == token) {
            return Math.mulDiv(Math.mulDiv(amount, ema, q96), ema, q96);
        }
        return Math.mulDiv(Math.mulDiv(amount, q96, ema), q96, ema);
    }

    /// @dev |(hi/lo)^2 - 1| in bps. Same conversion LockedLP uses for its compound guard.
    function _deviationBps(uint160 a, uint160 b) internal pure returns (uint256) {
        if (a == b) return 0;
        if (a == 0 || b == 0) return type(uint256).max;
        (uint256 hi, uint256 lo) = a > b ? (uint256(a), uint256(b)) : (uint256(b), uint256(a));
        return Math.mulDiv(Math.mulDiv(hi, 10_000, lo), hi, lo) - 10_000;
    }
}
