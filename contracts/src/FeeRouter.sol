// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {FeeMath} from "./libraries/FeeMath.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";
import {IReferralRegistry} from "./interfaces/IReferralRegistry.sol";
import {ILockedLP} from "./interfaces/ILockedLP.sol";
import {ILaunchpad} from "./interfaces/ILaunchpad.sol";
import {Constants} from "./libraries/Constants.sol";

/// @title Fee router — 33/33/33/1 split + creator tax + snipe→LP (§3 / LOCKED #11–#15, #20–#22; §2 #9)
/// @dev Creator + referrer accrue (claim anytime). Treasury auto-pushed. LP-lock auto-added.
contract FeeRouter is IFeeRouter {
    using SafeERC20 for IERC20;

    IReferralRegistry public immutable referrals;
    ILockedLP public lockedLP;
    address public treasury;
    address public owner;
    address public launchpad;

    // token => creator => accrued quote
    mapping(address => mapping(address => uint256)) public override creatorAccrued;
    // referrer => quote => accrued
    mapping(address => mapping(address => uint256)) public override referrerAccrued;

    mapping(address => bool) public authorizedCallers; // curves / migration

    error OnlyOwner();
    error OnlyAuthorized();
    error ZeroAddress();
    error NothingToClaim();

    event TradeFeeRouted(
        address indexed token,
        address indexed quote,
        address indexed trader,
        uint256 creatorShare,
        uint256 lpShare,
        uint256 treasuryShare,
        uint256 referralShare,
        uint256 creatorTaxAmount
    );
    event CreatorFeesClaimed(address indexed token, address indexed creator, uint256 amount);
    event ReferrerFeesClaimed(address indexed quote, address indexed referrer, uint256 amount);
    event TreasuryUpdated(address indexed treasury);
    event SnipeFeeRoutedToLP(address indexed token, address indexed quote, uint256 amount);

    constructor(address owner_, address treasury_, address referrals_) {
        if (owner_ == address(0) || treasury_ == address(0) || referrals_ == address(0)) {
            revert ZeroAddress();
        }
        owner = owner_;
        treasury = treasury_;
        referrals = IReferralRegistry(referrals_);
    }

    function setLaunchpad(address launchpad_) external {
        if (msg.sender != owner) revert OnlyOwner();
        launchpad = launchpad_;
    }

    function setLockedLP(address lockedLP_) external {
        if (msg.sender != owner) revert OnlyOwner();
        lockedLP = ILockedLP(lockedLP_);
    }

    function setTreasury(address treasury_) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function setAuthorized(address caller, bool ok) external {
        if (msg.sender != owner && msg.sender != launchpad) revert OnlyOwner();
        authorizedCallers[caller] = ok;
    }

    /// @inheritdoc IFeeRouter
    /// @dev Resolves current creator via Launchpad.creatorOf (ownership pack §5/#26).
    ///      Accruals already booked to a prior creator stay with them.
    ///      KOL-on-creates (§4/#21): if tokenLaunchKol set, leftover 1% + 2% of creator's 33% → that KOL.
    ///      Else leftover 1% → trader's referrer (or treasury).
    function routeTradeFee(
        address token,
        address quote,
        address trader,
        address creator,
        uint256 feeAmount,
        uint256 creatorTaxAmount
    ) external override {
        if (!authorizedCallers[msg.sender]) revert OnlyAuthorized();
        _route(token, quote, trader, creator, feeAmount, creatorTaxAmount, 0);
    }

    /// @notice Post-grad hook fee: the hook already donated `donated` (= 1/3 of the 33% LP share) to in-range
    ///         v4 LPs via PoolManager.donate, and transferred only `feeAmount - donated` here. Split is computed on
    ///         the full `feeAmount` (creator/treasury/referral unchanged); LockedLP auto-add gets lpShare - donated.
    function routeHookFee(
        address token,
        address feeToken,
        address trader,
        address creator,
        uint256 feeAmount,
        uint256 donated
    ) external override {
        if (!authorizedCallers[msg.sender]) revert OnlyAuthorized();
        _route(token, feeToken, trader, creator, feeAmount, 0, donated);
    }

    function _route(
        address token,
        address quote,
        address trader,
        address creator,
        uint256 feeAmount,
        uint256 creatorTaxAmount,
        uint256 lpDeduct
    ) internal {
        if (feeAmount == 0 && creatorTaxAmount == 0) return;

        // Ownership pack: fee claim + tax rights follow Launchpad registry (multi-hop).
        if (launchpad != address(0)) {
            address current = ILaunchpad(launchpad).creatorOf(token);
            if (current != address(0)) creator = current;
        }

        address registeredQuote = tokenQuote[token];
        bool feeIsQuote = (registeredQuote == address(0) || quote == registeredQuote);

        (uint256 creatorShare, uint256 lpShare, uint256 treasuryShare, uint256 referralShare) =
            FeeMath.splitTradeFee(feeAmount);
        lpShare -= lpDeduct; // donated portion already paid to in-range LPs

        // KOL destination for the 1% leftover
        address launchKol = tokenLaunchKol[token];
        address traderRef = referrals.referrerOf(trader);
        address leftoverTo;
        if (launchKol != address(0)) {
            // Coins created by referred wallet: leftover 1% → creator's KOL (LOCKED #21)
            leftoverTo = launchKol;
        } else if (traderRef != address(0)) {
            leftoverTo = traderRef;
        }

        if (leftoverTo == address(0) || referralShare == 0) {
            treasuryShare += referralShare;
            referralShare = 0;
            leftoverTo = address(0);
        }

        // 2% of creator's 33% share → launch KOL (LOCKED #21)
        uint256 kolFromCreator;
        if (launchKol != address(0) && creatorShare > 0) {
            kolFromCreator = (creatorShare * Constants.KOL_CREATOR_FEE_SHARE_BPS) / Constants.BPS_DENOM;
            creatorShare -= kolFromCreator;
        }

        if (feeIsQuote) {
            creatorAccrued[token][creator] += creatorShare + creatorTaxAmount;

            if (leftoverTo != address(0) && referralShare > 0) {
                referrerAccrued[leftoverTo][quote] += referralShare;
            }
            if (launchKol != address(0) && kolFromCreator > 0) {
                referrerAccrued[launchKol][quote] += kolFromCreator;
            }

            if (treasuryShare > 0) {
                IERC20(quote).safeTransfer(treasury, treasuryShare);
            }

            if (lpShare > 0 && address(lockedLP) != address(0)) {
                IERC20(quote).forceApprove(address(lockedLP), lpShare);
                lockedLP.addLockedLiquidity(token, quote, 0, lpShare);
            }
        } else {
            if (creatorShare + creatorTaxAmount > 0) {
                IERC20(quote).safeTransfer(creator, creatorShare + creatorTaxAmount);
            }
            uint256 refPay = referralShare + kolFromCreator;
            if (leftoverTo != address(0) && leftoverTo == launchKol && refPay > 0) {
                IERC20(quote).safeTransfer(leftoverTo, refPay);
            } else {
                if (leftoverTo != address(0) && referralShare > 0) {
                    IERC20(quote).safeTransfer(leftoverTo, referralShare);
                }
                if (launchKol != address(0) && kolFromCreator > 0) {
                    IERC20(quote).safeTransfer(launchKol, kolFromCreator);
                }
            }
            if (treasuryShare > 0) {
                IERC20(quote).safeTransfer(treasury, treasuryShare);
            }
            if (lpShare > 0 && address(lockedLP) != address(0)) {
                IERC20(quote).forceApprove(address(lockedLP), lpShare);
                lockedLP.addLockedLiquidity(token, registeredQuote, lpShare, 0);
            }
        }

        emit TradeFeeRouted(token, quote, trader, creatorShare, lpShare, treasuryShare, referralShare, creatorTaxAmount);
    }

    /// @inheritdoc IFeeRouter
    /// @dev Anti-snipe fee above protocol 1% — entire amount locks quote into LP (§2 / LOCKED #9).
    function routeSnipeFee(address token, address quote, uint256 snipeFeeAmount) external override {
        if (!authorizedCallers[msg.sender]) revert OnlyAuthorized();
        if (snipeFeeAmount == 0) return;
        if (address(lockedLP) == address(0)) revert ZeroAddress();

        IERC20(quote).forceApprove(address(lockedLP), snipeFeeAmount);
        lockedLP.addLockedLiquidity(token, quote, 0, snipeFeeAmount);
        emit SnipeFeeRoutedToLP(token, quote, snipeFeeAmount);
    }

    /// @inheritdoc IFeeRouter
    function claimCreatorFees(address token) external override returns (uint256 amount) {
        amount = creatorAccrued[token][msg.sender];
        if (amount == 0) revert NothingToClaim();
        creatorAccrued[token][msg.sender] = 0;
        // Quote asset for this token must be known by caller context; scaffold stores per-token
        // via curve — production wires quote lookup. For now pull from token→quote registry on launchpad.
        address quote = _quoteOf(token);
        IERC20(quote).safeTransfer(msg.sender, amount);
        emit CreatorFeesClaimed(token, msg.sender, amount);
    }

    /// @inheritdoc IFeeRouter
    function claimReferrerFees(address quote) external override returns (uint256 amount) {
        amount = referrerAccrued[msg.sender][quote];
        if (amount == 0) revert NothingToClaim();
        referrerAccrued[msg.sender][quote] = 0;
        IERC20(quote).safeTransfer(msg.sender, amount);
        emit ReferrerFeesClaimed(quote, msg.sender, amount);
    }

    /// @dev Launchpad registers token→quote; overridden in full wiring.
    mapping(address => address) public tokenQuote;
    /// @dev Referrer of the launching wallet at launch (KOL on creates — LOCKED #21). Immutable per token.
    mapping(address => address) public tokenLaunchKol;

    function registerTokenQuote(address token, address quote) external {
        if (msg.sender != launchpad && msg.sender != owner) revert OnlyOwner();
        tokenQuote[token] = quote;
    }

    /// @notice Launchpad registers quote + freezes creator's referrer as KOL-on-creates (LOCKED #21).
    function registerTokenLaunch(address token, address quote, address launchingCreator) external {
        if (msg.sender != launchpad && msg.sender != owner) revert OnlyOwner();
        tokenQuote[token] = quote;
        address kol = referrals.referrerOf(launchingCreator);
        if (kol != address(0)) tokenLaunchKol[token] = kol;
    }

    function _quoteOf(address token) internal view returns (address) {
        address q = tokenQuote[token];
        require(q != address(0), "FeeRouter: no quote");
        return q;
    }
}
