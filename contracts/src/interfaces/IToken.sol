// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title DISCIPLE launch token (§2 / LOCKED #7, #10)
interface IToken is IERC20 {
    function decimals() external view returns (uint8);
    function creator() external view returns (address);
    function launchpad() external view returns (address);
}
