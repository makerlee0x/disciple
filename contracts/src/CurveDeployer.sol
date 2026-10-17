// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BondingCurve} from "./BondingCurve.sol";

/// @title Deploys BondingCurve instances for the Launchpad (keeps Launchpad under EIP-170).
/// @dev Permissionless: the deployed curve's `launchpad` is always msg.sender, so a curve deployed by anyone
///      other than the real Launchpad is inert (not registered, not FeeRouter-authorized).
contract CurveDeployer {
    function deploy(
        address token,
        address quote,
        address creator,
        address feeRouter,
        address antiSnipe,
        address migration,
        uint256 creatorTaxBps,
        uint256 quotePriceUsd,
        uint256 walletCapBps,
        uint8 mode,
        address loginGate
    ) external returns (address) {
        return address(
            new BondingCurve(
                token,
                quote,
                creator,
                msg.sender,
                feeRouter,
                antiSnipe,
                migration,
                creatorTaxBps,
                quotePriceUsd,
                walletCapBps,
                mode,
                loginGate
            )
        );
    }
}
