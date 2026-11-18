// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

interface IOwnable2Step {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function transferOwnership(address newOwner) external;
}

interface ISafe {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}

/// @title HandoverToSafe: hand every contract Deploy.s.sol left with the deployer to the 2-of-3 protocol Safe
/// @notice maker 2026-11-17: 2-of-3 Safe, "safe only, no timelock" for launch (a timelock stays opt-in). The Safe address comes after the mainnet
///         deploy. Deploy.s.sol (run without SAFE) still does every renounce and lock on 4663; only the owner roles
///         that remain stay with the deployer. Run this once the Safe exists, from the DEPLOYER key:
///
///           SAFE=0x… LAUNCHPAD=0x… FEE_ROUTER=0x… QUOTE_PRICER=0x… QUOTE_PROBE=0x… MIGRATION=0x… DISCIPLE_ROUTER=0x…
///           REFERRALS=0x… ANON_LAUNCHER=0x… REWARDS_VAULT=0x… \
///           forge script script/HandoverToSafe.s.sol --rpc-url $RPC --broadcast
///
///         1. Checks SAFE is a 2-of-3 Safe (override with SAFE_THRESHOLD / SAFE_OWNERS).
///         2. NOMINATES the Safe as owner of every protocol contract (two-step ownership). The Safe then calls
///            acceptOwnership() on each (one batched Safe tx). Until then the deployer is still the owner, so a wrong
///            address can be re-nominated.
///         Optional, off for launch: USE_TIMELOCK=true deploys a fresh TimelockController (delay TIMELOCK_DELAY
///         seconds, default 48 h; the Safe is the only proposer, executor and canceller; no admin) and nominates it
///         instead of the Safe. Turning a timelock on later needs no script: the Safe calls
///         transferOwnership(timelock) on each contract and the timelock accepts.
///         RewardsVault always goes to the Safe directly: its owner pays out community rewards.
///         Every contract address must be set; the script reverts on a missing one.
/// @dev SET_TREASURY=true also points FeeRouter.setTreasury at the Safe (money in, no delay needed).
///      LockedLP and CreatorFeeHarvest are renounced at deploy on mainnet, so they have no owner to hand over.
///      TrampWallManager is not deployed for launch (maker 2026-11-17).
contract HandoverToSafe is Script {
    string[8] internal TIMELOCKED = [
        "LAUNCHPAD", "FEE_ROUTER", "QUOTE_PRICER", "QUOTE_PROBE", "MIGRATION", "DISCIPLE_ROUTER", "REFERRALS", "ANON_LAUNCHER"
    ];

    function run() external {
        address safe = vm.envAddress("SAFE");
        require(safe.code.length != 0, "Handover: SAFE has no code");
        require(
            ISafe(safe).getThreshold() == vm.envOr("SAFE_THRESHOLD", uint256(2))
                && ISafe(safe).getOwners().length == vm.envOr("SAFE_OWNERS", uint256(3)),
            "Handover: SAFE is not 2-of-3"
        );
        uint256 delay = vm.envOr("TIMELOCK_DELAY", uint256(48 hours));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        // maker 2026-11-17: "safe only, no timelock" for launch. USE_TIMELOCK=true puts the protocol
        // contracts behind a TimelockController instead; the Safe can also move them to one later (transferOwnership).
        address owner_ = safe;
        // Audit 2026-11-18 E-L5: always a fresh controller (Safe is the only proposer/executor/canceller, no admin);
        // reusing an existing one can't be checked for extra role holders.
        address timelock;
        if (vm.envOr("USE_TIMELOCK", false)) {
            {
                address[] memory roles = new address[](1);
                roles[0] = safe;
                timelock = address(new TimelockController(delay, roles, roles, address(0)));
                console2.log("TimelockController", timelock);
            }
            require(TimelockController(payable(timelock)).getMinDelay() >= 1 hours, "Handover: timelock delay too short");
            owner_ = timelock;
        }

        for (uint256 i; i < TIMELOCKED.length; ++i) {
            _handOver(TIMELOCKED[i], owner_, deployer);
        }
        _handOver("REWARDS_VAULT", safe, deployer);

        if (vm.envOr("SET_TREASURY", false)) {
            address fr = vm.envAddress("FEE_ROUTER");
            (bool ok,) = fr.call(abi.encodeWithSignature("setTreasury(address)", safe));
            require(ok, "Handover: FeeRouter.setTreasury failed");
        }
        vm.stopBroadcast();
        if (owner_ == safe) console2.log("Next: the Safe calls acceptOwnership() on each nominated contract (one batch).");
        else console2.log("Next: the Safe schedules acceptOwnership() via the timelock, executes after the delay, and accepts RewardsVault directly.");
    }

    function _handOver(string memory name, address to, address deployer) internal {
        address c = vm.envOr(name, address(0));
        // Audit 2026-11-18 E-L4: every contract must be listed; a missing one would stay with the deployer silently.
        require(c != address(0), string.concat("Handover: set ", name));
        require(c.code.length != 0, string.concat("Handover: no code at ", name));
        address o = IOwnable2Step(c).owner();
        if (o == to) {
            console2.log("already owned", name);
            return;
        }
        require(o == deployer, string.concat("Handover: deployer is not the owner of ", name));
        IOwnable2Step(c).transferOwnership(to);
        require(IOwnable2Step(c).pendingOwner() == to, string.concat("Handover: nomination failed for ", name));
        console2.log("nominated", name, c);
    }
}
