// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Constants} from "./libraries/Constants.sol";
import {FeeMath} from "./libraries/FeeMath.sol";
import {CurveMath} from "./libraries/CurveMath.sol";
import {IBondingCurve} from "./interfaces/IBondingCurve.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";
import {IAntiSnipe} from "./interfaces/IAntiSnipe.sol";
import {IMigration} from "./interfaces/IMigration.sol";
import {ITradeEvents} from "./interfaces/ITradeEvents.sol";
import {SqrtPrice} from "./libraries/SqrtPrice.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title External bonding curve — Pump-style CPAMM (§2 / LOCKED #5–#8)
/// @notice Start mcap $7K → Pearly Gates $33K at exactly 72% supply sold; 7% wallet cap.
/// @dev Single constant-product virtual reserves; quotePriceUsd scales USD targets into quote units.
contract BondingCurve is IBondingCurve, ITradeEvents {
    using SafeERC20 for IERC20;

    address public immutable override token;
    address public immutable override quote;
    address public immutable creator;
    address public immutable launchpad;
    IFeeRouter public immutable feeRouter;
    IAntiSnipe public immutable antiSnipe;
    IMigration public immutable migration;

    uint256 public immutable creatorTaxBps; // immutable at launch (§3 / #12)
    uint256 public immutable quotePriceUsd; // USD WAD per 1e18 raw quote units (from QuotePricer at launch)

    CurveMath.Params private _params;

    uint256 public override quoteReserve;
    uint256 public override tokensSold;
    bool public override graduated;

    mapping(address => uint256) public balanceOnCurve; // for wallet cap tracking

    error Graduated();
    error NotGraduated();
    error Expired();
    error Slippage();
    error WalletCap();
    error ZeroAmount();
    error OnlyLaunchpad();
    error ZeroRecipient();

    event GraduatedToV4(address indexed token, bytes32 poolId, uint256 tokenLiq, uint256 quoteLiq);

    struct BuyQuote {
        uint256 tokensOut;
        uint256 fee; // protocol 1% + creator tax (quote raw)
        uint256 snipeFee; // current anti-snipe fee (quote raw)
        uint256 quoteToCurve;
        uint256 priceAfterX18;
        uint256 impactBps;
        uint256 mcapAfterUsd;
        bool graduates;
    }

    struct SellQuote {
        uint256 quoteOut; // net to seller
        uint256 fee;
        uint256 grossQuote;
        uint256 priceAfterX18;
        uint256 impactBps;
        uint256 mcapAfterUsd;
    }

    constructor(
        address token_,
        address quote_,
        address creator_,
        address launchpad_,
        address feeRouter_,
        address antiSnipe_,
        address migration_,
        uint256 creatorTaxBps_,
        uint256 quotePriceUsd_
    ) {
        require(creatorTaxBps_ <= Constants.CREATOR_TAX_MAX_BPS, "tax");
        token = token_;
        quote = quote_;
        creator = creator_;
        launchpad = launchpad_;
        feeRouter = IFeeRouter(feeRouter_);
        antiSnipe = IAntiSnipe(antiSnipe_);
        migration = IMigration(migration_);
        creatorTaxBps = creatorTaxBps_;
        quotePriceUsd = quotePriceUsd_;

        _params = CurveMath.makeParams(quotePriceUsd_);
    }

    // ───────────────────────────── views ─────────────────────────────

    /// @notice Curve geometry (for off-chain / tests).
    function curveParams() external view returns (uint256 totalSupply, uint256 sCurve, uint256 x0, uint256 y0) {
        CurveMath.Params memory p = _params;
        return (p.totalSupply, p.sCurve, p.x0, p.y0);
    }

    /// @inheritdoc IBondingCurve
    function marketCapUsd() public view override returns (uint256) {
        return CurveMath.marketCapUsd(_params, tokensSold);
    }

    /// @notice Alias of marketCapUsd (USD WAD).
    function mcapNow() external view returns (uint256) {
        return CurveMath.marketCapUsd(_params, tokensSold);
    }

    /// @notice Spot price in quote wei * 1e18 / token wei.
    function spotPriceWad() public view returns (uint256) {
        return CurveMath.spotPriceWad(_params, tokensSold);
    }

    /// @notice Alias of spotPriceWad (quote raw * 1e18 / token raw).
    function priceNow() external view returns (uint256) {
        return CurveMath.spotPriceWad(_params, tokensSold);
    }

    /// @notice Progress to graduation in bps (tokensSold / 72% of supply). 10000 = graduated.
    function progressBps() external view returns (uint256) {
        if (graduated) return Constants.BPS_DENOM;
        return (tokensSold * Constants.BPS_DENOM) / _params.sCurve;
    }

    /// @notice Current anti-snipe fee in bps (77.7% → 0 over 7s after launch).
    function currentSnipeFeeBps() external view returns (uint256) {
        return antiSnipe.currentFeeBps(token);
    }

    /// @notice Exact preview of `buy(quoteIn, ...)` at the current block (incl. 1% fee, creator tax, anti-snipe).
    /// @dev Does not check wallet cap. Reverts when graduated.
    function quoteBuy(uint256 quoteIn) public view returns (BuyQuote memory q) {
        return _quoteBuy(quoteIn, false);
    }

    /// @dev `snipeExempt` = Launchpad creator buy (LOCKED #27: creator launch buy pays only the 1% protocol fee).
    function _quoteBuy(uint256 quoteIn, bool snipeExempt) internal view returns (BuyQuote memory q) {
        if (graduated) revert Graduated();
        if (!snipeExempt) (q.snipeFee,) = antiSnipe.applyBuyFee(token, quoteIn);
        uint256 afterSnipe = quoteIn - q.snipeFee;
        uint256 protoFee = FeeMath.protocolFee(afterSnipe);
        uint256 tax = FeeMath.creatorTax(afterSnipe, creatorTaxBps);
        q.fee = protoFee + tax;
        q.quoteToCurve = afterSnipe - q.fee;
        q.tokensOut = CurveMath.tokensOutForQuote(_params, tokensSold, q.quoteToCurve);
        uint256 sAfter = tokensSold + q.tokensOut;
        q.priceAfterX18 = CurveMath.spotPriceWad(_params, sAfter);
        q.impactBps = _impactBps(tokensSold, sAfter);
        q.mcapAfterUsd = CurveMath.marketCapUsd(_params, sAfter);
        q.graduates = sAfter >= _params.sCurve || q.mcapAfterUsd >= Constants.PEARLY_GATES_MCAP_USD;
    }

    /// @notice Exact preview of `sell(tokensIn, ...)` (incl. 1% fee + creator tax).
    function quoteSell(uint256 tokensIn) public view returns (SellQuote memory q) {
        if (graduated) revert Graduated();
        q.grossQuote = CurveMath.quoteOutForTokens(_params, tokensSold, tokensIn);
        q.fee = FeeMath.protocolFee(q.grossQuote) + FeeMath.creatorTax(q.grossQuote, creatorTaxBps);
        q.quoteOut = q.grossQuote - q.fee;
        uint256 sAfter = tokensSold - tokensIn;
        q.priceAfterX18 = CurveMath.spotPriceWad(_params, sAfter);
        q.impactBps = _impactBps(tokensSold, sAfter);
        q.mcapAfterUsd = CurveMath.marketCapUsd(_params, sAfter);
    }

    /// @dev Price ∝ 1/y² on a CPAMM (x = k/y): impact = |y0² - y1²| / y1², full precision.
    function _impactBps(uint256 sBefore, uint256 sAfter) internal view returns (uint256) {
        uint256 yb = _params.y0 - sBefore;
        uint256 ya = _params.y0 - sAfter;
        uint256 b2 = yb * yb;
        uint256 a2 = ya * ya;
        uint256 d = a2 > b2 ? a2 - b2 : b2 - a2;
        // priceBefore ∝ 1/b2 → impact relative to before = d / a2
        return Math.mulDiv(d, Constants.BPS_DENOM, a2);
    }

    // ───────────────────────────── trading ─────────────────────────────

    /// @inheritdoc IBondingCurve
    function buy(uint256 quoteIn, uint256 minTokensOut, uint256 deadline)
        external
        override
        returns (uint256 tokensOut)
    {
        return _buy(msg.sender, msg.sender, quoteIn, minTokensOut, deadline, false);
    }

    /// @notice Buy paying from msg.sender, tokens to `recipient` (wallet cap applies to recipient).
    function buy(uint256 quoteIn, uint256 minTokensOut, uint256 deadline, address recipient)
        external
        returns (uint256 tokensOut)
    {
        if (recipient == address(0)) revert ZeroRecipient();
        return _buy(msg.sender, recipient, quoteIn, minTokensOut, deadline, false);
    }

    /// @notice Single-tx buy with an EIP-2612 permit on the quote token (STRATEGY and USDG support it).
    /// @dev Permit is wrapped in try/catch so a front-run permit does not brick the tx (allowance check follows).
    function buyWithPermit(
        uint256 quoteIn,
        uint256 minTokensOut,
        uint256 deadline,
        address recipient,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 tokensOut) {
        if (recipient == address(0)) revert ZeroRecipient();
        try IERC20Permit(quote).permit(msg.sender, address(this), quoteIn, permitDeadline, v, r, s) {} catch {}
        return _buy(msg.sender, recipient, quoteIn, minTokensOut, deadline, false);
    }

    /// @notice Same-tx creator buy from Launchpad: payer pulls quote, tokens go to `buyer`.
    ///         Exempt from anti-snipe (pays only 1% protocol fee + creator tax, which is 0 to self-net).
    function buyFor(address buyer, uint256 quoteIn, uint256 minTokensOut, uint256 deadline)
        external
        returns (uint256 tokensOut)
    {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        return _buy(msg.sender, buyer, quoteIn, minTokensOut, deadline, true);
    }

    function _buy(
        address payer,
        address recipient,
        uint256 quoteIn,
        uint256 minTokensOut,
        uint256 deadline,
        bool snipeExempt
    ) internal returns (uint256 tokensOut) {
        if (graduated) revert Graduated();
        if (block.timestamp > deadline) revert Expired();
        if (quoteIn == 0) revert ZeroAmount();

        IERC20(quote).safeTransferFrom(payer, address(this), quoteIn);

        uint256 priceBefore = CurveMath.spotPriceWad(_params, tokensSold);
        BuyQuote memory q = _quoteBuy(quoteIn, snipeExempt);
        tokensOut = q.tokensOut;
        if (tokensOut < minTokensOut) revert Slippage();
        if (tokensOut == 0) revert ZeroAmount();

        // 7% wallet cap on curve only (§2 / #8)
        uint256 newBal = balanceOnCurve[recipient] + tokensOut;
        if (newBal > FeeMath.walletCap()) revert WalletCap();
        balanceOnCurve[recipient] = newBal;

        tokensSold += tokensOut;
        quoteReserve += q.quoteToCurve;

        IERC20(token).safeTransfer(recipient, tokensOut);

        if (q.fee > 0) {
            uint256 protoFee = FeeMath.protocolFee(quoteIn - q.snipeFee);
            IERC20(quote).safeTransfer(address(feeRouter), q.fee);
            feeRouter.routeTradeFee(token, quote, recipient, creator, protoFee, q.fee - protoFee);
        }
        if (q.snipeFee > 0) {
            // Anti-snipe portion (above protocol 1%) → 100% LP lock (§2 / LOCKED #9)
            IERC20(quote).safeTransfer(address(feeRouter), q.snipeFee);
            feeRouter.routeSnipeFee(token, quote, q.snipeFee);
        }

        emit Trade(
            token,
            recipient,
            true,
            quoteIn,
            tokensOut,
            q.fee,
            q.snipeFee,
            priceBefore,
            q.priceAfterX18,
            q.impactBps,
            q.mcapAfterUsd
        );

        if (q.graduates) _graduate();
    }

    /// @inheritdoc IBondingCurve
    function sell(uint256 tokensIn, uint256 minQuoteOut, uint256 deadline)
        external
        override
        returns (uint256 quoteOut)
    {
        return _sell(msg.sender, tokensIn, minQuoteOut, deadline);
    }

    /// @notice Sell msg.sender's tokens, net quote to `recipient`.
    function sell(uint256 tokensIn, uint256 minQuoteOut, uint256 deadline, address recipient)
        external
        returns (uint256 quoteOut)
    {
        if (recipient == address(0)) revert ZeroRecipient();
        return _sell(recipient, tokensIn, minQuoteOut, deadline);
    }

    /// @notice Single-tx sell with an EIP-2612 permit on the launch token (all DISCIPLE tokens support it).
    function sellWithPermit(
        uint256 tokensIn,
        uint256 minQuoteOut,
        uint256 deadline,
        address recipient,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 quoteOut) {
        if (recipient == address(0)) revert ZeroRecipient();
        try IERC20Permit(token).permit(msg.sender, address(this), tokensIn, permitDeadline, v, r, s) {} catch {}
        return _sell(recipient, tokensIn, minQuoteOut, deadline);
    }

    function _sell(address recipient, uint256 tokensIn, uint256 minQuoteOut, uint256 deadline)
        internal
        returns (uint256 quoteOut)
    {
        if (graduated) revert Graduated();
        if (block.timestamp > deadline) revert Expired();
        if (tokensIn == 0) revert ZeroAmount();

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);

        uint256 priceBefore = CurveMath.spotPriceWad(_params, tokensSold);
        SellQuote memory q = quoteSell(tokensIn);
        quoteOut = q.quoteOut;
        if (quoteOut < minQuoteOut) revert Slippage();

        if (balanceOnCurve[msg.sender] < tokensIn) {
            balanceOnCurve[msg.sender] = 0;
        } else {
            balanceOnCurve[msg.sender] -= tokensIn;
        }

        tokensSold -= tokensIn;
        quoteReserve -= q.grossQuote;

        if (q.fee > 0) {
            uint256 protoFee = FeeMath.protocolFee(q.grossQuote);
            IERC20(quote).safeTransfer(address(feeRouter), q.fee);
            feeRouter.routeTradeFee(token, quote, msg.sender, creator, protoFee, q.fee - protoFee);
        }

        IERC20(quote).safeTransfer(recipient, quoteOut);
        emit Trade(
            token,
            msg.sender,
            false,
            quoteOut,
            tokensIn,
            q.fee,
            0,
            priceBefore,
            q.priceAfterX18,
            q.impactBps,
            q.mcapAfterUsd
        );
    }

    /// @dev Atomic same-tx migrate to locked v4 at curve-end price — no pause/gap (§2 / LOCKED #5).
    function _graduate() internal {
        if (graduated) return;
        graduated = true;

        uint256 tokenLiq = IERC20(token).balanceOf(address(this));
        uint256 quoteLiq = quoteReserve;
        uint256 y = _params.y0 - tokensSold;
        uint256 x = CurveMath.virtualQuote(_params, tokensSold);
        uint160 sqrtPriceX96 = SqrtPrice.fromReserves(x, y, uint160(token) < uint160(quote));

        IERC20(token).forceApprove(address(migration), tokenLiq);
        IERC20(quote).forceApprove(address(migration), quoteLiq);

        bytes32 poolId = migration.migrate(token, quote, tokenLiq, quoteLiq, sqrtPriceX96);
        quoteReserve = 0;

        emit GraduatedToV4(token, poolId, tokenLiq, quoteLiq);
    }
}
