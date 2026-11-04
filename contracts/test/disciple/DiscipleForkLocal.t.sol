// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {MockERC20} from "../bridge/mocks/BridgeMocks.sol";
import {DiscipleForkTest, ForkDryRunPair} from "./DiscipleFork.t.sol";

contract LocalV2Factory {
    mapping(address => mapping(address => address)) public getPair;

    function set(address pair, address a, address b) external {
        (getPair[a][b], getPair[b][a]) = (pair, pair);
    }
}

/// @notice The fork test's whole pipeline (two-leg arbs, LP control, entitlement, drain-and-reconcile) against a
///         local v2 pair, so it runs without an RPC. The real-source evidence still comes from the fork runs.
contract DiscipleForkLocalTest is DiscipleForkTest {
    /// @dev 6-decimal quote (USDC-like): the case that exposed the ledger's old slide cut-off.
    function test_local_v2Pipeline() public {
        _local(6, 2_000_000e6);
    }

    /// @dev 18-decimal quote (WETH-like).
    function test_local_v2Pipeline18() public {
        _local(18, 600e18);
    }

    function _local(uint8 qd, uint256 quoteDepth) internal {
        IPoolManager m = IPoolManager(address(new PoolManager(address(this))));
        MockERC20 a = new MockERC20("COIN", "COIN", 18);
        MockERC20 b = new MockERC20("QUOTE", "QUOTE", qd);
        ForkDryRunPair pair = new ForkDryRunPair(address(a), address(b));
        a.mint(address(pair), 1_000_000e18);
        b.mint(address(pair), quoteDepth);
        pair.sync();
        LocalV2Factory f = new LocalV2Factory();
        f.set(address(pair), address(a), address(b));
        localV2Factory = address(f);
        PoolKey memory none;
        _run(m, Src({kind: 1, target: address(pair), v4Key: none, t0: address(a), t1: address(b)}), "local v2");
    }
}
