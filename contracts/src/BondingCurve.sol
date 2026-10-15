// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Constants} from "./libraries/Constants.sol";
import {FeeMath} from "./libraries/FeeMath.sol";
import {CurveMath} from "./libraries/CurveMath.sol";
import {IBondingCurve} from "./interfaces/IBondingCurve.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";
import {IAntiSnipe} from "./interfaces/IAntiSnipe.sol";
import {IMigration} from "./interfaces/IMigration.sol";

/// @title External bonding curve — Pump-style CPAMM (§2 / LOCKED #5–#8)
/// @notice Start mcap $7K → Pearly Gates $33K at exactly 72% supply sold; 7% wallet cap.
/// @dev Single constant-product virtual reserves; quotePriceUsd scales USD targets into quote units.
contract BondingCurve is IBondingCurve {
    using SafeERC20 for IERC20;

    address public immutable override token;
    address public immutable override quote;
    address public immutable creator;
    address public immutable launchpad;
    IFeeRouter public immutable feeRouter;
    IAntiSnipe public immutable antiSnipe;
    IMigration public immutable migration;

    uint256 public immutable creatorTaxBps; // immutable at launch (§3 / #12)
    uint256 public immutable quotePriceUsd; // USD WAD per 1 full quote token

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

    event Buy(address indexed buyer, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 snipeFee);
    event Sell(address indexed seller, uint256 tokensIn, uint256 quoteOut, uint256 fee);
    event GraduatedToV4(address indexed token, bytes32 poolId, uint256 tokenLiq, uint256 quoteLiq);

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

    /// @notice Curve geometry (for off-chain / tests).
    function curveParams() external view returns (uint256 totalSupply, uint256 sCurve, uint256 x0, uint256 y0) {
        CurveMath.Params memory p = _params;
        return (p.totalSupply, p.sCurve, p.x0, p.y0);
    }

    /// @inheritdoc IBondingCurve
    function marketCapUsd() public view override returns (uint256) {
        return CurveMath.marketCapUsd(_params, tokensSold);
    }

    /// @notice Spot price in quote wei * 1e18 / token wei.
    function spotPriceWad() external view returns (uint256) {
        return CurveMath.spotPriceWad(_params, tokensSold);
    }

    /// @inheritdoc IBondingCurve
    function buy(uint256 quoteIn, uint256 minTokensOut, uint256 deadline)
        external
        override
        returns (uint256 tokensOut)
    {
        return _buy(msg.sender, msg.sender, quoteIn, minTokensOut, deadline);
    }

    /// @notice Same-tx creator buy from Launchpad: payer pulls quote, tokens go to `buyer`.
    function buyFor(address buyer, uint256 quoteIn, uint256 minTokensOut, uint256 deadline)
        external
        returns (uint256 tokensOut)
    {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        return _buy(msg.sender, buyer, quoteIn, minTokensOut, deadline);
    }

    function _buy(address payer, address recipient, uint256 quoteIn, uint256 minTokensOut, uint256 deadline)
        internal
        returns (uint256 tokensOut)
    {
        if (graduated) revert Graduated();
        if (block.timestamp > deadline) revert Expired();
        if (quoteIn == 0) revert ZeroAmount();

        IERC20(quote).safeTransferFrom(payer, address(this), quoteIn);

        // Anti-snipe fee (buy-side); 100% of snipe fee → LP lock (§2 / #9)
        (uint256 snipeFee,) = antiSnipe.applyBuyFee(token, quoteIn);
        uint256 afterSnipe = quoteIn - snipeFee;

        // Protocol 1% + optional creator tax on remaining notional
        uint256 protoFee = FeeMath.protocolFee(afterSnipe);
        uint256 tax = FeeMath.creatorTax(afterSnipe, creatorTaxBps);
        uint256 quoteForCurve = afterSnipe - protoFee - tax;

        tokensOut = CurveMath.tokensOutForQuote(_params, tokensSold, quoteForCurve);
        if (tokensOut < minTokensOut) revert Slippage();
        if (tokensOut == 0) revert ZeroAmount();

        // 7% wallet cap on curve only (§2 / #8)
        uint256 newBal = balanceOnCurve[recipient] + tokensOut;
        if (newBal > FeeMath.walletCap()) revert WalletCap();
        balanceOnCurve[recipient] = newBal;

        tokensSold += tokensOut;
        quoteReserve += quoteForCurve;

        IERC20(token).safeTransfer(recipient, tokensOut);

        if (protoFee + tax > 0) {
            IERC20(quote).safeTransfer(address(feeRouter), protoFee + tax);
            feeRouter.routeTradeFee(token, quote, recipient, creator, protoFee, tax);
        }
        if (snipeFee > 0) {
            // Anti-snipe portion (above protocol 1%) → 100% LP lock (§2 / LOCKED #9)
            IERC20(quote).safeTransfer(address(feeRouter), snipeFee);
            feeRouter.routeSnipeFee(token, quote, snipeFee);
        }

        emit Buy(recipient, quoteIn, tokensOut, protoFee, snipeFee);

        if (tokensSold >= FeeMath.curveSoldSupply() || marketCapUsd() >= Constants.PEARLY_GATES_MCAP_USD) {
            _graduate();
        }
    }

    /// @inheritdoc IBondingCurve
    function sell(uint256 tokensIn, uint256 minQuoteOut, uint256 deadline)
        external
        override
        returns (uint256 quoteOut)
    {
        if (graduated) revert Graduated();
        if (block.timestamp > deadline) revert Expired();
        if (tokensIn == 0) revert ZeroAmount();

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);

        uint256 gross = CurveMath.quoteOutForTokens(_params, tokensSold, tokensIn);
        uint256 protoFee = FeeMath.protocolFee(gross);
        uint256 tax = FeeMath.creatorTax(gross, creatorTaxBps);
        quoteOut = gross - protoFee - tax;
        if (quoteOut < minQuoteOut) revert Slippage();

        if (balanceOnCurve[msg.sender] < tokensIn) {
            balanceOnCurve[msg.sender] = 0;
        } else {
            balanceOnCurve[msg.sender] -= tokensIn;
        }

        tokensSold -= tokensIn;
        quoteReserve -= gross;

        if (protoFee + tax > 0) {
            IERC20(quote).safeTransfer(address(feeRouter), protoFee + tax);
            feeRouter.routeTradeFee(token, quote, msg.sender, creator, protoFee, tax);
        }

        IERC20(quote).safeTransfer(msg.sender, quoteOut);
        emit Sell(msg.sender, tokensIn, quoteOut, protoFee);
    }

    /// @dev Atomic same-tx migrate to locked v4 at curve-end price — no pause/gap (§2 / LOCKED #5).
    function _graduate() internal {
        if (graduated) return;
        graduated = true;

        uint256 tokenLiq = IERC20(token).balanceOf(address(this));
        uint256 quoteLiq = quoteReserve;
        uint256 priceWad = CurveMath.spotPriceWad(_params, tokensSold);

        IERC20(token).forceApprove(address(migration), tokenLiq);
        IERC20(quote).forceApprove(address(migration), quoteLiq);

        bytes32 poolId = migration.migrate(token, quote, tokenLiq, quoteLiq, priceWad);
        quoteReserve = 0;

        emit GraduatedToV4(token, poolId, tokenLiq, quoteLiq);
    }
}
