// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Constants} from "./libraries/Constants.sol";
import {IAntiSnipe} from "./interfaces/IAntiSnipe.sol";

/// @title Buy-side anti-snipe fee: 77.7% → 0% over 7 seconds (§2 / LOCKED #9)
/// @dev Snipe fee destination: 100% locks quote into LP (handled by caller / FeeRouter).
contract AntiSnipe is IAntiSnipe {
    mapping(address => uint256) public override launchTimestamp;

    address public immutable launchpad;

    error OnlyLaunchpad();
    error AlreadyRegistered();

    constructor(address launchpad_) {
        launchpad = launchpad_;
    }

    /// @notice Called once at token launch to start the 7s decay window.
    function registerLaunch(address token) external {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        if (launchTimestamp[token] != 0) revert AlreadyRegistered();
        launchTimestamp[token] = block.timestamp;
    }

    /// @inheritdoc IAntiSnipe
    function currentFeeBps(address token) public view override returns (uint256 feeBps) {
        uint256 t0 = launchTimestamp[token];
        if (t0 == 0) return Constants.ANTI_SNIPE_END_BPS;

        uint256 elapsed = block.timestamp - t0;
        if (elapsed >= Constants.ANTI_SNIPE_DURATION) {
            return Constants.ANTI_SNIPE_END_BPS;
        }

        // Linear decay: start - (start - end) * elapsed / duration
        uint256 range = Constants.ANTI_SNIPE_START_BPS - Constants.ANTI_SNIPE_END_BPS;
        feeBps = Constants.ANTI_SNIPE_START_BPS - (range * elapsed) / Constants.ANTI_SNIPE_DURATION;
    }

    /// @inheritdoc IAntiSnipe
    function applyBuyFee(address token, uint256 quoteIn)
        external
        view
        override
        returns (uint256 feeAmount, uint256 feeBps)
    {
        feeBps = currentFeeBps(token);
        feeAmount = (quoteIn * feeBps) / Constants.BPS_DENOM;
    }
}
