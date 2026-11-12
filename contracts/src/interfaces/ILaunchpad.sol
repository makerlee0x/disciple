// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title Permissionless factory / launchpad (§5 / LOCKED #23–#27)
interface ILaunchpad {
    struct LaunchParams {
        string name;
        string ticker;
        string imageURI; // required (Flaunch-like)
        string description; // optional
        string socialsURI; // optional JSON / URI
        address quote;
        uint256 creatorTaxBps; // 0..CREATOR_TAX_MAX_BPS, immutable
        uint256 creatorBuyQuoteIn; // optional same-tx buy; 0 = skip
        uint256 creatorBuyMinTokensOut;
        uint256 deadline;
        /// @notice Where this coin's creator fee goes. Fixed at launch. Omitted or zero keeps today's behavior.
        ///         0 = the creator keeps the creator fees.
        ///         1 = creator fees are deposited into the rocket's locked liquidity pool, and that liquidity is renounced.
        ///         2 = creator fees buy and burn the quote token. On the bonding curve the fee is already the quote
        ///             token, so it is burned. After orbit, the quote half is burned and the rocket-token half is
        ///             sold for more of the quote token, which is burned.
        uint8 creatorFeeDestination;
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
