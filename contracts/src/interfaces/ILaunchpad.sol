// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Permissionless factory / launchpad (§5 / LOCKED #23–#27)
interface ILaunchpad {
    struct LaunchParams {
        string name;
        string ticker;
        string imageURI; // required (Flaunch-like)
        string description; // optional
        string socialsURI; // optional JSON / URI
        address quote;
        uint256 quotePriceUsd; // USD WAD per 1 full quote token (e.g. 1e18 for USDG)
        uint256 creatorTaxBps; // 0..CREATOR_TAX_MAX_BPS, immutable
        uint256 creatorBuyQuoteIn; // optional same-tx buy; 0 = skip
        uint256 creatorBuyMinTokensOut;
        uint256 deadline;
    }

    struct LaunchResult {
        address token;
        address curve;
        uint256 creatorTokensBought;
    }

    function launch(LaunchParams calldata params) external returns (LaunchResult memory);

    /// @notice Alias of launch. quote=address(0) resolves to Launchpad.defaultQuote (STRATEGY).
    function launchCoin(LaunchParams calldata params) external returns (LaunchResult memory);

    function isLaunched(address token) external view returns (bool);
    function curveOf(address token) external view returns (address);
    /// @notice Current creator (ownership pack); used for fee claim + tax rights.
    function creatorOf(address token) external view returns (address);
}
