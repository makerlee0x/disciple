// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

contract BasefeeReader {
    uint256 public last;

    function view_() external view returns (uint256) {
        return block.basefee;
    }

    function write() external returns (uint256) {
        last = block.basefee;
        return last;
    }

    function nested(BasefeeReader other) external returns (uint256) {
        return other.write();
    }
}

/// @notice Diagnostic only: shows which block.basefee each kind of call sees in this Foundry version, on an
///         Ethereum fork. Skips unless FORK_RPC_ETH is set.
contract BasefeeDiagTest is Test {
    function test_fork_basefeeSeenByCalls() public {
        string memory rpc = vm.envOr("FORK_RPC_ETH", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        BasefeeReader a = new BasefeeReader();
        BasefeeReader b = new BasefeeReader();
        emit log_named_uint("1 test contract block.basefee", block.basefee);
        emit log_named_uint("2 tx.gasprice", tx.gasprice);
        emit log_named_uint("3 view call", a.view_());
        emit log_named_uint("4 state-changing call", a.write());
        emit log_named_uint("5 nested call", a.nested(b));
        vm.prank(address(0xBEEF));
        emit log_named_uint("6 view call under prank", a.view_());
        vm.prank(address(0xBEEF));
        emit log_named_uint("7 state-changing call under prank", a.write());
        vm.prank(address(0xBEEF));
        emit log_named_uint("8 nested call under prank", a.nested(b));
        vm.warp(block.timestamp + 3600);
        vm.roll(block.number + 1);
        emit log_named_uint("9 after warp+roll, test contract", block.basefee);
        emit log_named_uint("10 after warp+roll, state-changing call", a.write());
        uint256 bf = block.basefee;
        vm.txGasPrice(bf);
        emit log_named_uint("11 after txGasPrice(basefee), state-changing call", a.write());
        vm.prank(address(0xBEEF));
        emit log_named_uint("12 after txGasPrice, call under prank", a.write());

        // fork switching, as the push tests do
        string memory rh = vm.envOr("FORK_RPC_RH", string(""));
        if (bytes(rh).length == 0) return;
        uint256 eth = vm.activeFork();
        uint256 r = vm.createSelectFork(rh);
        BasefeeReader c = new BasefeeReader();
        emit log_named_uint("13 RH fork, test contract", block.basefee);
        emit log_named_uint("14 RH fork, state-changing call", c.write());
        vm.prank(address(0xBEEF));
        emit log_named_uint("15 RH fork, call under prank", c.write());
        vm.selectFork(eth);
        emit log_named_uint("16 back on ETH, test contract", block.basefee);
        emit log_named_uint("17 back on ETH, state-changing call", a.write());
        vm.prank(address(0xBEEF));
        emit log_named_uint("18 back on ETH, call under prank", a.write());
        vm.selectFork(r);
    }
}
