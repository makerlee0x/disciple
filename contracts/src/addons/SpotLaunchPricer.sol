// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISpotSource {
    function spotPriceUsd(address quote) external view returns (uint256);
    function isAllowedQuote(address quote) external view returns (bool);
    function usdg() external view returns (address);
}

/// @title SpotLaunchPricer
/// @notice Launch price from the pair coin's LIVE spot price, so no keeper has to keep a TWAP warm (maker 2026-11-20:
///         "just call it right when someone presses launch"; a pump of the pair coin at launch needs real money and is
///         accepted). Wraps the deployed QuotePricer and reads its `spotPriceUsd` (listed 1- or 2-hop USDG routes, the
///         $10k-per-side pool floor, USDG = 1e30). Holds no state and has no owner.
/// @dev Plugged in with Launchpad.setPricer(address(this)) by the Launchpad owner; setPricer(old) undoes it.
///      Launchpad.launch calls poke (no-op here) then launchPriceUsd. Graduated curves / MarketLens read quotePriceUsd
///      through Launchpad.pricer() inside try/catch for display. The hook keeps its own pricer reference.
contract SpotLaunchPricer {
    ISpotSource public immutable source;

    error ZeroSource();
    /// @dev Same rule and name as QuotePricer.launchPriceUsd: only USDG and listed pair coins can launch (review F-M1:
    ///      a fee-on-transfer / rebasing / pausable quote would freeze a curve's funds).
    error QuoteNotListed(address quote);

    constructor(address source_) {
        if (source_ == address(0)) revert ZeroSource();
        source = ISpotSource(source_);
    }

    /// @notice Nothing to record: the price is read live.
    function poke(address) external {}

    /// @notice USD WAD per 1e18 raw units of `quote`, live spot (reverts like QuotePricer.spotPriceUsd: unlisted /
    ///         no route above the floor / thin pool).
    function launchPriceUsd(address quote) external view returns (uint256) {
        if (quote != source.usdg() && !source.isAllowedQuote(quote)) revert QuoteNotListed(quote);
        return source.spotPriceUsd(quote);
    }

    /// @notice Same live spot price (display reads after graduation).
    function quotePriceUsd(address quote) external view returns (uint256) {
        return source.spotPriceUsd(quote);
    }

    /// @notice Same as quotePriceUsd (QuotePricer has it too; kept for callers that ask for spot by name).
    function spotPriceUsd(address quote) external view returns (uint256) {
        return source.spotPriceUsd(quote);
    }
}
