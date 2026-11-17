// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

interface IOwnable2Step {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function transferOwnership(address newOwner) external;
}

/// @title HandoverToSafe — nominate the protocol Safe as owner of every contract Deploy.s.sol left with the deployer
/// @notice maker 2026-11-17: the Safe address comes after the mainnet deploy. Deploy.s.sol (run without SAFE) still does
///         every renounce and lock on 4663; only the owner roles that remain stay with the deployer. Run this once the
///         Safe exists, from the DEPLOYER key:
///
///           SAFE=0x… LAUNCHPAD=0x… FEE_ROUTER=0x… QUOTE_PRICER=0x… QUOTE_PROBE=0x… MIGRATION=0x… DISCIPLE_ROUTER=0x…
///           TRAMP_WALL=0x… REFERRALS=0x… ANON_LAUNCHER=0x… REWARDS_VAULT=0x… \
///           forge script script/HandoverToSafe.s.sol --rpc-url $RPC --broadcast
///
///         Addresses are the ones Deploy.s.sol printed. An unset or zero entry is skipped. Each contract is only
///         NOMINATED (two-step ownership): the Safe then calls acceptOwnership() on each one, ideally as one batched
///         Safe transaction. Until it does, the deployer is still the owner, so a typo'd SAFE can be re-nominated.
/// @dev FeeRouter's treasury is tunable: set SET_TREASURY=true to also point FeeRouter.setTreasury at the Safe.
///      LockedLP and CreatorFeeHarvest are renounced at deploy on mainnet, so they have no owner to hand over.
contract HandoverToSafe is Script {
    string[10] internal NAMES = [
        "LAUNCHPAD",
        "FEE_ROUTER",
        "QUOTE_PRICER",
        "QUOTE_PROBE",
        "MIGRATION",
        "DISCIPLE_ROUTER",
        "TRAMP_WALL",
        "REFERRALS",
        "ANON_LAUNCHER",
        "REWARDS_VAULT"
    ];

    function run() external {
        address safe = vm.envAddress("SAFE");
        require(safe.code.length != 0, "Handover: SAFE has no code");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        for (uint256 i; i < NAMES.length; ++i) {
            address c = vm.envOr(NAMES[i], address(0));
            if (c == address(0)) {
                console2.log("skip (unset)", NAMES[i]);
                continue;
            }
            require(c.code.length != 0, string.concat("Handover: no code at ", NAMES[i]));
            address o = IOwnable2Step(c).owner();
            if (o == safe) {
                console2.log("already owned by Safe", NAMES[i]);
                continue;
            }
            require(o == deployer, string.concat("Handover: deployer is not the owner of ", NAMES[i]));
            IOwnable2Step(c).transferOwnership(safe);
            require(IOwnable2Step(c).pendingOwner() == safe, string.concat("Handover: nomination failed for ", NAMES[i]));
            console2.log("nominated", NAMES[i], c);
        }
        if (vm.envOr("SET_TREASURY", false)) {
            address fr = vm.envAddress("FEE_ROUTER");
            (bool ok,) = fr.call(abi.encodeWithSignature("setTreasury(address)", safe));
            require(ok, "Handover: FeeRouter.setTreasury failed");
        }
        vm.stopBroadcast();
        console2.log("Next: the Safe calls acceptOwnership() on each nominated contract.");
    }
}
