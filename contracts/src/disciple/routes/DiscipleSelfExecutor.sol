// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title DiscipleSelfExecutor
/// @notice A zero-fee LayerZero executor for the push sender's executor config. The paid executor is about two
///         thirds of an Ethereum -> Robinhood message fee (measured 2026-11-04), yet its job is only to call
///         `commitVerification` and `endpoint.lzReceive` on Robinhood once the DVNs have verified, which anyone may
///         do. With this executor the keeper does that step itself, at Robinhood gas prices, and the receiving pool
///         refunds that gas. Holds nothing and does nothing; it only prices the job at zero.
contract DiscipleSelfExecutor {
    function assignJob(uint32, address, uint256, bytes calldata) external pure returns (uint256) {
        return 0;
    }

    function getFee(uint32, address, uint256, bytes calldata) external pure returns (uint256) {
        return 0;
    }
}
