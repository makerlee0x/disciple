// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

interface ILaunchFeeDest {
    function creatorOf(address token) external view returns (address);
    function creatorFeeDestinationOf(address token) external view returns (uint8);
    function updateMetadata(
        address token,
        string calldata imageURI,
        string calldata description,
        string calldata socialsURI
    ) external;
}

interface ITokenCreator {
    function creator() external view returns (address);
}

interface IFeeClaims {
    function creatorAccrued(address token, address creator) external view returns (uint256);
    function claimCreatorFees(address token) external returns (uint256);
    function creatorTokenAccrued(address token, address creator) external view returns (uint256);
    function claimCreatorTokenFees(address token) external returns (uint256);
    function tokenQuote(address token) external view returns (address);
}

interface ILockedLPDeposit {
    function addLockedLiquidity(address token, address quote, uint256 tokenAmount, uint256 quoteAmount)
        external
        returns (uint256);
    function getPoolKey(address token) external view returns (PoolKey memory);
    function isGraduated(address token) external view returns (bool);
}

interface IRouterSell {
    function quoteExactIn(address token, bool isBuy, uint256 amountIn)
        external
        returns (uint256 amountOut, uint256 impactBps, uint256 mcapAfterUsd);
    function sellExactIn(address token, uint256 tokensIn, uint256 minQuoteOut, address recipient, uint256 deadline)
        external
        returns (uint256 quoteOut);
}

interface IHookPriceGuard {
    function swappedInTx(PoolId id) external view returns (bool);
    function compoundRefs(PoolId id) external view returns (uint160 refBlock, uint160 refEma);
}

/// @title Creator fee manager
/// @notice Holds the creator role for coins that do not keep their creator fee. Trades are unchanged: FeeRouter
///         still accrues the creator share and the creator tax to this contract, and anyone may later call `route`.
/// @dev Destination 1 deposits both fee sides into LockedLP (the position can never be withdrawn).
///      Destination 2 burns the quote token. On the bonding curve the creator fee is entirely quote, so it is
///      burned. After orbit the quote half is burned, and the rocket-token half is sold for more quote and that
///      quote is burned. Rocket-token fees are never sent to the pool under destination 2.
contract CreatorFeeManager is ReentrancyGuard {
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

    ILaunchFeeDest public immutable launchpad;
    IFeeClaims public immutable feeRouter;
    ILockedLPDeposit public immutable lockedLP;
    IRouterSell public immutable router;
    IHookPriceGuard public immutable hook;
    IPoolManager public immutable poolManager;

    error ZeroAddress();
    error NotFeeManager();
    error NotBeneficiary();
    error BadDestination();
    error NothingToRoute();
    /// @notice Rocket-token fees are waiting for orbit. There is no quote fee to burn yet.
    error AwaitingOrbit();
    /// @notice The quote-token buy was refused because the pool price is outside the guard, or the sell failed.
    error PriceGuard();

    /// @notice `quoteAmount` was locked or burned. `rocketTokenAmount` was locked (destination 1) or sold
    ///         (destination 2). `quoteBought` is quote bought with the rocket-token half and then burned.
    event CreatorFeesRouted(
        address indexed token, uint8 destination, uint256 quoteAmount, uint256 rocketTokenAmount, uint256 quoteBought
    );

    constructor(
        address launchpad_,
        address feeRouter_,
        address lockedLP_,
        address router_,
        address hook_,
        address poolManager_
    ) {
        if (
            launchpad_ == address(0) || feeRouter_ == address(0) || lockedLP_ == address(0) || router_ == address(0)
                || hook_ == address(0) || poolManager_ == address(0)
        ) revert ZeroAddress();
        launchpad = ILaunchFeeDest(launchpad_);
        feeRouter = IFeeClaims(feeRouter_);
        lockedLP = ILockedLPDeposit(lockedLP_);
        router = IRouterSell(router_);
        hook = IHookPriceGuard(hook_);
        poolManager = IPoolManager(poolManager_);
    }

    /// @notice The launcher edits image, description, and socials. For a private launch the caller is AnonLauncher,
    ///         which already checked the stealth owner's signature. Name and ticker cannot change.
    function updateMetadata(
        address token,
        string calldata imageURI,
        string calldata description,
        string calldata socialsURI
    ) external {
        if (launchpad.creatorOf(token) != address(this)) revert NotFeeManager();
        if (msg.sender != ITokenCreator(token).creator()) revert NotBeneficiary();
        launchpad.updateMetadata(token, imageURI, description, socialsURI);
    }

    /// @notice Quote still owed to this contract, plus rocket tokens owed or already held here waiting for orbit.
    function pending(address token) external view returns (uint256 quoteAmount, uint256 rocketTokenAmount) {
        quoteAmount = feeRouter.creatorAccrued(token, address(this));
        rocketTokenAmount = feeRouter.creatorTokenAccrued(token, address(this)) + IERC20(token).balanceOf(address(this));
    }

    /// @notice Anyone may send this coin's creator fee where the launcher chose. The crew tip is not touched.
    /// @return quoteAmount quote locked into the pool, or quote burned
    /// @return rocketTokenAmount rocket tokens locked into the pool, or rocket tokens sold
    /// @return quoteBought extra quote bought with the rocket-token half and burned (destination 2, after orbit)
    function route(address token)
        external
        nonReentrant
        returns (uint256 quoteAmount, uint256 rocketTokenAmount, uint256 quoteBought)
    {
        if (launchpad.creatorOf(token) != address(this)) revert NotFeeManager();
        uint8 dest = launchpad.creatorFeeDestinationOf(token);
        if (dest != DEST_LOCKED_LP && dest != DEST_BURN_QUOTE) revert BadDestination();

        IFeeClaims fr = feeRouter;
        uint256 qAcc = fr.creatorAccrued(token, address(this));
        uint256 tAcc = fr.creatorTokenAccrued(token, address(this));
        uint256 tHeld = IERC20(token).balanceOf(address(this));
        uint256 tTotal = tAcc + tHeld;
        if (qAcc == 0 && tTotal == 0) revert NothingToRoute();

        bool graduated = lockedLP.isGraduated(token);
        bool sellNow;
        if (dest == DEST_BURN_QUOTE && tTotal != 0) {
            if (!graduated) {
                if (qAcc == 0) revert AwaitingOrbit();
            } else if (_priceOk(token)) {
                sellNow = true;
            } else if (qAcc == 0) {
                revert PriceGuard();
            }
        }

        if (qAcc != 0) qAcc = fr.claimCreatorFees(token);
        if (tAcc != 0) fr.claimCreatorTokenFees(token);
        tTotal = IERC20(token).balanceOf(address(this));
        address quote = fr.tokenQuote(token);

        if (dest == DEST_LOCKED_LP) {
            _lock(token, quote, tTotal, qAcc);
            quoteAmount = qAcc;
            rocketTokenAmount = tTotal;
        } else {
            if (qAcc != 0) {
                IERC20(quote).safeTransfer(BURN, qAcc);
                quoteAmount = qAcc;
            }
            if (sellNow && tTotal != 0) {
                try this.executeSell(token, tTotal) returns (uint256 sold, uint256 bought) {
                    rocketTokenAmount = sold;
                    quoteBought = bought;
                } catch {
                    // Quote already burned stays burned. Rocket tokens stay here for a later route.
                    if (qAcc == 0) revert PriceGuard();
                }
            }
        }

        emit CreatorFeesRouted(token, dest, quoteAmount, rocketTokenAmount, quoteBought);
    }

    /// @notice Sells `amount` of the rocket for its quote token and burns that quote, including the creator fee
    ///         the sell itself just accrued. Only this contract may call it (used so a failed sell does not undo
    ///         a quote burn in the same `route`).
    function executeSell(address token, uint256 amount) external returns (uint256 sold, uint256 quoteBurned) {
        if (msg.sender != address(this)) revert NotFeeManager();
        address quote = feeRouter.tokenQuote(token);
        (uint256 quoted,,) = router.quoteExactIn(token, false, amount);
        uint256 minOut = quoted - Math.mulDiv(quoted, SLIPPAGE_BPS, 10_000);
        if (minOut == 0) revert PriceGuard();
        IERC20(token).forceApprove(address(router), amount);
        uint256 got = router.sellExactIn(token, amount, minOut, address(this), block.timestamp);
        uint256 extra = feeRouter.creatorAccrued(token, address(this));
        if (extra != 0) extra = feeRouter.claimCreatorFees(token);
        quoteBurned = got + extra;
        IERC20(quote).safeTransfer(BURN, quoteBurned);
        sold = amount;
    }

    function _lock(address token, address quote, uint256 tokenAmount, uint256 quoteAmount) internal {
        if (quoteAmount != 0) {
            IERC20(quote).forceApprove(address(lockedLP), quoteAmount);
            lockedLP.addLockedLiquidity(token, quote, 0, quoteAmount);
        }
        if (tokenAmount != 0) {
            IERC20(token).forceApprove(address(lockedLP), tokenAmount);
            lockedLP.addLockedLiquidity(token, quote, tokenAmount, 0);
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

    /// @dev |(hi/lo)^2 - 1| in bps. Same conversion LockedLP uses for its compound guard.
    function _deviationBps(uint160 a, uint160 b) internal pure returns (uint256) {
        if (a == b) return 0;
        if (a == 0 || b == 0) return type(uint256).max;
        (uint256 hi, uint256 lo) = a > b ? (uint256(a), uint256(b)) : (uint256(b), uint256(a));
        return Math.mulDiv(Math.mulDiv(hi, 10_000, lo), hi, lo) - 10_000;
    }
}
