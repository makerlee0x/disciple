// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {FeeMath} from "./libraries/FeeMath.sol";
import {Constants} from "./libraries/Constants.sol";

interface IFeeRouterConfig {
    function launchpad() external view returns (address);
    function treasury() external view returns (address);
    function referrals() external view returns (address);
    function referralSink() external view returns (address);
    function kolCreatorShareBps() external view returns (uint16);
    function tokenLaunchKol(address token) external view returns (address);
    function isClaimRouter(address router) external view returns (bool);
}

/// @dev AnonLauncher (src/addons/AnonLauncher.sol): token => stealth owner registry (the launcher is the Launchpad
///      creatorOf of every coin it launches).
interface IAnonStealthOwner {
    function stealthOwnerOf(address token) external view returns (address);
}

interface ILaunchpadView {
    function curveOf(address token) external view returns (address);
    function creatorOf(address token) external view returns (address);
}

interface IReferrals {
    function referrerOf(address wallet) external view returns (address);
}

interface ISettleCurve {
    function settleFees() external returns (uint256 protoFee, uint256 creatorTax);
    function quote() external view returns (address);
    function protoFeesOwed() external view returns (uint112);
    function creatorTaxOwed() external view returns (uint112);
}

/// @title CurveFeeVault — curve-phase creator / treasury / referral fees of lp-accrue curves (lee 2026-11-09)
/// @notice Pattern: Uniswap v3 accrue-then-collect (Position.tokensOwed0/1 grow per swap; collect() pays out). An
///         lp-accrue BondingCurve keeps its 1% fee owed in one packed slot and keeps the 33% LP share itself (with the
///         sniper tax: → LockedLP compound bucket at graduation, → RewardsVault if not graduated within the curve's
///         snipeEscrowTimeout). On settle it sends THIS vault the other 67% (+ creator tax) and calls settleCurveFee(), which
///         applies exactly FeeRouter._route's split minus the LP push: creator 33% (minus the launch KOL's
///         kolCreatorShareBps cut) + creator tax; treasury 33%; the 1% to the launch KOL / referral sink / trader's
///         referrer, else treasury. Every input (creatorOf, KOL, sink, KOL bps, treasury) is read live from the deployed
///         FeeRouter / Launchpad, so the rules stay owner-governed in one place.
/// @dev Why a new contract: the deployed FeeRouter (immutable in Launchpad) always pushes 33% to LockedLP inside
///      _route, so it cannot credit creator / treasury / referral without also moving the LP share. FeeRouter,
///      LockedLP, Migration and existing curves are unchanged. Claims settle the coin's owed fees FIRST, then pay.
/// @dev Private launches (AUDIT H1, lee 2026-11-09 "Yes, FLOW fixes the anon-creator claim"): for a coin launched by
///      `anonLauncher` the Launchpad creator (and so the creatorAccrued key) is the AnonLauncher itself, which only
///      claims from FeeRouter. The coin's stealth owner (AnonLauncher.stealthOwnerOf, the same registry AnonLauncher
///      gates its own claims on) claims that balance here: directly (claimCreatorFeesAsStealth) or gaslessly by an
///      EIP-712 signature with AnonLauncher's exact Claim struct (claimManyAsStealthBySig, same relayer-fee cap).
///      Fee claim only: no login, launch or trade path.
contract CurveFeeVault is EIP712 {
    using SafeERC20 for IERC20;

    IFeeRouterConfig public immutable feeRouter;
    /// @notice The AnonLauncher whose coins' stealth owners may claim creator fees here (address(0) = none).
    address public immutable anonLauncher;

    /// @notice Same struct string as AnonLauncher.CLAIM_TYPEHASH (domain "DISCIPLE CurveFeeVault" "1" binds this vault).
    bytes32 internal constant CLAIM_TYPEHASH = keccak256(
        "Claim(address owner,address[] tokens,address to,uint256 relayerFeeBps,uint256 nonce,uint256 deadline)"
    );
    /// @notice Same cap as AnonLauncher.MAX_RELAYER_FEE_BPS (5%).
    uint256 internal constant MAX_RELAYER_FEE_BPS = 500;

    /// @notice Stealth owner => next by-sig claim nonce (this vault's own; AnonLauncher.nonces are separate).
    /// @dev settleCurveFee() (selector 0x038b09d3) runs inside referred trades; it is named so its selector sorts
    ///      first in the dispatcher (selectors are checked in order), so the claim functions added for H1/M1 cost
    ///      the trade path nothing.
    mapping(address => uint256) public sigNonces;

    /// @notice Same fields as AnonLauncher.ClaimReq.
    struct ClaimReq {
        address owner;
        address[] tokens;
        address to;
        uint256 relayerFeeBps;
        uint256 deadline;
        bytes sig;
    }

    /// token => creator => accrued quote (curve phase). Mirrors FeeRouter.creatorAccrued.
    mapping(address => mapping(address => uint256)) public creatorAccrued;
    /// referrer => quote => accrued. Mirrors FeeRouter.referrerAccrued.
    mapping(address => mapping(address => uint256)) public referrerAccrued;
    /// quote => treasury accrued (pushed to FeeRouter.treasury() by claimTreasury). Mirrors FeeRouter.treasuryAccrued.
    mapping(address => uint256) public treasuryAccrued;

    error OnlyCurve();
    error NothingToClaim();
    error NotStealthOwner();
    error OnlyClaimRouter();
    error ZeroAddress();
    error FeeTooHigh();
    error Expired();
    error BadSignature();

    /// @notice Same fields as FeeRouter.TradeFeeRouted (lpShare = the share the curve kept; trader 0 = batch settle).
    event CurveFeeSettled(
        address indexed token,
        address indexed quote,
        address indexed trader,
        address creator,
        uint256 creatorShare,
        uint256 creatorTaxAmount,
        uint256 lpShareKept,
        uint256 treasuryShare,
        address referralPayee,
        uint256 referralShare,
        address kolPayee,
        uint256 kolShare
    );
    event CreatorFeesClaimed(address indexed token, address indexed creator, uint256 amount);
    event ReferrerFeesClaimed(address indexed quote, address indexed referrer, uint256 amount);
    event TreasuryFeesClaimed(address indexed asset, address indexed treasury, uint256 amount);
    /// @notice A private coin's creator fees (creatorAccrued[token][anonLauncher]) paid on its stealth owner's claim.
    ///         `amount` is what `to` received (after the relayer fee, by-sig only), as AnonLauncher.Claimed.
    event StealthCreatorFeesClaimed(
        address indexed token, address indexed stealthOwner, address to, address asset, uint256 amount
    );

    constructor(address feeRouter_, address anonLauncher_) EIP712("DISCIPLE CurveFeeVault", "1") {
        feeRouter = IFeeRouterConfig(feeRouter_);
        anonLauncher = anonLauncher_;
    }

    /// @notice Called by the coin's registered curve right after it transferred
    ///         `protoFee - lpShare + creatorTax` of `quote` here (lpShare = FeeMath split LP part, kept by the curve).
    function settleCurveFee(address token, address quote, address trader, uint256 protoFee, uint256 creatorTax) external {
        IFeeRouterConfig fr = feeRouter;
        ILaunchpadView lp = ILaunchpadView(fr.launchpad());
        if (msg.sender != lp.curveOf(token)) revert OnlyCurve();

        address creator = lp.creatorOf(token);
        (uint256 creatorShare, uint256 lpShare, uint256 treasuryShare, uint256 referralShare) =
            FeeMath.splitTradeFee(protoFee);

        // 1% destination: identical to FeeRouter._route (launch KOL, else trader's referrer; sink redirect)
        address launchKol = fr.tokenLaunchKol(token);
        address leftoverTo = launchKol;
        if (leftoverTo == address(0) && trader != address(0)) {
            leftoverTo = IReferrals(fr.referrals()).referrerOf(trader);
        }
        if (leftoverTo != address(0)) {
            address sink = fr.referralSink();
            if (sink != address(0)) leftoverTo = sink == fr.treasury() ? address(0) : sink;
        }
        if (leftoverTo == address(0) || referralShare == 0) {
            treasuryShare += referralShare;
            referralShare = 0;
            leftoverTo = address(0);
        }
        uint256 kolFromCreator;
        if (launchKol != address(0) && creatorShare > 0) {
            kolFromCreator = (creatorShare * fr.kolCreatorShareBps()) / Constants.BPS_DENOM;
            creatorShare -= kolFromCreator;
        }

        if (creatorShare + creatorTax != 0) creatorAccrued[token][creator] += creatorShare + creatorTax;
        if (referralShare != 0) referrerAccrued[leftoverTo][quote] += referralShare;
        if (kolFromCreator != 0) referrerAccrued[launchKol][quote] += kolFromCreator;
        if (treasuryShare != 0) treasuryAccrued[quote] += treasuryShare;

        emit CurveFeeSettled(
            token,
            quote,
            trader,
            creator,
            creatorShare,
            creatorTax,
            lpShare,
            treasuryShare,
            leftoverTo,
            referralShare,
            kolFromCreator > 0 ? launchKol : address(0),
            kolFromCreator
        );
    }

    function _settle(address token) internal returns (address c) {
        c = ILaunchpadView(feeRouter.launchpad()).curveOf(token);
        // "collect": owed → accrued first. try: a pre-lp-accrue curve has no settleFees (and nothing here).
        if (c != address(0)) try ISettleCurve(c).settleFees() {} catch {}
    }

    function _settleAll(address[] calldata tokens) internal {
        for (uint256 i; i < tokens.length; ++i) {
            _settle(tokens[i]);
        }
    }

    /// @notice Creator claim: settles the coin's owed fees first, then pays msg.sender's accrued share.
    function claimCreatorFees(address token) external returns (uint256 amount) {
        address c = _settle(token);
        if (c == address(0)) revert NothingToClaim();
        address quote = ISettleCurve(c).quote(); // never caller-supplied
        amount = creatorAccrued[token][msg.sender];
        if (amount == 0) revert NothingToClaim();
        creatorAccrued[token][msg.sender] = 0;
        IERC20(quote).safeTransfer(msg.sender, amount);
        emit CreatorFeesClaimed(token, msg.sender, amount);
    }

    /// @notice Referrer / KOL claim in `quote`: settles the listed coins first (KOL coins accrue the 1% there).
    function claimReferrerFees(address quote, address[] calldata settleTokens) external returns (uint256 amount) {
        _settleAll(settleTokens);
        amount = referrerAccrued[msg.sender][quote];
        if (amount == 0) revert NothingToClaim();
        referrerAccrued[msg.sender][quote] = 0;
        IERC20(quote).safeTransfer(msg.sender, amount);
        emit ReferrerFeesClaimed(quote, msg.sender, amount);
    }

    /// @notice Permissionless: settle the listed coins, then push the treasury balance of `quote` to FeeRouter.treasury().
    function claimTreasury(address quote, address[] calldata settleTokens) external returns (uint256 amount) {
        _settleAll(settleTokens);
        amount = treasuryAccrued[quote];
        if (amount == 0) revert NothingToClaim();
        treasuryAccrued[quote] = 0;
        address t = feeRouter.treasury();
        IERC20(quote).safeTransfer(t, amount);
        emit TreasuryFeesClaimed(quote, t, amount);
    }

    // ── claim router (DiscipleRouter.claimCreatorFeesToUsdg) ──

    /// @notice FeeRouter.claimCreatorFeesFor counterpart (same rules, pays the router): settles `token`, then pays `creator`'s accrued quote to the
    ///         calling router, which swaps it to USDG for the creator in the same tx. Only FeeRouter.isClaimRouter
    ///         (the same owner allowlist FeeRouter uses). Returns 0 (no revert) when nothing is owed, so the router can
    ///         fall back to / combine with the FeeRouter balance.
    function claimCreatorFeesToRouter(address token, address creator) external returns (uint256 amount) {
        if (!feeRouter.isClaimRouter(msg.sender)) revert OnlyClaimRouter();
        address c = _settle(token);
        if (c == address(0)) return 0;
        amount = creatorAccrued[token][creator];
        if (amount == 0) return 0;
        creatorAccrued[token][creator] = 0;
        IERC20(ISettleCurve(c).quote()).safeTransfer(msg.sender, amount);
        emit CreatorFeesClaimed(token, creator, amount);
    }

    // ── private launches (AnonLauncher stealth owner) ──

    /// @notice Stealth owner of an `anonLauncher` coin claims its creator fees to `to` (msg.sender pays gas).
    function claimCreatorFeesAsStealth(address token, address to) external returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        _checkStealthOwner(token, msg.sender);
        address quote;
        (quote, amount) = _takeAnon(token);
        if (amount == 0) revert NothingToClaim();
        IERC20(quote).safeTransfer(to, amount);
        emit StealthCreatorFeesClaimed(token, msg.sender, to, quote, amount);
    }

    /// @notice Gasless: anyone submits the stealth owner's EIP-712 Claim (AnonLauncher's struct, this vault's domain
    ///         and nonces). Same rules as AnonLauncher.claimManyBySig: every token must be the signer's, a token with
    ///         nothing to claim reverts NothingToClaim, an empty list only burns the nonce, relayer fee <= 5% to
    ///         msg.sender.
    function claimManyAsStealthBySig(ClaimReq calldata c) external {
        if (c.to == address(0)) revert ZeroAddress();
        if (c.relayerFeeBps > MAX_RELAYER_FEE_BPS) revert FeeTooHigh();
        if (block.timestamp > c.deadline) revert Expired();
        bytes32 d = _claimDigest(c.owner, c.tokens, c.to, c.relayerFeeBps, sigNonces[c.owner], c.deadline);
        if (!SignatureChecker.isValidSignatureNow(c.owner, d, c.sig)) revert BadSignature();
        unchecked {
            ++sigNonces[c.owner];
        }
        for (uint256 i; i < c.tokens.length; ++i) {
            address token = c.tokens[i];
            _checkStealthOwner(token, c.owner);
            (address quote, uint256 amount) = _takeAnon(token);
            if (amount == 0) revert NothingToClaim();
            uint256 rf = (amount * c.relayerFeeBps) / Constants.BPS_DENOM;
            if (rf != 0) IERC20(quote).safeTransfer(msg.sender, rf);
            IERC20(quote).safeTransfer(c.to, amount - rf);
            emit StealthCreatorFeesClaimed(token, c.owner, c.to, quote, amount - rf);
        }
    }

    /// @dev EIP-712 digest of AnonLauncher's Claim struct under this vault's domain (eip712Domain()).
    function _claimDigest(
        address owner_,
        address[] calldata tokens,
        address to,
        uint256 relayerFeeBps,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    CLAIM_TYPEHASH, owner_, keccak256(abi.encodePacked(tokens)), to, relayerFeeBps, nonce, deadline
                )
            )
        );
    }

    function _checkStealthOwner(address token, address who) internal view {
        address al = anonLauncher;
        if (
            al == address(0) || who == address(0) || ILaunchpadView(feeRouter.launchpad()).creatorOf(token) != al
                || IAnonStealthOwner(al).stealthOwnerOf(token) != who
        ) revert NotStealthOwner();
    }

    /// @dev Settle `token`, then zero and return the AnonLauncher's creator balance (CreatorFeesClaimed keeps the
    ///      creator = AnonLauncher, as the vault booked it).
    function _takeAnon(address token) internal returns (address quote, uint256 amount) {
        address c = _settle(token);
        if (c == address(0)) return (address(0), 0);
        quote = ISettleCurve(c).quote();
        address al = anonLauncher;
        amount = creatorAccrued[token][al];
        if (amount == 0) return (quote, 0);
        creatorAccrued[token][al] = 0;
        emit CreatorFeesClaimed(token, al, amount);
    }

    // ── readers ──

    /// @notice What `creator` could claim for `token` right now: accrued here + their share of the curve's unsettled
    ///         owed fees (the same split settleCurveFee() applies, on the same aggregate, so it is exact). 0 for old curves.
    ///         A private coin: pass creator = anonLauncher.
    function creatorClaimable(address token, address creator) external view returns (uint256 amount) {
        amount = creatorAccrued[token][creator];
        IFeeRouterConfig fr = feeRouter;
        ILaunchpadView lp = ILaunchpadView(fr.launchpad());
        address c = lp.curveOf(token);
        if (c == address(0) || lp.creatorOf(token) != creator) return amount;
        uint256 owed;
        uint256 tax;
        try ISettleCurve(c).protoFeesOwed() returns (uint112 o) {
            owed = o;
        } catch {
            return amount;
        }
        try ISettleCurve(c).creatorTaxOwed() returns (uint112 t) {
            tax = t;
        } catch {}
        (uint256 cs,,,) = FeeMath.splitTradeFee(owed);
        if (cs != 0 && fr.tokenLaunchKol(token) != address(0)) {
            cs -= (cs * fr.kolCreatorShareBps()) / Constants.BPS_DENOM;
        }
        amount += cs + tax;
    }
}
