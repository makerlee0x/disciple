// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {SpotLaunchPricer} from "../../src/addons/SpotLaunchPricer.sol";

/// @notice Deploys SpotLaunchPricer over the live QuotePricer (maker 2026-11-20: launch price from spot, no keeper).
///   forge script script/pricer/DeploySpotLaunchPricer.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com \
///     --account disciple-deployer --broadcast
/// Then the Launchpad owner (Team Safe) calls Launchpad(0xe43F360DC65C9Ba1B7a835BDaa10Fb31f6DC52E5).setPricer(<printed>).
/// Undo: setPricer(0x95b6FeCef5E94254A4e676ADc6af91fDd70e0f27).
contract DeploySpotLaunchPricer is Script {
    address internal constant QUOTE_PRICER_4663 = 0x95b6FeCef5E94254A4e676ADc6af91fDd70e0f27;

    function run() external returns (SpotLaunchPricer p) {
        address src = vm.envOr("QUOTE_PRICER", QUOTE_PRICER_4663);
        vm.startBroadcast();
        p = new SpotLaunchPricer(src);
        vm.stopBroadcast();
        console2.log("SpotLaunchPricer", address(p));
        console2.log("next: Launchpad.setPricer(SpotLaunchPricer) from the Launchpad owner");
    }
}
