// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title External bonding curve — hybrid Pump-early / raise-late (§2 / LOCKED #5–#8)
interface IBondingCurve {
    function token() external view returns (address);
    function quote() external view returns (address);
    function graduated() external view returns (bool);
    function quoteReserve() external view returns (uint256);
    function tokensSold() external view returns (uint256);
    function marketCapUsd() external view returns (uint256);

    function buy(uint256 quoteIn, uint256 minTokensOut, uint256 deadline) external returns (uint256 tokensOut);

    function sell(uint256 tokensIn, uint256 minQuoteOut, uint256 deadline) external returns (uint256 quoteOut);
}
