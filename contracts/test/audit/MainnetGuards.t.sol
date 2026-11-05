// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {Test} from "forge-std/Test.sol";
import {NetworkConfig} from "../../script/config/NetworkConfig.sol";

contract NetworkGuardHarness is NetworkConfig {
    function check() external view returns (bool) {
        return _checkCoreConfig();
    }
}

contract MainnetGuardsTest is Test {
    NetworkGuardHarness guard;
    string[] keys;
    mapping(string => string) original;
    modifier isolatedEnv() {
        _restore();
        _;
        _restore();
    }

    function _restore() internal {
        for (uint256 i; i < keys.length; ++i) {
            vm.setEnv(keys[i], original[keys[i]]);
        }
    }

    function setUp() public {
        guard = new NetworkGuardHarness();
        keys.push("DISCIPLE_NETWORK");
        keys.push("DISCIPLE_CHAIN_ID");
        keys.push("TREASURY");
        keys.push("POOL_MANAGER");
        keys.push("V4_QUOTER");
        keys.push("USDG");
        keys.push("DEFAULT_QUOTE");
        keys.push("PVE_ATTESTER");
        keys.push("EXPECT_USDG_DECIMALS");
        keys.push("MIN_LIQUIDITY");
        keys.push("PROBE_USDG");
        keys.push("ANON_LAUNCH_FEE");
        keys.push("ERC5564_ANNOUNCER");
        keys.push("DEPLOY_TEST_STRATEGY");
        for (uint256 i; i < keys.length; ++i) {
            original[keys[i]] = vm.envOr(keys[i], string(""));
        }
    }

    function test_testnetAndLocalStillPass() public isolatedEnv {
        vm.chainId(46630);
        assertFalse(guard.check());
        vm.chainId(31337);
        assertFalse(guard.check());
    }

    function test_mainnetWithoutConfigFailsClosed() public isolatedEnv {
        vm.chainId(4663);
        vm.expectRevert("Network: explicit mainnet config required");
        guard.check();
    }

    function test_mainnetConfirmationDoesNotPermitMissingAddresses() public isolatedEnv {
        vm.chainId(4663);
        _confirm();
        vm.setEnv("TREASURY", vm.toString(address(0)));
        vm.expectRevert("Network: missing TREASURY");
        guard.check();
    }

    function test_mainnetDummyConfigPassesGuardOnly() public isolatedEnv {
        vm.chainId(4663);
        _dummyConfig();
        assertTrue(guard.check());
    }

    function test_mainnetDummyConfigOnWrongChainFailsClosed() public isolatedEnv {
        _dummyConfig();
        vm.chainId(46630);
        vm.expectRevert("Network: mode/chain mismatch");
        guard.check();
    }

    function test_unknownChainNeverPasses() public isolatedEnv {
        vm.chainId(1);
        vm.expectRevert("Network: unsupported chain");
        guard.check();
    }

    function test_mainnetCannotCreateMockQuote() public isolatedEnv {
        vm.chainId(4663);
        _dummyConfig();
        vm.setEnv("DEPLOY_TEST_STRATEGY", "true");
        vm.expectRevert("Network: no mock assets on mainnet");
        guard.check();
    }

    function _confirm() internal {
        vm.setEnv("DISCIPLE_NETWORK", "mainnet");
        vm.setEnv("DISCIPLE_CHAIN_ID", "4663");
    }

    function _dummyConfig() internal {
        _confirm();
        address fixture = makeAddr("DUMMY CONFIG ONLY");
        vm.etch(fixture, hex"00");
        string memory a = vm.toString(fixture);
        vm.setEnv("TREASURY", a);
        vm.setEnv("POOL_MANAGER", a);
        vm.setEnv("V4_QUOTER", a);
        vm.setEnv("USDG", a);
        vm.setEnv("DEFAULT_QUOTE", a);
        vm.setEnv("PVE_ATTESTER", a);
        vm.setEnv("EXPECT_USDG_DECIMALS", "6");
        vm.setEnv("MIN_LIQUIDITY", "1");
        vm.setEnv("PROBE_USDG", "1");
        vm.setEnv("ANON_LAUNCH_FEE", "0");
        vm.setEnv("ERC5564_ANNOUNCER", vm.toString(address(0)));
        vm.setEnv("DEPLOY_TEST_STRATEGY", "false");
    }
}
