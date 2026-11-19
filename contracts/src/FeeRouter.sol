// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Owned2Step} from "./utils/Owned2Step.sol";
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

contract FeeRouter is IFeeRouter, Owned2Step {
    using SafeERC20 for IERC20;

    IReferralRegistry public immutable referrals;
    ILockedLP public lockedLP;
    address public treasury;
    address public launchpad;

    // token => creator => accrued quote
    mapping(address => mapping(address => uint256)) public override creatorAccrued;
    // referrer => quote => accrued
    mapping(address => mapping(address => uint256)) public override referrerAccrued;

    mapping(address => bool) public authorizedCallers; // curves / migration
    /// @notice One-way (audit 2026-11-17 R461-01b / R461-04): once set, the KOL share, referral sink and claim-router
    ///         list can never change, so no later key can take creator fees or re-split existing coins' fees.
    bool public settingsLocked;

    /// @notice Treasury share (33% + unrouted 1% [+ 30% of a legacy routeSnipeFee call; v2 curves never make one]) accrued per asset; anyone may push it to
    ///         `treasury` with claimTreasury(asset). Replaces the per-trade treasury transfer (gas).
    mapping(address => uint256) public treasuryAccrued;
    /// @notice Phase 3a (Maker lee 2026-10-24; widened 2026-11-19): when set, the WHOLE 1% referral share of every
    ///         trade (referred or not, incl. a launch KOL's) goes here: the community rewards Safe on mainnet. treasury →
    ///         credited to treasuryAccrued; any other address → claimable via claimReferrerFees. address(0) = off
    ///         (today's routing). Future trades only; already-accrued referral fees stay claimable. The KOL's 2% of
    ///         the creator share is NOT redirected. A sink equal to the treasury follows setTreasury (audit r127).
    address public referralSink;
    /// @notice Launch KOL's cut of the creator share, in bps of that share (redeploy pack, lee 2026-10-24). Default
    ///         200 (= the old KOL_CREATOR_FEE_SHARE_BPS), owner-settable in [0, MAX_KOL_CREATOR_SHARE_BPS]; future
    ///         trades only. Packed with referralSink (one slot). The 1% referral / referralSink routing is unchanged.
    uint16 public kolCreatorShareBps = uint16(Constants.KOL_CREATOR_FEE_SHARE_BPS);
    uint256 public constant MAX_KOL_CREATOR_SHARE_BPS = 500;
    /// @notice Post-grad creator share charged in the LAUNCH TOKEN (hook fee on buys) — token => creator => amount.
    mapping(address => mapping(address => uint256)) public creatorTokenAccrued;
    error OnlyAuthorized();
    error ZeroAddress();
    error NothingToClaim();
    error KolShareTooHigh();
    error LaunchpadAlreadySet();
    error QuoteAlreadySet();
    error NotAContract();
    error AlreadyWired();
    error SettingsLocked();
    /// @notice Destination 1 or 2. The later-send contract pulls these fees. The launcher cannot claim them.
    error CreatorFeesRouted();
    /// @notice maker 2026-11-19: only the coin's current creator claims; a past creator's balance moves to them.
    error NotCurrentCreator();

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
    event ReferralSinkSet(address indexed previous, address indexed sink);
    event KolCreatorShareSet(uint256 previousBps, uint256 bps);
    event ReferrerFeesClaimed(address indexed quote, address indexed referrer, uint256 amount);
    event TreasuryFeesClaimed(address indexed asset, address indexed treasury, uint256 amount);
    event CreatorTokenFeesClaimed(address indexed token, address indexed creator, uint256 amount);
    event TreasuryUpdated(address indexed treasury);
    event SnipeFeeRouted(address indexed token, address indexed quote, uint256 toRewards, uint256 toTreasury);
    event RewardsVaultUpdated(address indexed vault);
    event PastCreatorFeesSwept(
        address indexed token, address indexed past, address indexed current, uint256 quoteAmount, uint256 tokenAmount
    );

    /// @notice Community rewards vault: receives v2 sniper escrows released by BondingCurve.releaseSnipeEscrow
    ///         (not graduated after the timeout), and 70% of any legacy routeSnipeFee call.
    address public rewardsVault;

    /// @notice Routers allowed to claim a creator's quote fees on the creator's behalf (claimCreatorFeesFor). Kept
    ///         separate from Launchpad.isTrustedRouter: trusting a router for trades must not also hand it every
    ///         creator's accrued fees. Owner-set; today only DiscipleRouter (claimCreatorFeesToUsdg).
    mapping(address => bool) public isClaimRouter;

    event ClaimRouterSet(address indexed router, bool allowed);
    event FeeSettingsLocked();

    constructor(address owner_, address treasury_, address referrals_) Owned2Step(owner_) {
        if (owner_ == address(0) || treasury_ == address(0) || referrals_ == address(0)) {
            revert ZeroAddress();
        }
        treasury = treasury_;
        referrals = IReferralRegistry(referrals_);
    }

    /// @dev Audit FR-01 / LB-03: one-shot, like `Migration.setLaunchpad`. CurveFeeVault authenticates curves and
    ///      finds creators through this pointer, so repointing it would make every live curve of the old Launchpad
    ///      unable to settle fees or graduate, and strand their curve-phase fees. A new Launchpad needs a new stack
    ///      anyway (Migration's launchpad is already one-shot).
    function setLaunchpad(address launchpad_) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (launchpad != address(0)) revert LaunchpadAlreadySet();
        if (launchpad_ == address(0)) revert ZeroAddress();
        if (launchpad_.code.length == 0) revert NotAContract(); // F-L11: one-shot, so refuse an EOA / typo
        launchpad = launchpad_;
    }

    /// @notice Write-once (maker 2026-11-17): the 33% LP share can never be pointed elsewhere.
    function setLockedLP(address lockedLP_) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (address(lockedLP) != address(0)) revert AlreadyWired();
        if (lockedLP_.code.length == 0) revert NotAContract();
        lockedLP = ILockedLP(lockedLP_);
    }

    /// @dev Audit r127 Low (FeeRouter.sol:193): routeTradeFee reads `referralSink == treasury` at trade time. A sink
    ///      set to "the treasury" follows a treasury change, so the old treasury never starts accruing the 1% as a
    ///      referrer (and the owner's "send it to treasury" choice isn't silently dropped back to referrers).
    function setTreasury(address treasury_) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (treasury_ == address(0)) revert ZeroAddress();
        address old = treasury;
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
        if (old != treasury_ && referralSink == old) {
            emit ReferralSinkSet(old, treasury_);
            referralSink = treasury_;
        }
    }

    function setReferralSink(address sink) external {
        _onlyOwnerUnlocked();
        emit ReferralSinkSet(referralSink, sink);
        referralSink = sink;
    }

    /// @notice Set the launch KOL's cut of the creator share (bps of that share, 0–500). Future trades only.
    function setKolCreatorShareBps(uint256 bps) external {
        _onlyOwnerUnlocked();
        if (bps > MAX_KOL_CREATOR_SHARE_BPS) revert KolShareTooHigh();
        emit KolCreatorShareSet(kolCreatorShareBps, bps);
        kolCreatorShareBps = uint16(bps);
    }

    /// @notice Allow / revoke a router for claimCreatorFeesFor (owner only).
    function setClaimRouter(address router, bool allowed) external {
        _onlyOwnerUnlocked();
        if (router == address(0)) revert ZeroAddress();
        isClaimRouter[router] = allowed;
        emit ClaimRouterSet(router, allowed);
    }

    /// @notice Freeze the KOL share, referral sink and claim routers forever (Deploy calls it on mainnet).
    function lockSettings() external {
        _onlyOwnerUnlocked();
        settingsLocked = true;
        emit FeeSettingsLocked();
    }

    function _onlyOwnerUnlocked() internal view {
        if (msg.sender != owner) revert OnlyOwner();
        if (settingsLocked) revert SettingsLocked();
    }

    /// @notice Launchpad only (it authorizes each curve as it launches). maker 2026-11-19: the hook no longer calls
    ///         FeeRouter, so the owner's one-time grant is gone and no key can ever add a caller that books fee credit.
    function setAuthorized(address caller, bool ok) external {
        if (msg.sender != launchpad) revert OnlyOwner();
        authorizedCallers[caller] = ok;
    }

    /// @inheritdoc IFeeRouter
    /// @dev Resolves current creator via Launchpad.creatorOf (ownership pack §5/#26).
    ///      Accruals booked to a prior creator are claimable only by the current one (sweepPastCreatorFees_1311).
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

        // Referral sink (maker 2026-11-19: the community rewards Safe on mainnet): when set, it takes the WHOLE 1% of
        // every trade, referred or not, same as the post-graduation hook. A sink equal to the treasury = treasury.
        {
            address sink = referralSink;
            if (sink != address(0)) leftoverTo = sink == treasury ? address(0) : sink;
        }

        if (leftoverTo == address(0) || referralShare == 0) {
            treasuryShare += referralShare;
            referralShare = 0;
            leftoverTo = address(0);
        }

        // kolCreatorShareBps (default 2%) of creator's 33% share → launch KOL (LOCKED #21; owner-settable 0–5%)
        uint256 kolFromCreator;
        if (launchKol != address(0) && creatorShare > 0) {
            kolFromCreator = (creatorShare * kolCreatorShareBps) / Constants.BPS_DENOM;
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
    /// @dev LEGACY (LOCKED #9 rev. 2026-10-15, superseded by mode rules v2): splits a snipe fee 70% → RewardsVault,
    ///      30% (incl. rounding remainder) → treasury; 100% → treasury if no vault is set. Mode-rules-v2 curves never
    ///      call this: their sniper tax stays in BondingCurve.snipeEscrow and goes to LockedLP's compound bucket at
    ///      graduation (not the floor), or to RewardsVault via releaseSnipeEscrow after the timeout.
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

    /// @notice Owner sets the community rewards vault (target of releaseSnipeEscrow; 70% of a legacy routeSnipeFee).
    function setRewardsVault(address vault) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (vault.code.length == 0) revert NotAContract(); // audit L-10: never unset or an EOA
        rewardsVault = vault;
        emit RewardsVaultUpdated(vault);
    }

    /// @inheritdoc IFeeRouter
    function claimCreatorFees(address token) external override returns (uint256 amount) {
        // maker 2026-11-19: anyone may claim (gasless coin creators hold no ETH); the money only ever goes to the
        // current coin creator's Pays to wallet. A past creator's balance moves over with sweepPastCreatorFees_1311.
        _revertIfSelfClaimRouted(token);
        address c = _claimant(token);
        amount = creatorAccrued[token][c];
        if (amount == 0) revert NothingToClaim();
        creatorAccrued[token][c] = 0;
        IERC20(_quoteOf(token)).safeTransfer(_payeeOf(token, c), amount);
        emit CreatorFeesClaimed(token, c, amount);
    }

    /// @notice Claim-router claim on behalf of `creator` (DiscipleRouter.claimCreatorFeesToUsdg): pays the quote
    ///         side of `creator`'s accrued fees to the ROUTER, which swaps it to USDG for the creator in the same tx.
    ///         Only isClaimRouter[msg.sender] (owner allowlist, separate from the trade-router trust); the router
    ///         passes its own msg.sender as `creator`.
    function claimCreatorFeesFor(address token, address creator) external returns (uint256 amount) {
        if (!isClaimRouter[msg.sender]) revert OnlyAuthorized();
        _revertIfPullNotHarvest(token);
        if (msg.sender != creatorFeeHarvest) _revertIfNotCurrent(token, creator);
        amount = creatorAccrued[token][creator];
        if (amount == 0) revert NothingToClaim();
        creatorAccrued[token][creator] = 0;
        IERC20(_quoteOf(token)).safeTransfer(msg.sender, amount);
        emit CreatorFeesClaimed(token, creator, amount);
    }

    /// @notice Creator share accrued in the launch token itself (post-graduation buys pay the hook fee in token).
    function claimCreatorTokenFees(address token) external returns (uint256 amount) {
        _revertIfSelfClaimRouted(token);
        address c = _claimant(token);
        amount = creatorTokenAccrued[token][c];
        if (amount == 0) revert NothingToClaim();
        creatorTokenAccrued[token][c] = 0;
        IERC20(token).safeTransfer(_payeeOf(token, c), amount);
        emit CreatorTokenFeesClaimed(token, c, amount);
    }

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
        return _claimReferrer(msg.sender, quote);
    }

    /// @notice Anyone pays `referrer` its own `quote` balance (gasless referrers hold no ETH). The caller gets nothing.
    ///         The `_2143` suffix keeps this selector after every function that already existed.
    function claimReferrerFeesFor_2143(address referrer, address quote) external returns (uint256) {
        return _claimReferrer(referrer, quote);
    }

    function _claimReferrer(address referrer, address quote) internal returns (uint256 amount) {
        amount = referrerAccrued[referrer][quote];
        if (amount == 0) revert NothingToClaim();
        referrerAccrued[referrer][quote] = 0;
        IERC20(quote).safeTransfer(referrer, amount);
        emit ReferrerFeesClaimed(quote, referrer, amount);
    }

    /// @dev Launchpad registers token→quote; overridden in full wiring.
    mapping(address => address) public tokenQuote;
    /// @dev Referrer of the launching wallet at launch (KOL on creates — LOCKED #21). Immutable per token.
    mapping(address => address) public tokenLaunchKol;
    /// @notice Later-send contract. Trades never read this. Address 0 keeps today's self-claim.
    ///         Destination 1 or 2 (read from this contract) cannot be self-claimed.
    ///         Not `public`: the auto-getter selector sorts before `routeTradeFee` and would add gas to every trade.
    address internal creatorFeeHarvest;

    /// @dev Audit FR-02: write-once. Re-registering a live token's quote would pay creators in the wrong asset
    ///      and leave this contract insolvent against the accruals already booked in the old quote.
    /// @dev External review N-1: Launchpad only. An owner call on the next CREATE address used to block every launch.
    function registerTokenQuote(address token, address quote) external {
        if (msg.sender != launchpad) revert OnlyOwner();
        if (tokenQuote[token] != address(0)) revert QuoteAlreadySet();
        tokenQuote[token] = quote;
    }

    /// @notice Launchpad registers quote + freezes creator's referrer as KOL-on-creates (LOCKED #21).
    /// @dev Audit FR-02: Launchpad only and write-once, so neither the quote nor the launch KOL can be repointed.
    function registerTokenLaunch(address token, address quote, address launchingCreator) external {
        if (msg.sender != launchpad) revert OnlyOwner();
        if (tokenQuote[token] != address(0)) revert QuoteAlreadySet();
        tokenQuote[token] = quote;
        address kol = referrals.referrerOf(launchingCreator);
        if (kol != address(0)) tokenLaunchKol[token] = kol;
    }

    /// @notice Claim-router pull of rocket-token fees, mirroring `claimCreatorFeesFor`.
    ///         The `_15` suffix keeps this selector after every function that already existed, so a trade does not
    ///         walk an extra dispatcher comparison. Destination 1 or 2 may be pulled only by `creatorFeeHarvest`.
    function claimCreatorTokenFeesFor_15(address token, address creator) external returns (uint256 amount) {
        if (!isClaimRouter[msg.sender]) revert OnlyAuthorized();
        _revertIfPullNotHarvest(token);
        if (msg.sender != creatorFeeHarvest) _revertIfNotCurrent(token, creator);
        amount = creatorTokenAccrued[token][creator];
        if (amount == 0) revert NothingToClaim();
        creatorTokenAccrued[token][creator] = 0;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit CreatorTokenFeesClaimed(token, creator, amount);
    }

    /// @notice Owner sets the later-send contract self-claims read, once (maker 2026-11-17: write-once, so the creator
    ///         fees of lock/burn coins can never be redirected).
    ///         The `_51` suffix keeps this selector after every function that already existed, so a trade does not
    ///         walk an extra dispatcher comparison.
    function setCreatorFeeHarvest_51(address harvest) external {
        if (msg.sender != owner) revert OnlyOwner();
        // Audit FR-02: self-claims call into this address; an EOA would brick every creator self-claim.
        if (creatorFeeHarvest != address(0)) revert AlreadyWired();
        if (harvest.code.length == 0) revert NotAContract();
        creatorFeeHarvest = harvest;
    }

    /// @notice The later-send contract, if the owner has set one. The `_16` suffix keeps this selector last.
    function creatorFeeHarvest_16() external view returns (address) {
        return creatorFeeHarvest;
    }

    /// @notice maker 2026-11-19 "the new creator gets the fees": moves what is still booked to a past creator of
    ///         `token` (quote and rocket token) onto the current creator. Anyone may call it; nothing is paid out.
    ///         The `_1311` suffix keeps this selector after every function that already existed.
    function sweepPastCreatorFees_1311(address token, address past) external returns (uint256 q, uint256 t) {
        address current = _currentCreator(token);
        if (current == address(0) || past == current) revert NotCurrentCreator();
        q = creatorAccrued[token][past];
        t = creatorTokenAccrued[token][past];
        if (q + t == 0) revert NothingToClaim();
        if (q != 0) {
            creatorAccrued[token][past] = 0;
            creatorAccrued[token][current] += q;
        }
        if (t != 0) {
            creatorTokenAccrued[token][past] = 0;
            creatorTokenAccrued[token][current] += t;
        }
        emit PastCreatorFeesSwept(token, past, current, q, t);
    }

    /// @dev Whose balance a creator claim pays: the coin's current creator, or msg.sender without a launchpad.
    ///      A contract creator (AnonLauncher, a Safe) pulls its own fees: only a plain wallet is paid by others.
    function _claimant(address token) internal view returns (address c) {
        c = _currentCreator(token);
        if (c == address(0)) c = msg.sender;
        if (c != msg.sender && c.code.length != 0) revert NotCurrentCreator();
    }

    function _currentCreator(address token) internal view returns (address) {
        address lp = launchpad;
        return lp == address(0) ? address(0) : ILaunchpad(lp).creatorOf(token);
    }

    /// @dev Unset launchpad (or an unregistered coin) keeps the old msg.sender-keyed claim.
    function _revertIfNotCurrent(address token, address who) internal view {
        address current = _currentCreator(token);
        if (current != address(0) && who != current) revert NotCurrentCreator();
    }

    function _quoteOf(address token) internal view returns (address) {
        address q = tokenQuote[token];
        require(q != address(0), "FeeRouter: no quote");
        return q;
    }

    /// @dev Same gate as AnonLauncher.CreatorFeesRouted. Unset harvest, or destination 0, keeps today's claim.
    function _revertIfSelfClaimRouted(address token) internal view {
        if (_destination(token) > 0) revert CreatorFeesRouted();
    }

    /// @dev Destination 1 or 2 quote and rocket-token pulls belong to the later-send contract only.
    function _revertIfPullNotHarvest(address token) internal view {
        if (_destination(token) > 0 && msg.sender != creatorFeeHarvest) revert CreatorFeesRouted();
    }

    /// @dev Pays to: the creator's pick on the later-send contract (CreatorFeeHarvest.setCreatorFeeRecipient).
    function _payeeOf(address token, address creator) internal view returns (address) {
        address harvest = creatorFeeHarvest;
        if (harvest == address(0)) return creator;
        return ICreatorFeeDestination(harvest).creatorFeeRecipientOf(token, creator);
    }

    function _destination(address token) internal view returns (uint8) {
        address harvest = creatorFeeHarvest;
        if (harvest == address(0)) return 0;
        return ICreatorFeeDestination(harvest).creatorFeeDestinationOf(token);
    }
}

interface ICreatorFeeDestination {
    function creatorFeeDestinationOf(address token) external view returns (uint8);
    function creatorFeeRecipientOf(address token, address creator) external view returns (address);
}
