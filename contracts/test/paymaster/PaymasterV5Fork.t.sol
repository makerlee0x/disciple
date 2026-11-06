// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EntryPoint} from "../vendor/aa-v07/core/EntryPoint.sol";
import {DisciplePaymasterV5 as PM} from "../../src/paymaster/DisciplePaymasterV5.sol";

interface IMeta {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
    function name() external view returns (string memory);
}

/// @notice Forks the public Robinhood RPCs and talks to the real USDG contracts. No broadcast.
contract PaymasterV5ForkTest is Test {
    address constant EP = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant MAINNET_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant TESTNET_USDG = 0x9dC7A988a8707dC4AB7ac08fC2CB4D5bf906158D;

    function test_fork_mainnet_paxos_usdg_credit_roundtrip() public {
        vm.createSelectFork("https://rpc.mainnet.chain.robinhood.com");
        assertEq(block.chainid, 4663);
        _roundTrip(MAINNET_USDG);
    }

    function test_fork_testnet_mock_usdg_credit_roundtrip() public {
        vm.createSelectFork("https://rpc.testnet.chain.robinhood.com");
        assertEq(block.chainid, 46630);
        _roundTrip(TESTNET_USDG);
    }

    function _roundTrip(address token) internal {
        assertEq(IMeta(token).decimals(), 6, "USDG decimals");
        console2.log("token", IMeta(token).symbol());
        if (EP.code.length == 0) {
            EntryPoint deployed = new EntryPoint();
            vm.etch(EP, address(deployed).code);
        }
        address owner = makeAddr("owner");
        address treasury = makeAddr("treasury");
        address signer = makeAddr("signer");
        PM pm = new PM(EP, token, owner, signer, treasury, 1, type(uint128).max, 7_068_712, 40_000);
        assertEq(pm.usdg(), token);
        assertEq(pm.PREPAY_VERSION(), 5);

        address player = makeAddr("player");
        uint256 amount = 2_000_000;
        _fund(token, player, amount);
        vm.startPrank(player);
        IERC20(token).approve(address(pm), amount);
        pm.deposit(player, amount);
        vm.stopPrank();
        assertEq(pm.creditOf(player), amount, "prefunded credit");
        assertEq(IERC20(token).balanceOf(address(pm)), amount);
        assertEq(pm.availableCredit(player), amount);

        uint256 wallet = IERC20(token).balanceOf(player);
        vm.prank(player);
        pm.withdraw();
        assertEq(pm.creditOf(player), 0, "withdraw-all");
        assertEq(IERC20(token).balanceOf(player) - wallet, amount, "100% returned on the real token");
        assertEq(pm.owedOf(player), 0);
    }

    function _fund(address token, address to, uint256 amount) internal {
        (bool minted,) = token.call(abi.encodeWithSignature("mint(address,uint256)", to, amount));
        if (minted && IERC20(token).balanceOf(to) >= amount) return;
        deal(token, to, amount);
        if (IERC20(token).balanceOf(to) >= amount) return;
        // Paxos USDG is a proxy. Search a holder by trying storage slots is out of scope; fail with the balance.
        assertGe(IERC20(token).balanceOf(to), amount, "could not obtain real USDG on this fork");
    }
}
