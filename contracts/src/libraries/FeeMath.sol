// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Constants} from "./Constants.sol";

/// @title Fee split helpers for DISCIPLE 1% trade fee (§3 / LOCKED #11–#12)
library FeeMath {
    /// @notice Split a protocol fee amount into creator / LP / treasury / referral shares.
    /// @param feeAmount Absolute fee taken from the trade (already TRADE_FEE_BPS of notional).
    /// @return creator FEE_SHARE_CREATOR / 100 of feeAmount
    /// @return lpLock  FEE_SHARE_LP_LOCK / 100 of feeAmount
    /// @return treasury FEE_SHARE_TREASURY / 100 of feeAmount
    /// @return referral FEE_SHARE_REFERRAL / 100 of feeAmount (remainder to treasury if no referrer)
    function splitTradeFee(uint256 feeAmount)
        internal
        pure
        returns (uint256 creator, uint256 lpLock, uint256 treasury, uint256 referral)
    {
        creator = (feeAmount * Constants.FEE_SHARE_CREATOR) / Constants.FEE_SHARE_DENOM;
        lpLock = (feeAmount * Constants.FEE_SHARE_LP_LOCK) / Constants.FEE_SHARE_DENOM;
        treasury = (feeAmount * Constants.FEE_SHARE_TREASURY) / Constants.FEE_SHARE_DENOM;
        referral = feeAmount - creator - lpLock - treasury; // residual (= FEE_SHARE_REFERRAL share)
    }

    /// @notice Protocol trade fee on a notional amount.
    function protocolFee(uint256 notional) internal pure returns (uint256) {
        return (notional * Constants.TRADE_FEE_BPS) / Constants.BPS_DENOM;
    }

    /// @notice Optional creator tax on top of protocol fee (immutable per launch).
    function creatorTax(uint256 notional, uint256 creatorTaxBps) internal pure returns (uint256) {
        if (creatorTaxBps == 0) return 0;
        require(creatorTaxBps <= Constants.CREATOR_TAX_MAX_BPS, "FeeMath: tax > max");
        return (notional * creatorTaxBps) / Constants.BPS_DENOM;
    }

    /// @notice Max tokens a wallet may hold while on the bonding curve (7% of supply).
    function walletCap() internal pure returns (uint256) {
        return (Constants.TOTAL_SUPPLY * Constants.WALLET_CAP_BPS) / Constants.BPS_DENOM;
    }

    /// @notice Tokens sold on curve before graduation (~72%).
    function curveSoldSupply() internal pure returns (uint256) {
        return (Constants.TOTAL_SUPPLY * Constants.CURVE_SOLD_BPS) / Constants.BPS_DENOM;
    }

    /// @notice Max creator buy at launch (0.77% of supply).
    function creatorBuyMax() internal pure returns (uint256) {
        return (Constants.TOTAL_SUPPLY * Constants.CREATOR_BUY_MAX_BPS) / Constants.BPS_DENOM;
    }
}
