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
/// @dev Creator, referrer, KOL and treasury accrue (claim anytime). Only the LP share moves per trade (compounds).
interface ILockedLPCredit {
    function creditLockedLiquidity(address token, address quote, uint256 tokenAmount, uint256 quoteAmount)
        external
        returns (bool compoundReady);
}

interface IRewardsVault {
    function notifyReward(address token, address asset, uint256 amount) external;
}

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

    /// @notice Treasury share (33% + unrouted 1% + 30% of anti-snipe) accrued per asset; anyone may push it to
    ///         `treasury` with claimTreasury(asset). Replaces the per-trade treasury transfer (gas).
    mapping(address => uint256) public treasuryAccrued;
    /// @notice Post-grad creator share charged in the LAUNCH TOKEN (hook fee on buys) — token => creator => amount.
    mapping(address => mapping(address => uint256)) public creatorTokenAccrued;

    error OnlyOwner();
    error OnlyAuthorized();
    error ZeroAddress();
    error NothingToClaim();

    /// @notice Audit #11: full fee breakdown with payees. Amounts are in `feeToken` units: the curve quote
    ///         pre-graduation, and post-graduation whichever pool side the hook charged (quote OR launch token —
    ///         `feeIsQuote` tells which; never mix the two units off-chain).
    ///         referralPayee gets referralShare (the 1% leftover); kolPayee (launch KOL) gets kolShare, which is
    ///         carved out of the creator's 33% (creatorShare is already net of it).
    event TradeFeeRouted(
        address indexed token,
        address indexed feeToken,
        address indexed trader,
        bool feeIsQuote,
        address creator,
        uint256 creatorShare,
        uint256 creatorTaxAmount,
        uint256 lpShare,
        uint256 treasuryShare,
        address referralPayee,
        uint256 referralShare,
        address kolPayee,
        uint256 kolShare
    );
    event CreatorFeesClaimed(address indexed token, address indexed creator, uint256 amount);
    event ReferrerFeesClaimed(address indexed quote, address indexed referrer, uint256 amount);
    event TreasuryFeesClaimed(address indexed asset, address indexed treasury, uint256 amount);
    event CreatorTokenFeesClaimed(address indexed token, address indexed creator, uint256 amount);
    event TreasuryUpdated(address indexed treasury);
    event SnipeFeeRouted(address indexed token, address indexed quote, uint256 toRewards, uint256 toTreasury);
    event RewardsVaultUpdated(address indexed vault);

    /// @notice Community rewards vault (70% of anti-snipe tax).
    address public rewardsVault;

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
        _route(token, quote, trader, creator, feeAmount, creatorTaxAmount);
    }

    /// @notice Post-grad hook fee: the hook transfers the full `feeAmount` here. Split 33/33/33/1; the whole 33%
    ///         LP share goes to LockedLP, which auto-compounds it per trade into the locked position (no in-range donation).
    function routeHookFee(address token, address feeToken, address trader, address creator, uint256 feeAmount)
        external
        override
        returns (bool compoundReady)
    {
        if (!authorizedCallers[msg.sender]) revert OnlyAuthorized();
        return _route(token, feeToken, trader, creator, feeAmount, 0);
    }

    function _route(
        address token,
        address quote,
        address trader,
        address creator,
        uint256 feeAmount,
        uint256 creatorTaxAmount
    ) internal returns (bool ready) {
        if (feeAmount == 0 && creatorTaxAmount == 0) return false;

        // Ownership pack: fee claim + tax rights follow Launchpad registry (multi-hop).
        if (launchpad != address(0)) {
            address current = ILaunchpad(launchpad).creatorOf(token);
            if (current != address(0)) creator = current;
        }

        address registeredQuote = tokenQuote[token];
        bool feeIsQuote = (registeredQuote == address(0) || quote == registeredQuote);

        (uint256 creatorShare, uint256 lpShare, uint256 treasuryShare, uint256 referralShare) =
            FeeMath.splitTradeFee(feeAmount);

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

        // Gas (accrue-then-claim, constitution #13/#22): every payee is credited in storage; only the LP share
        // moves per trade (it must compound). Treasury / token-side creator / referrer / KOL claim later.
        if (feeIsQuote) {
            uint256 cAmt = creatorShare + creatorTaxAmount;
            if (cAmt != 0) creatorAccrued[token][creator] += cAmt;
        } else {
            uint256 cAmt = creatorShare + creatorTaxAmount;
            if (cAmt != 0) creatorTokenAccrued[token][creator] += cAmt;
        }
        if (referralShare != 0) referrerAccrued[leftoverTo][quote] += referralShare;
        if (kolFromCreator != 0) referrerAccrued[launchKol][quote] += kolFromCreator;
        if (treasuryShare != 0) treasuryAccrued[quote] += treasuryShare;
        if (lpShare != 0) {
            ILockedLP lp = lockedLP;
            if (address(lp) != address(0)) {
                // Push straight to LockedLP and credit (no approve + transferFrom round trip).
                IERC20(quote).safeTransfer(address(lp), lpShare);
                ready = feeIsQuote
                    ? ILockedLPCredit(address(lp)).creditLockedLiquidity(token, quote, 0, lpShare)
                    : ILockedLPCredit(address(lp)).creditLockedLiquidity(token, registeredQuote, lpShare, 0);
            } // unwired LockedLP: share stays in FeeRouter (unchanged behaviour)
        }

        emit TradeFeeRouted(
            token,
            quote,
            trader,
            feeIsQuote,
            creator,
            creatorShare,
            creatorTaxAmount,
            lpShare,
            treasuryShare,
            leftoverTo,
            referralShare,
            kolFromCreator > 0 ? launchKol : address(0),
            kolFromCreator
        );
    }

    /// @inheritdoc IFeeRouter
    /// @dev Anti-snipe fee above protocol 1% (§2 / LOCKED #9 rev. 2026-10-15): 70% → community RewardsVault,
    ///      30% (incl. rounding remainder) → treasury. If no vault is set, 100% → treasury (never blocks buys).
    function routeSnipeFee(address token, address quote, uint256 snipeFeeAmount) external override {
        if (!authorizedCallers[msg.sender]) revert OnlyAuthorized();
        if (snipeFeeAmount == 0) return;
        _routeSnipe(token, quote, snipeFeeAmount);
    }

    function _routeSnipe(address token, address quote, uint256 snipeFeeAmount) internal {

        address vault = rewardsVault;
        uint256 toRewards =
            vault == address(0) ? 0 : (snipeFeeAmount * Constants.SNIPE_REWARDS_BPS) / Constants.BPS_DENOM;
        uint256 toTreasury = snipeFeeAmount - toRewards;
        if (toRewards > 0) {
            IERC20(quote).safeTransfer(vault, toRewards);
            IRewardsVault(vault).notifyReward(token, quote, toRewards);
        }
        if (toTreasury > 0) treasuryAccrued[quote] += toTreasury;
        emit SnipeFeeRouted(token, quote, toRewards, toTreasury);
    }

    /// @notice Owner sets the community rewards vault (70% of anti-snipe tax). address(0) = all to treasury.
    function setRewardsVault(address vault) external {
        if (msg.sender != owner) revert OnlyOwner();
        rewardsVault = vault;
        emit RewardsVaultUpdated(vault);
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

    /// @notice Creator share accrued in the launch token itself (post-graduation buys pay the hook fee in token).
    function claimCreatorTokenFees(address token) external returns (uint256 amount) {
        amount = creatorTokenAccrued[token][msg.sender];
        if (amount == 0) revert NothingToClaim();
        creatorTokenAccrued[token][msg.sender] = 0;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit CreatorTokenFeesClaimed(token, msg.sender, amount);
    }

    /// @notice Permissionless: push the accrued treasury balance of `asset` to the current `treasury`.
    function claimTreasury(address asset) external returns (uint256 amount) {
        amount = treasuryAccrued[asset];
        if (amount == 0) revert NothingToClaim();
        treasuryAccrued[asset] = 0;
        address t = treasury;
        IERC20(asset).safeTransfer(t, amount);
        emit TreasuryFeesClaimed(asset, t, amount);
    }

    /// @notice Single-call curve fee entry: trade fee (+creator tax) and anti-snipe fee in one transfer + one call.
    function routeCurveFees(
        address token,
        address quote,
        address trader,
        address creator,
        uint256 protoFee,
        uint256 creatorTaxAmount,
        uint256 snipeFeeAmount
    ) external {
        if (!authorizedCallers[msg.sender]) revert OnlyAuthorized();
        _route(token, quote, trader, creator, protoFee, creatorTaxAmount);
        if (snipeFeeAmount != 0) _routeSnipe(token, quote, snipeFeeAmount);
    }

    /// @notice Authorized caller (curve) already transferred `amount` of `asset` here for the treasury
    ///         (PVE profit tax that found no other holder before graduation).
    function accrueTreasury(address asset, uint256 amount) external {
        if (!authorizedCallers[msg.sender]) revert OnlyAuthorized();
        treasuryAccrued[asset] += amount;
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
