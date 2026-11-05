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
        _requiredAddress("TREASURY");
        _requiredContract("POOL_MANAGER");
        _requiredContract("V4_QUOTER");
        address usdg = _requiredContract("USDG");
        address quote = _requiredContract("DEFAULT_QUOTE");
        _requiredAddress("PVE_ATTESTER");
        require(!vm.envOr("DEPLOY_TEST_STRATEGY", false), "Network: no mock assets on mainnet");
        // Required, not defaults. Their actual values are OWNER DECISION; constructor checks still apply.
        vm.envUint("EXPECT_USDG_DECIMALS");
        uint256 liquidity = vm.envUint("MIN_LIQUIDITY");
        require(liquidity > 0 && liquidity <= type(uint128).max, "Network: invalid MIN_LIQUIDITY");
        require(vm.envUint("PROBE_USDG") > 0, "Network: invalid PROBE_USDG");
        vm.envUint("ANON_LAUNCH_FEE");
        vm.envAddress("ERC5564_ANNOUNCER"); // explicit zero is allowed to disable announcements
        if (quote != usdg) {
            uint256 fee = vm.envUint("DEFAULT_QUOTE_POOL_FEE");
            uint256 spacing = vm.envUint("DEFAULT_QUOTE_POOL_TICK_SPACING");
            require(
                fee <= type(uint24).max && spacing > 0 && spacing <= uint256(uint24(type(int24).max)),
                "Network: bad pool key"
            );
            _requiredContract("DEFAULT_QUOTE_POOL_HOOKS");
        }
    }
}
