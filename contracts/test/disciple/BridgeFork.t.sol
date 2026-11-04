// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {Disciple} from "../../src/disciple/Disciple.sol";
import {DiscipleBridgeSender, IInbox} from "../../src/disciple/routes/DiscipleBridgeSender.sol";
import {ILzRead} from "../../src/bridge/interfaces/ILzRead.sol";
import {MockERC20} from "../bridge/mocks/BridgeMocks.sol";

/// @notice Two-fork test of the Ethereum -> Robinhood Chain price push through Robinhood's own bridge, end to end
///         with one payload:
///           1. Robinhood fork: deploy the hook and a bridge-priced pool first, so the real hook address and pool id
///              are known.
///           2. Ethereum fork: a keeper pushes with exactly those values into Robinhood's real delayed inbox. The
///              test reads the ticket back out of the inbox's own InboxMessageDelivered event (and checks its hash
///              against the bridge's MessageDelivered record), so the bytes are what the rollup will execute.
///           3. Robinhood fork: those bytes, unchanged, are executed from the sender's alias (what the retryable
///              auto-redeem does). Asserts: price accepted, keeper refunded the net cost * 1.2, replay ignored.
///         Initialization and outage recovery are checked separately: first price after a 5-minute delivery opens
///         the pool; in local mode a delivery 21 minutes after observation is refused and one at 19 minutes recovers
///         (bridge routes use a 20-minute recovery window; lzRead uses 120 seconds).
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
    bytes32 internal constant INBOX_MSG = keccak256("InboxMessageDelivered(uint256,bytes)");
    bytes32 internal constant BRIDGE_MSG =
        keccak256("MessageDelivered(uint256,bytes32,address,uint8,address,bytes32,uint256,uint64)");
    uint256 internal constant L2_GAS_LIMIT = 1_500_000;
    uint256 internal constant L2_MAX_FEE = 0.1 gwei;

    /// @dev One ticket as the inbox recorded it.
    struct Ticket {
        address to;
        uint256 deposit;
        uint256 maxSubmissionCost;
        address excessRefundTo;
        address callValueRefundTo;
        uint256 gasLimit;
        uint256 maxFeePerGas;
        bytes data;
        uint64 observedAt;
        uint256 ethGas; // measured gas of the keeper's push on Ethereum
        uint256 ethBasefee;
    }

    uint256 eth;
    uint256 rh;
    address pair;
    DiscipleBridgeSender sender;
    Disciple hook;
    PoolKey key;
    PoolId pid;
    MockERC20 coin;
    MockERC20 quote;
    PoolSwapTest swapper;
    address keeper;

    function test_fork_pushEthereumToRobinhood() public {
        string memory ethRpc = vm.envOr("FORK_RPC_ETH", string(""));
        string memory rhRpc = vm.envOr("FORK_RPC_RH", string(""));
        if (bytes(ethRpc).length == 0 || bytes(rhRpc).length == 0) return;
        pair = vm.envOr("BRIDGE_V2", address(0x8f1B19622a888c53C8eE4F7D7B4Dc8F574ff9068));
        eth = vm.createFork(ethRpc);
        rh = vm.createFork(rhRpc);
        keeper = makeAddr("keeper");

        // ---- 0. Ethereum: the sender (its address is the hook's constructor argument on Robinhood)
        vm.selectFork(eth);
        sender = new DiscipleBridgeSender(IInbox(RH_INBOX));
        vm.deal(keeper, 10 ether);
        (uint256 a, uint256 b) = sender.read(1, pair, bytes32(0));

        // ---- 1. Robinhood: hook and pool first, so the push can carry the real destination and pool id
        vm.selectFork(rh);
        _deployOnRobinhood();
        assertFalse(hook.poolState(pid).live);

        // ---- 2. Ethereum: push those exact values, read the ticket back out of the real inbox
        _syncEthClock(0); // the forks' clocks differ; observation time = Robinhood's now
        Ticket memory t = _pushOnEthereum();
        assertEq(t.to, address(hook), "ticket targets the real hook");
        assertEq(t.excessRefundTo, keeper, "unused fee refunds go to the keeper on Robinhood");
        assertEq(t.callValueRefundTo, keeper);
        assertEq(t.data.length, sender.DATA_LEN());
        _logCost(t);

        // ---- 3. Robinhood: execute the unchanged bytes from the alias, 5 minutes later
        vm.selectFork(rh);
        uint256 kb = keeper.balance;
        uint256 tank0 = hook.poolState(pid).tank;
        (bool ok, uint256 l2Gas) = _deliver(t, 5 minutes);
        assertTrue(ok, "ticket executes");
        // the opening push creates the pool's books and pays no refund, so BRIDGE_L2_GAS is not meant to cover it
        emit log_named_uint("rollup-side execution gas, opening push (not refunded)", l2Gas);
        Disciple.PoolView memory v = hook.poolState(pid);
        assertTrue(v.live, "initialization: first push opens the pool, 5 minutes after observation");
        assertEq(v.anchorX128, (b << 128) / a, "anchor = reserve1 / reserve0, as read on Ethereum");
        assertEq(v.ageOrBlock, 5 minutes);
        assertEq(keeper.balance, kb, "the opening price pays no refund");

        // ---- 3b. hourly heartbeat from Ethereum: accepted and reimbursed from the tank
        vm.warp(uint256(t.observedAt) + 59 minutes + 30);
        _syncEthClock(0);
        Ticket memory hb = _pushOnEthereum();
        vm.selectFork(rh);
        kb = keeper.balance;
        (ok, l2Gas) = _deliver(hb, 2 minutes);
        assertTrue(ok);
        emit log_named_uint("rollup-side execution gas, heartbeat (refunded)", l2Gas);
        assertLe(l2Gas, 150_000, "BRIDGE_L2_GAS covers a refunded delivery");
        assertEq(hook.poolState(pid).ageOrBlock, 2 minutes, "heartbeat accepted");
        uint256 cost = _carried(hb.data) + 150_000 * block.basefee;
        if (cost > 0.002 ether) cost = 0.002 ether;
        assertEq(keeper.balance - kb, cost * 12 / 10, "keeper refunded net cost * 1.2 on Robinhood");
        assertEq(tank0 - hook.poolState(pid).tank, cost * 12 / 10, "paid from the pool's tank");
        emit log_named_uint("Robinhood basefee (wei)", block.basefee);
        emit log_named_uint("refund paid on Robinhood (wei)", cost * 12 / 10);

        // replay: the same ticket executed again changes nothing and pays nothing
        kb = keeper.balance;
        uint256 tank1 = hook.poolState(pid).tank;
        (ok,) = _deliver(hb, 30);
        assertTrue(ok);
        assertEq(hook.poolState(pid).ageOrBlock, 2 minutes, "replay ignored");
        assertEq(keeper.balance, kb, "replay pays nothing");
        assertEq(hook.poolState(pid).tank, tank1);
        t = hb;

        // ---- 4. outage recovery, separately from initialization
        vm.warp(uint256(t.observedAt) + 2 hours + 1);
        _swapOnRobinhood();
        assertTrue(hook.poolState(pid).local, "no price for 2 hours: local mode");
        _syncEthClock(0);
        Ticket memory late = _pushOnEthereum();
        vm.selectFork(rh);
        (ok,) = _deliver(late, 21 minutes);
        assertTrue(ok);
        assertTrue(hook.poolState(pid).local, "21 minutes old on arrival: refused, still local");
        _syncEthClock(0);
        Ticket memory fresh = _pushOnEthereum();
        vm.selectFork(rh);
        (ok,) = _deliver(fresh, 19 minutes);
        assertTrue(ok);
        assertFalse(hook.poolState(pid).local, "19 minutes old on arrival: recovered");
    }

    // -----------------------------------------------------------------------------------------

    function _deployOnRobinhood() internal {
        IPoolManager m = IPoolManager(RH_POOL_MANAGER);
        coin = new MockERC20("COIN", "COIN", 18);
        quote = new MockERC20("WETH", "WETH", 18);
        bytes memory args = abi.encode(m, address(quote), ILzRead(address(0)), address(sender), address(0));
        hook = new Disciple{salt: _mine(args)}(m, address(quote), ILzRead(address(0)), address(sender), address(0));
        swapper = new PoolSwapTest(m);
        coin.mint(address(this), 1e30);
        quote.mint(address(this), 1e30);
        coin.approve(address(hook), type(uint256).max);
        quote.approve(address(hook), type(uint256).max);
        coin.approve(address(swapper), type(uint256).max);
        quote.approve(address(swapper), type(uint256).max);
        Disciple.Source memory s;
        s.kind = 1;
        s.coinIs0 = true; // the pair's token0 as the coin
        s.target = pair;
        s.remoteEid = hook.BRIDGE_EID();
        vm.deal(address(this), 1 ether);
        (key, pid) = hook.createPool{value: 0.01 ether}(
            Disciple.CreateParams({coin: address(coin), fee: 3000, src: s, coinIn: 1000e18, quoteIn: 1e29})
        );
    }

    function _pushOnEthereum() internal returns (Ticket memory t) {
        vm.selectFork(eth);
        uint256 sub = IInbox(RH_INBOX).calculateRetryableSubmissionFee(sender.DATA_LEN(), block.basefee) * 2;
        uint256 value = sub + L2_GAS_LIMIT * L2_MAX_FEE;
        vm.recordLogs();
        vm.prank(keeper);
        uint256 g = gasleft();
        sender.push{value: value}(address(hook), pid, 1, pair, bytes32(0), sub, L2_GAS_LIMIT, L2_MAX_FEE);
        t.ethGas = g - gasleft();
        t.ethBasefee = block.basefee;
        t.observedAt = uint64(block.timestamp);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes memory msgData;
        bytes32 bridgeHash;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 0) continue;
            if (logs[i].emitter == RH_INBOX && logs[i].topics[0] == INBOX_MSG) {
                msgData = abi.decode(logs[i].data, (bytes));
            } else if (logs[i].topics[0] == BRIDGE_MSG) {
                (address inbox, uint8 kind, address from, bytes32 h,,) =
                    abi.decode(logs[i].data, (address, uint8, address, bytes32, uint256, uint64));
                assertEq(inbox, RH_INBOX);
                assertEq(kind, 9, "L1MessageType_submitRetryableTx");
                assertEq(from, address(uint160(address(sender)) + ALIAS), "bridge records the aliased sender");
                bridgeHash = h;
            }
        }
        require(msgData.length > 9 * 32, "no InboxMessageDelivered");
        assertEq(keccak256(msgData), bridgeHash, "inbox payload is what the bridge accumulated");
        // Nitro Inbox packing: to, l2CallValue, deposit, maxSubmissionCost, excessFeeRefundAddress,
        // callValueRefundAddress, gasLimit, maxFeePerGas, data.length, data
        t.to = address(uint160(_word(msgData, 0)));
        assertEq(_word(msgData, 1), 0, "no call value");
        t.deposit = _word(msgData, 2);
        assertEq(t.deposit, value);
        t.maxSubmissionCost = _word(msgData, 3);
        t.excessRefundTo = address(uint160(_word(msgData, 4)));
        t.callValueRefundTo = address(uint160(_word(msgData, 5)));
        t.gasLimit = _word(msgData, 6);
        t.maxFeePerGas = _word(msgData, 7);
        uint256 len = _word(msgData, 8);
        t.data = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            t.data[i] = msgData[9 * 32 + i];
        }
    }

    /// @dev The rollup's auto-redeem: the ticket's own bytes, from the sender's alias, `delay` after observation.
    function _deliver(Ticket memory t, uint256 delay) internal returns (bool ok, uint256 gasUsed) {
        uint256 at = uint256(t.observedAt) + delay;
        if (at > block.timestamp) vm.warp(at);
        vm.prank(address(uint160(address(sender)) + ALIAS));
        uint256 g = gasleft();
        (ok,) = t.to.call{gas: t.gasLimit}(t.data);
        gasUsed = g - gasleft();
    }

    /// @dev Bring Ethereum's clock to Robinhood's (plus `ahead`), so an observation there is "now" here.
    function _syncEthClock(uint256 ahead) internal {
        uint256 now_ = block.timestamp + ahead;
        vm.selectFork(eth);
        if (now_ > block.timestamp) vm.warp(now_);
        vm.roll(block.number + 1);
    }

    function _swapOnRobinhood() internal {
        swapper.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: address(quote) < address(coin),
                amountSpecified: -int256(1e15),
                sqrtPriceLimitX96: address(quote) < address(coin) ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _carried(bytes memory data) internal pure returns (uint256 c) {
        // last of the 10 static words after the selector
        assembly {
            c := mload(add(data, add(32, add(4, mul(32, 9)))))
        }
    }

    function _word(bytes memory b, uint256 i) internal pure returns (uint256 w) {
        assembly {
            w := mload(add(b, add(32, mul(32, i))))
        }
    }

    function _logCost(Ticket memory t) internal {
        uint256 subFee = (1400 + 6 * t.data.length) * t.ethBasefee;
        emit log_named_uint("Ethereum basefee (wei)", t.ethBasefee);
        emit log_named_uint("keeper push gas on Ethereum (measured)", t.ethGas);
        emit log_named_uint("sender's PUSH_GAS estimate", sender.PUSH_GAS());
        emit log_named_uint("ticket prepaid (wei)", t.deposit);
        emit log_named_uint("  of which actually spent: submission fee (wei)", subFee);
        emit log_named_uint("  refunded to keeper on Robinhood: excess submission (wei)", t.maxSubmissionCost - subFee);
        emit log_named_uint("  L2 gas prepaid (wei), unused part refunded on Robinhood", t.gasLimit * t.maxFeePerGas);
        emit log_named_uint("net Ethereum-side cost (gas*basefee + submission fee)", t.ethGas * t.ethBasefee + subFee);
        emit log_named_uint("cost carried in the message", _carried(t.data));
        assertApproxEqRel(t.ethGas, sender.PUSH_GAS(), 0.35e18, "PUSH_GAS within 35% of the measured push");
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
