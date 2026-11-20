// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";

/// @notice Explicit allowlist. Mainnet has no mock-token/address/parameter fallbacks.
abstract contract NetworkConfig is Script {
    function _checkNetwork() internal view returns (bool mainnet) {
        string memory mode = vm.envOr("DISCIPLE_NETWORK", string(""));
        bytes32 m = keccak256(bytes(mode));
        uint256 confirmed = vm.envOr("DISCIPLE_CHAIN_ID", uint256(0));
        if (block.chainid == 46630 || block.chainid == 31337) {
            bytes32 expected = keccak256(bytes(block.chainid == 46630 ? "testnet" : "local"));
            require(bytes(mode).length == 0 || m == expected, "Network: mode/chain mismatch");
            require(confirmed == 0 || confirmed == block.chainid, "Network: chain mismatch");
            return false;
        }
        require(block.chainid == 4663, "Network: unsupported chain");
        require(m == keccak256("mainnet") && confirmed == block.chainid, "Network: explicit mainnet config required");
        return true;
    }

    function _requiredAddress(string memory name) internal view returns (address a) {
        a = vm.envOr(name, address(0));
        require(a != address(0), string.concat("Network: missing ", name));
    }

    function _requiredContract(string memory name) internal view returns (address a) {
        a = _requiredAddress(name);
        require(a.code.length != 0, string.concat("Network: no code at ", name));
    }

    /// @dev Called BEFORE startBroadcast by Deploy; the same preflight is exercised by the guard harness tests.
    function _checkCoreConfig() internal view returns (bool mainnet) {
        mainnet = _checkNetwork();
        if (!mainnet) return false;
        // Audit delta-2 4/4 D2-04(2): the treasury is fixed forever in the hook and LockedLP, so it must be a Safe (a
        // contract), not an EOA or a typo.
        _requiredContract("TREASURY");
        // maker 2026-11-19: the community rewards Safe (1% of every fee, unclaimed sniper fees, no-holder crew tips).
        // A Safe is a contract, so a typo'd EOA fails here; it is fixed in the hook forever.
        _requiredContract("COMMUNITY_SAFE");
        _requiredContract("POOL_MANAGER");
        _requiredContract("V4_QUOTER");
        address usdg = _requiredContract("USDG");
        address quote = _requiredContract("DEFAULT_QUOTE");
        // SAFE is optional at deploy time (maker 2026-11-17: the Safe address comes after mainnet). Set → it must be a
        // contract and Deploy nominates it; unset → the deployer keeps the owner roles until script/HandoverToSafe.s.sol.
        address safe = vm.envOr("SAFE", address(0));
        require(safe == address(0) || safe.code.length != 0, "Network: SAFE has no code");
        _requiredAddress("PRICER_POKER"); // launches fail closed (StalePrice) without keeper pokes
        require(!vm.envOr("DEPLOY_TEST_STRATEGY", false), "Network: no mock assets on mainnet");
        // Required, not defaults. Their actual values are OWNER DECISION; constructor checks still apply.
        vm.envUint("EXPECT_USDG_DECIMALS");
        uint256 liquidity = vm.envUint("MIN_LIQUIDITY");
        require(liquidity > 0 && liquidity <= type(uint128).max, "Network: invalid MIN_LIQUIDITY");
        require(vm.envUint("PROBE_USDG") > 0, "Network: invalid PROBE_USDG");
        vm.envAddress("ERC5564_ANNOUNCER"); // explicit zero is allowed to disable announcements
        // Mainnet prices and routes every pair coin (the default quote included) through the fork-tested
        // script/whitelist/MainnetRoutes.sol routes, so no DEFAULT_QUOTE_POOL_* key is read on 4663.
        quote; // Deploy checks it is one of the 12 listed pair coins (or USDG)
    }
}
