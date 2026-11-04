// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Disciple} from "../../src/disciple/Disciple.sol";
import {DiscipleBridgeSender, IInbox} from "../../src/disciple/DiscipleBridgeSender.sol";
import {ILzRead} from "../../src/bridge/interfaces/ILzRead.sol";
import {MockERC20} from "../bridge/mocks/BridgeMocks.sol";

interface IInboxFees {
    function calculateRetryableSubmissionFee(uint256 dataLength, uint256 baseFee) external view returns (uint256);
}

/// @notice Two-fork test of the Ethereum -> Robinhood Chain price push through Robinhood's own bridge.
///           Ethereum fork: the sender reads a real source and opens a real retryable ticket in Robinhood's
///                          delayed inbox (proves the inbox call, fees and payload).
///           Robinhood fork: that exact payload, delivered from the sender's alias (what the rollup does), opens a
///                          bridge-priced Disciple pool on the real PoolManager at the source's price.
///         Skips unless FORK_RPC_ETH and FORK_RPC_RH are set.
///         Env: FORK_RPC_ETH, FORK_RPC_RH, BRIDGE_V2 (an Ethereum v2 pair; default JESUS/WETH)
contract BridgeForkTest is Test {
    address internal constant RH_INBOX = 0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D;
    address internal constant RH_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    uint160 internal constant ALIAS = uint160(0x1111000000000000000000000000000000001111);
    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );

    function test_fork_pushEthereumToRobinhood() public {
        string memory ethRpc = vm.envOr("FORK_RPC_ETH", string(""));
        string memory rhRpc = vm.envOr("FORK_RPC_RH", string(""));
        if (bytes(ethRpc).length == 0 || bytes(rhRpc).length == 0) return;
        address pair = vm.envOr("BRIDGE_V2", address(0x8f1B19622a888c53C8eE4F7D7B4Dc8F574ff9068));
        uint256 eth = vm.createFork(ethRpc);
        uint256 rh = vm.createFork(rhRpc);

        // ---- Ethereum: a real push into Robinhood's delayed inbox
        vm.selectFork(eth);
        DiscipleBridgeSender sender = new DiscipleBridgeSender(IInbox(RH_INBOX));
        (uint256 a, uint256 b) = sender.read(1, pair, bytes32(0));
        address hookOnRh = address(0x1234); // payload content does not depend on the hook address
        PoolId id = PoolId.wrap(keccak256("pool"));
        uint256 dataLen = 4 + 32 * 9;
        uint256 sub = IInboxFees(RH_INBOX).calculateRetryableSubmissionFee(dataLen, block.basefee) * 2;
        uint256 gasLimit = 1_500_000;
        uint256 maxFee = 0.1 gwei;
        uint256 value = sub + gasLimit * maxFee;
        address keeper = makeAddr("keeper");
        vm.deal(keeper, 1 ether);
        vm.prank(keeper);
        uint256 g = gasleft();
        uint256 ticket = sender.push{value: value}(hookOnRh, id, 1, pair, bytes32(0), sub, gasLimit, maxFee);
        emit log_named_uint("push gas on Ethereum (approx)", g - gasleft());
        emit log_named_uint("ticket / message number", ticket);
        emit log_named_uint("ticket ETH paid (wei)", value);
        uint64 observedAt = uint64(block.timestamp);

        // ---- Robinhood: deliver the same payload from the sender's alias
        vm.selectFork(rh);
        IPoolManager m = IPoolManager(RH_POOL_MANAGER);
        MockERC20 coin = new MockERC20("COIN", "COIN", 18);
        MockERC20 quote = new MockERC20("WETH", "WETH", 18);
        bytes memory args = abi.encode(m, address(quote), ILzRead(address(0)), address(sender));
        Disciple hook = new Disciple{salt: _mine(args)}(m, address(quote), ILzRead(address(0)), address(sender));
        coin.mint(address(this), 1e30);
        quote.mint(address(this), 1e30);
        coin.approve(address(hook), type(uint256).max);
        quote.approve(address(hook), type(uint256).max);
        Disciple.Source memory s;
        s.kind = 1;
        s.coinIs0 = true; // a pair's token0 as the coin
        s.target = pair;
        s.remoteEid = hook.BRIDGE_EID();
        (, PoolId pid) = hook.createPool{value: 0.01 ether}(
            Disciple.CreateParams({coin: address(coin), fee: 3000, src: s, coinIn: 1000e18, quoteIn: 1e29})
        );
        if (observedAt > block.timestamp) vm.warp(observedAt); // the forks' clocks differ slightly
        vm.warp(block.timestamp + 300); // ~minutes of bridge delay
        vm.prank(address(uint160(address(sender)) + ALIAS));
        hook.onBridgePrice(pid, 1, pair, bytes32(0), a, b, observedAt, keeper, value);
        Disciple.PoolView memory v = hook.poolState(pid);
        assertTrue(v.live, "push opened the pool");
        assertEq(v.anchorX128, (b << 128) / a, "anchor = reserve1 / reserve0");
        emit log_named_uint("anchor X128", v.anchorX128);
    }

    function _mine(bytes memory args) internal view returns (bytes32) {
        bytes32 initHash = keccak256(abi.encodePacked(type(Disciple).creationCode, args));
        for (uint256 i = 0; i < 3_000_000; i++) {
            address x = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(i), initHash))))
            );
            if (uint160(x) & Hooks.ALL_HOOK_MASK == FLAGS) return bytes32(i);
        }
        revert("no salt");
    }

    receive() external payable {}
}
