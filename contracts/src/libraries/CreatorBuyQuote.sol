// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Constants} from "./Constants.sol";
import {CurveMath} from "./CurveMath.sol";
import {FeeMath} from "./FeeMath.sol";
import {IQuotePricer} from "../interfaces/IQuotePricer.sol";

/// @title Creator-buy preview
/// @notice The curve math for `Launchpad.quoteCreatorBuy`. It lives here, and Launchpad delegatecalls it, so the
///         launch contract stays under the EIP-170 size limit. The numbers match the inlined preview exactly.
/// @dev External on purpose: an internal library would be copied into Launchpad.
library CreatorBuyQuote {
    error TaxTooHigh();
    error DefaultQuoteUnset();
    error PricerUnset();

    /// @param capBps `Launchpad.firstBoostMaxBps(mode)`. The creator buy is exempt from the sniper tax, so `snipeFee` is 0.
    function preview(
        address quote,
        uint256 creatorBuyQuoteIn,
        uint256 creatorTaxBps,
        address defaultQuote,
        address pricer,
        uint256 capBps
    ) external view returns (uint256 tokensOut, uint256 fee, uint256 snipeFee, uint256 quotePriceUsd, bool exceedsCap) {
        if (creatorTaxBps > Constants.CREATOR_TAX_MAX_BPS) revert TaxTooHigh();
        if (quote == address(0)) quote = defaultQuote;
        if (quote == address(0)) revert DefaultQuoteUnset();
        if (pricer == address(0)) revert PricerUnset();
        quotePriceUsd = IQuotePricer(pricer).quotePriceUsd(quote);
        snipeFee = 0; // creator buy is exempt from the sniper tax
        uint256 afterSnipe = creatorBuyQuoteIn;
        fee = FeeMath.protocolFee(afterSnipe) + FeeMath.creatorTax(afterSnipe, creatorTaxBps);
        tokensOut = CurveMath.tokensOutForQuote(CurveMath.makeParams(quotePriceUsd), 0, afterSnipe - fee);
        uint256 maxTokens = FeeMath.creatorBuyMax(capBps);
        if (tokensOut > maxTokens) {
            exceedsCap = true;
            tokensOut = maxTokens;
        }
    }
}
