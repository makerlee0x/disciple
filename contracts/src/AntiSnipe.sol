// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Constants} from "./libraries/Constants.sol";
import {FeeMath} from "./libraries/FeeMath.sol";
import {IAntiSnipe} from "./interfaces/IAntiSnipe.sol";

/// @title LEGACY standalone anti-snipe fee schedule (pre-mode-rules-v2). Reads Constants, so it now reports
///        99% → 0% over 7 seconds (per-second table, FeeMath.snipeBps / Constants.ANTI_SNIPE_TABLE).
/// @dev Still deployed by Deploy.s.sol, but v2 BondingCurves never call it: they compute the sniper tax inline
///      (BondingCurve.currentSnipeFeeBps) and hold it in `snipeEscrow`. At graduation that escrow goes to LockedLP's
///      locked compound bucket (excluded from the graduation floor); if not graduated within `snipeEscrowTimeout`
///      (default 30 days) anyone can release it to RewardsVault. Nothing here routes a fee.
contract AntiSnipe is IAntiSnipe {
    mapping(address => uint256) public override launchTimestamp;

    address public immutable launchpad;

    error OnlyLaunchpad();
    error AlreadyRegistered();

    constructor(address launchpad_) {
        launchpad = launchpad_;
    }

    /// @notice Called once at token launch to start the 7s decay window (legacy; unused by v2 curves).
    function registerLaunch(address token) external {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        if (launchTimestamp[token] != 0) revert AlreadyRegistered();
        launchTimestamp[token] = block.timestamp;
    }

    /// @inheritdoc IAntiSnipe
    function currentFeeBps(address token) public view override returns (uint256 feeBps) {
        uint256 t0 = launchTimestamp[token];
        if (t0 == 0) return Constants.ANTI_SNIPE_END_BPS;

        // Same per-second schedule as v2 curves (FeeMath.snipeBps): 99% → 0 from 7s.
        feeBps = FeeMath.snipeBps(block.timestamp - t0);
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
