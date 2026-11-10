// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {LaunchGateForkTest} from "./LaunchGateFork.t.sol";

/// @notice TRADE BACKTEST (read-only). For one past trade on our pool: fork Robinhood at BT_BLOCK (the block before
///         the trade) and execute the same input through the real Uniswap route (STRATEGY/MSTR x MSTR/USDG), then
///         print "BTROW,<block>,<srcMid x1e6>,<routeOut>" so script/hook/backtest-trades.sh can compare it with
///         what the trader got from us. Env: FORK_RPC_RH, BT_BLOCK, BT_BUY (true = USDG in), BT_IN (raw input).
contract TradeBacktestTest is LaunchGateForkTest {
    function test_fork_backtestTrade() public {
        string memory rpc = vm.envOr("FORK_RPC_RH", string(""));
        uint256 blk = vm.envOr("BT_BLOCK", uint256(0));
        if (bytes(rpc).length == 0 || blk == 0) {
            console2.log("backtest skipped, FORK_RPC_RH or BT_BLOCK unset");
            return;
        }
        vm.createSelectFork(rpc, blk);
        sw = new PoolSwapTest(PM);
        _fundAll(address(this));
        IERC20(STRATEGY).approve(address(sw), type(uint256).max);
        IERC20(USDG).approve(address(sw), type(uint256).max);
        IERC20(MSTR).approve(address(sw), type(uint256).max);

        uint256 mid = Math.mulDiv(_spot(), 1e18, Q128); // USDG raw per 1 STRATEGY = price x 1e6
        uint256 out = _srcOut(vm.envBool("BT_BUY"), vm.envUint("BT_IN"));
        console2.log(string.concat("BTROW,", vm.toString(blk), ",", vm.toString(mid), ",", vm.toString(out)));
    }
}
