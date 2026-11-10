// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {_noKey} from "./NoKey.sol";
import {Test, Vm} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {DiscipleHook} from "../../src/hook/DiscipleHook.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {DisciplePushSender} from "../../src/hook/routes/DisciplePushSender.sol";
import {DisciplePushReceiver} from "../../src/hook/routes/DisciplePushReceiver.sol";
import {IDisciplePriceTarget} from "../../src/hook/routes/DiscipleSourceReader.sol";
import {ILayerZeroEndpointV2Lite, Origin} from "../../src/hook/routes/ILayerZeroEndpointV2Lite.sol";
import {DiscipleRoutesV0 as V0} from "../../src/hook/routes/DiscipleRoutesV0.sol";
import {DiscipleSelfExecutor} from "../../src/hook/routes/DiscipleSelfExecutor.sol";
import {LibConfig} from "../../src/hook/routes/ILayerZeroEndpointV2Lite.sol";

interface IEndpointFull {
    function defaultSendLibrary(uint32 eid) external view returns (address);
    function defaultReceiveLibrary(uint32 eid) external view returns (address);
    function getConfig(address oapp, address lib, uint32 eid, uint32 configType) external view returns (bytes memory);
    function lzReceive(Origin calldata o, address receiver, bytes32 guid, bytes calldata message, bytes calldata extra)
        external
        payable;
}

interface IReceiveUln {
    function verify(bytes calldata packetHeader, bytes32 payloadHash, uint64 confirmations) external;
    function commitVerification(bytes calldata packetHeader, bytes32 payloadHash) external;
}

/// @notice Two-fork test of the v0 Ethereum -> Robinhood LayerZero push, on the real endpoints and libraries:
///           Ethereum: DisciplePushSender with the v0 send config (live DVN set, 5 confirmations); a keeper pushes
///                     a real v2 source's state; the test captures the real PacketSent bytes.
///           Robinhood: DisciplePushReceiver with the matching receive config, beside a real DiscipleHook hook on the real
///                     PoolManager. The test acts as the Robinhood DVNs (verify on the real ReceiveUln302), commits,
///                     and executes through the real endpoint, unchanged bytes.
///         Asserts: config stored on both libraries; too few DVNs or too few confirmations cannot commit; the price
///         opens the pool; a heartbeat is refunded; the endpoint refuses a second execution.
///         Skips unless FORK_RPC_ETH and FORK_RPC_RH are set. Env: PUSH_V2 (Ethereum v2 pair; default JESUS/WETH)
struct UlnConfigLite {
    uint64 confirmations;
    uint8 requiredDVNCount;
    uint8 optionalDVNCount;
    uint8 optionalDVNThreshold;
    address[] requiredDVNs;
    address[] optionalDVNs;
}

contract PushForkTest is Test {
    bytes32 internal constant PACKET_SENT = keccak256("PacketSent(bytes,bytes,address)");
    address internal constant RH_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );
    uint128 internal constant RECEIVE_GAS = 600_000; // the opening price builds the pool's books (~490k)

    struct Packet {
        bytes header;
        bytes32 guid;
        bytes message;
        uint64 nonce;
        uint64 observedAt;
        uint256 fee;
        uint256 gas;
        uint256 basefee;
    }

    uint256 eth;
    uint256 rh;
    address pair;
    address keeper;
    DisciplePushSender sender;
    DisciplePushReceiver receiver;
    DiscipleHook hook;
    PoolId pid;
    address rhLib;
    bool lean;
    PoolSwapTest swapper;
    PoolKey key;
    address quoteToken;

    function test_fork_pushEthereumToRobinhoodLz() public {
        string memory ethRpc = vm.envOr("FORK_RPC_ETH", string(""));
        string memory rhRpc = vm.envOr("FORK_RPC_RH", string(""));
        if (bytes(ethRpc).length == 0 || bytes(rhRpc).length == 0) return;
        pair = vm.envOr("PUSH_V2", address(0x8f1B19622a888c53C8eE4F7D7B4Dc8F574ff9068));
        eth = vm.createFork(ethRpc);
        rh = vm.createFork(rhRpc);
        keeper = makeAddr("keeper");

        // ---- Ethereum: sender with the v0 config
        _select(eth);
        address ethLib = IEndpointFull(V0.ETH_ENDPOINT).defaultSendLibrary(V0.RH_EID);
        // live DVN set, zero-fee self-executor: the keeper commits and executes on Robinhood itself
        lean = keccak256(bytes(vm.envOr("PUSH_DVNS", string("live")))) == keccak256("lean");
        emit log_string(lean ? "DVN set: lean (2 required)" : "DVN set: live (2 + 2 of 3)");
        LibConfig[] memory cfg = _ethCfg(ethLib, address(new DiscipleSelfExecutor()), lean);
        sender = new DisciplePushSender(ILayerZeroEndpointV2Lite(V0.ETH_ENDPOINT), cfg, V0.sendGas(lean, true));
        assertEq(
            keccak256(IEndpointFull(V0.ETH_ENDPOINT).getConfig(address(sender), ethLib, V0.RH_EID, 2)),
            keccak256(_resolved(cfg[0].params[0].config)),
            "send config stored"
        );
        vm.deal(keeper, 10 ether);
        (uint256 a, uint256 b) = sender.read(1, pair, bytes32(0));

        // ---- Robinhood: receiver + hook + push pool
        _select(rh);
        _deployRobinhood();
        assertEq(
            keccak256(IEndpointFull(V0.RH_ENDPOINT).getConfig(address(receiver), rhLib, V0.ETH_EID, 2)),
            keccak256(_resolved(_rhCfg(rhLib)[0].params[0].config)),
            "receive config stored"
        );

        // ---- opening price
        _syncEthClock();
        Packet memory p = _push();
        emit log_named_uint("LayerZero fee, live DVNs + self-executor (wei)", p.fee);
        _select(rh);
        vm.warp(uint256(p.observedAt) + 75); // 5 blocks + DVN + executor
        _checkConfigIsEnforced(p);
        _verifyAndCommit(p, 5);
        uint256 g = gasleft();
        IEndpointFull(V0.RH_ENDPOINT).lzReceive(_origin(p), address(receiver), p.guid, p.message, "");
        emit log_named_uint("Robinhood execution gas, opening price", g - gasleft());
        DiscipleHook.PoolView memory v = hook.poolState(pid);
        assertTrue(v.live, "pushed price opens the pool");
        assertEq(v.anchorX128, (b << 128) / a, "anchor = reserve1 / reserve0, as read on Ethereum");
        assertEq(v.ageOrBlock, 75);

        // the endpoint will not execute the same packet twice
        vm.expectRevert();
        IEndpointFull(V0.RH_ENDPOINT).lzReceive(_origin(p), address(receiver), p.guid, p.message, "");

        // ---- a trade, then the heartbeat: paid from the pool's tip jar (an idle pool's heartbeat pays nothing)
        bool zf = Currency.unwrap(key.currency0) == quoteToken; // buy coin with quote
        swapper.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zf,
                amountSpecified: -int256(1e18),
                sqrtPriceLimitX96: zf ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.warp(uint256(p.observedAt) + 59 minutes + 30);
        _syncEthClock();
        Packet memory hb = _push();
        _select(rh);
        vm.warp(uint256(hb.observedAt) + 75);
        _verifyAndCommit(hb, 5);
        uint256 kb = hook.owed(keeper, quoteToken);
        address other = makeAddr("another keeper"); // takeover: delivery by someone other than the sender
        g = gasleft();
        vm.prank(other);
        IEndpointFull(V0.RH_ENDPOINT).lzReceive(_origin(hb), address(receiver), hb.guid, hb.message, "");
        emit log_named_uint("Robinhood execution gas, heartbeat", g - gasleft());
        assertEq(hook.owed(other, quoteToken), 0, "the deliverer is not paid; the sending keeper is");
        assertEq(hook.poolState(pid).ageOrBlock, 75, "heartbeat accepted");
        uint256 cost = _cost(hb.message) + (receiver.msgGas() + receiver.POOL_GAS()) * block.basefee;
        if (cost > 0.002 ether) cost = 0.002 ether;
        assertEq(
            hook.owed(keeper, quoteToken) - kb,
            cost * 12 / 10,
            "keeper credited (LZ fee + measured gas + RH delivery) * 1.2"
        );
        emit log_named_uint("cost carried (LZ fee + measured Ethereum gas)", _cost(hb.message));
        emit log_named_uint("Ethereum basefee (wei)", hb.basefee);
        emit log_named_uint("keeper push gas on Ethereum (measured by the test)", hb.gas);
        emit log_named_uint("refund paid on Robinhood (wei)", cost * 12 / 10);
    }

    // -----------------------------------------------------------------------------------------

    function _deployRobinhood() internal {
        IPoolManager m = IPoolManager(RH_POOL_MANAGER);
        rhLib = IEndpointFull(V0.RH_ENDPOINT).defaultReceiveLibrary(V0.ETH_EID);
        uint32[] memory eids = new uint32[](1);
        address[] memory senders = new address[](1);
        bool[] memory ethGas = new bool[](1);
        (eids[0], senders[0], ethGas[0]) = (V0.ETH_EID, address(sender), true);
        receiver = new DisciplePushReceiver(
            ILayerZeroEndpointV2Lite(V0.RH_ENDPOINT), eids, senders, ethGas, _rhCfg(rhLib), V0.destMsgGas(lean)
        );
        MockERC20 coin = new MockERC20("COIN", "COIN", 18);
        MockERC20 quote = new MockERC20("WETH", "WETH", 18);
        bytes memory args = abi.encode(
            m,
            address(receiver),
            address(0),
            address(0),
            address(quote), // the mock WETH is the chain's WETH here, so gas values 1:1 in the quote
            DiscipleHook.Config(10_000, address(0), 0, address(0), bytes32(0), false)
        );
        hook = new DiscipleHook{salt: _mine(args)}(
            m,
            address(receiver),
            address(0),
            address(0),
            address(quote), // the mock WETH is the chain's WETH here, so gas values 1:1 in the quote
            DiscipleHook.Config(10_000, address(0), 0, address(0), bytes32(0), false)
        );
        receiver.bind(IDisciplePriceTarget(address(hook)));
        coin.mint(address(this), 1e30);
        quote.mint(address(this), 1e30);
        coin.approve(address(hook), type(uint256).max);
        quote.approve(address(hook), type(uint256).max);
        DiscipleHook.Source memory s;
        s.kind = 1;
        s.coinIs0 = true;
        s.target = pair;
        s.remoteEid = V0.ETH_EID;
        s.push = true;
        vm.deal(address(this), 1 ether);
        swapper = new PoolSwapTest(m);
        coin.approve(address(swapper), type(uint256).max);
        quote.approve(address(swapper), type(uint256).max);
        quoteToken = address(quote);
        (key, pid) = hook.createPool(
            DiscipleHook.CreateParams({
                coin: address(coin),
                quote: address(quote),
                fee: 3000,
                src: s,
                coinIn: 1000e18,
                quoteIn: 1e29,
                srcKey: _noKey(),
                srcKey2: _noKey()
            })
        );
        hook.fundJar(pid, 0, 1 ether); // keeper tips come from the pool's jar
    }

    function _push() internal returns (Packet memory p) {
        _select(eth);
        bytes32 to = bytes32(uint256(uint160(address(receiver))));
        DisciplePushSender.Req[] memory r = _reqs(1, 1);
        r[0].pools[0] = pid;
        p.fee = sender.quote(V0.RH_EID, to, r, RECEIVE_GAS);
        vm.recordLogs();
        vm.prank(keeper);
        uint256 g = gasleft();
        sender.push{value: p.fee}(V0.RH_EID, to, r, RECEIVE_GAS);
        p.gas = g - gasleft();
        p.basefee = block.basefee;
        p.observedAt = uint64(vm.getBlockTimestamp());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes memory packet;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == V0.ETH_ENDPOINT && logs[i].topics.length > 0 && logs[i].topics[0] == PACKET_SENT) {
                (packet,,) = abi.decode(logs[i].data, (bytes, bytes, address));
            }
        }
        require(packet.length > 113, "no PacketSent");
        // PacketV1: version(1) nonce(8) srcEid(4) sender(32) dstEid(4) receiver(32) | guid(32) | message
        p.header = new bytes(81);
        for (uint256 i = 0; i < 81; i++) {
            p.header[i] = packet[i];
        }
        p.message = new bytes(packet.length - 113);
        for (uint256 i = 0; i < p.message.length; i++) {
            p.message[i] = packet[113 + i];
        }
        bytes32 guid;
        uint64 nonce;
        assembly {
            guid := mload(add(packet, add(32, 81)))
            nonce := shr(192, mload(add(packet, 33)))
        }
        (p.guid, p.nonce) = (guid, nonce);
    }

    /// @dev Too few DVNs, or too few confirmations, cannot commit: the v0 config is what decides.
    function _checkConfigIsEnforced(Packet memory p) internal {
        bytes32 h = keccak256(abi.encodePacked(p.guid, p.message));
        (address[] memory req,,) = _rhDvns();
        uint256 snap = vm.snapshotState();
        // live: required only (optional threshold not met); lean: one of the two required missing
        for (uint256 i = 0; i < (lean ? 1 : req.length); i++) {
            vm.prank(req[i]);
            IReceiveUln(rhLib).verify(p.header, h, 5);
        }
        vm.expectRevert();
        IReceiveUln(rhLib).commitVerification(p.header, h);
        vm.revertToState(snap);
        snap = vm.snapshotState();
        _verifyAs(p, 4);
        vm.expectRevert(); // 4 < 5 confirmations
        IReceiveUln(rhLib).commitVerification(p.header, h);
        vm.revertToState(snap);
    }

    function _verifyAndCommit(Packet memory p, uint64 conf) internal {
        _verifyAs(p, conf);
        IReceiveUln(rhLib).commitVerification(p.header, keccak256(abi.encodePacked(p.guid, p.message)));
    }

    function _verifyAs(Packet memory p, uint64 conf) internal {
        bytes32 h = keccak256(abi.encodePacked(p.guid, p.message));
        (address[] memory req, address[] memory opt, uint8 th) = _rhDvns();
        for (uint256 i = 0; i < req.length; i++) {
            vm.prank(req[i]);
            IReceiveUln(rhLib).verify(p.header, h, conf);
        }
        for (uint256 i = 0; i < th; i++) {
            vm.prank(opt[i]);
            IReceiveUln(rhLib).verify(p.header, h, conf);
        }
    }

    function _origin(Packet memory p) internal view returns (Origin memory) {
        return Origin(V0.ETH_EID, bytes32(uint256(uint160(address(sender)))), p.nonce);
    }

    function _syncEthClock() internal {
        uint256 now_ = vm.getBlockTimestamp();
        _select(eth);
        if (now_ > vm.getBlockTimestamp()) vm.warp(now_);
        vm.roll(block.number + 1);
    }

    function _cost(bytes memory message) internal pure returns (uint256 c) {
        (,, c) = abi.decode(message, (uint64, address, uint256));
    }

    function _ethCfg(address lib, address executor, bool lean) internal pure returns (LibConfig[] memory) {
        (address[] memory req, address[] memory opt, uint8 th) = lean ? V0.ethLeanDvns() : V0.ethLiveDvns();
        return V0.ethSend(lib, executor, req, opt, th);
    }

    function _rhCfg(address lib) internal view returns (LibConfig[] memory) {
        (address[] memory req, address[] memory opt, uint8 th) = _rhDvns();
        return V0.rhReceive(lib, req, opt, th);
    }

    function _rhDvns() internal view returns (address[] memory, address[] memory, uint8) {
        return lean ? V0.rhLeanDvns() : V0.rhLiveDvns();
    }

    /// @dev `sources` copies of the v2 source, each listing `perSource` pool ids.
    function _reqs(uint256 sources, uint256 perSource) internal view returns (DisciplePushSender.Req[] memory r) {
        r = new DisciplePushSender.Req[](sources);
        for (uint256 i = 0; i < sources; i++) {
            r[i].kind = 1;
            r[i].target = pair;
            r[i].pools = new PoolId[](perSource);
            for (uint256 j = 0; j < perSource; j++) {
                r[i].pools[j] = PoolId.wrap(keccak256(abi.encode(i, j)));
            }
        }
    }

    /// @notice Ethereum only: what one message costs, by DVN set, executor, and batch size. For each it quotes the
    ///         LayerZero fee and executes a real send, measuring the keeper's Ethereum gas. Logs a matrix; asserts
    ///         only that the sender's own gas estimate is not below the measured gas.
    function test_fork_quoteMatrix() public {
        string memory ethRpc = vm.envOr("FORK_RPC_ETH", string(""));
        if (bytes(ethRpc).length == 0) return;
        pair = vm.envOr("PUSH_V2", address(0x8f1B19622a888c53C8eE4F7D7B4Dc8F574ff9068));
        vm.createSelectFork(ethRpc);
        vm.fee(block.basefee); // see _select
        keeper = makeAddr("keeper");
        vm.deal(keeper, 100 ether);
        address lib = IEndpointFull(V0.ETH_ENDPOINT).defaultSendLibrary(V0.RH_EID);
        address self = address(new DiscipleSelfExecutor());
        bytes32 to = bytes32(uint256(0xD15C1));
        emit log_named_uint("Ethereum basefee (wei)", block.basefee);
        uint8[3] memory sizes = [uint8(1), 5, 10];
        for (uint256 c = 0; c < 4; c++) {
            bool lean = c >= 2;
            address ex = c % 2 == 1 ? self : address(0);
            DisciplePushSender s = new DisciplePushSender(
                ILayerZeroEndpointV2Lite(V0.ETH_ENDPOINT), _ethCfg(lib, ex, lean), V0.sendGas(lean, ex != address(0))
            );
            emit log_string(string.concat(
                    "---- DVNs ",
                    lean ? "lean (2 required)" : "live (2 + 2 of 3)",
                    ", executor ",
                    ex == address(0) ? "LayerZero (paid)" : "self (zero fee)"
                ));
            // one warm-up message: a sender's first send also pays cold storage, which the estimate leaves out
            {
                DisciplePushSender.Req[] memory w = _reqs(1, 1);
                uint256 wf = s.quote(V0.RH_EID, to, w, 190_000);
                vm.prank(keeper);
                s.push{value: wf}(V0.RH_EID, to, w, 190_000);
                vm.roll(block.number + 1);
            }
            for (uint256 k = 0; k < 3; k++) {
                DisciplePushSender.Req[] memory r = _reqs(sizes[k], 1);
                uint256 fee = s.quote(V0.RH_EID, to, r, uint128(100_000 + 90_000 * uint256(sizes[k])));
                vm.recordLogs();
                vm.prank(keeper);
                uint256 g = gasleft();
                s.push{value: fee}(V0.RH_EID, to, r, uint128(100_000 + 90_000 * uint256(sizes[k])));
                uint256 used = g - gasleft() + 21_000 + 16 * (4 + 32 * (6 + 7 * uint256(sizes[k])));
                uint256 carried = _pushedCost();
                emit log_named_uint(string.concat("  sources ", vm.toString(sizes[k]), ": LZ fee (wei)"), fee);
                emit log_named_uint(
                    string.concat("  sources ", vm.toString(sizes[k]), ": Ethereum gas (measured)"), used
                );
                emit log_named_uint(
                    string.concat("  sources ", vm.toString(sizes[k]), ": total per source (wei)"),
                    (fee + used * block.basefee) / sizes[k]
                );
                emit log_named_uint(
                    string.concat("  sources ", vm.toString(sizes[k]), ": carried gas / measured gas (bps)"),
                    (carried - fee) * 10_000 / (used * block.basefee)
                );
                // V0.sendGas is sized so the keeper is never under-refunded, and over-carried by at most 5%
                assertGe(carried, fee + used * block.basefee, "carried cost covers the measured cost");
                assertLe(carried, fee + used * block.basefee * 105 / 100, "carried cost within 5% of measured");
                vm.roll(block.number + 1);
            }
        }
    }

    /// @dev The library stores an empty optional set as NIL (255) but getConfig reads it back as 0 optional DVNs.
    function _resolved(bytes memory raw) internal pure returns (bytes memory) {
        UlnConfigLite memory c = abi.decode(raw, (UlnConfigLite));
        if (c.optionalDVNCount == type(uint8).max) c.optionalDVNCount = 0;
        if (c.requiredDVNCount == type(uint8).max) c.requiredDVNCount = 0;
        return abi.encode(c);
    }

    function _pushedCost() internal returns (uint256 c) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 t = keccak256("Pushed(uint32,bytes32,uint256,uint256,uint256,address)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == t) {
                (,,, c) = abi.decode(logs[i].data, (bytes32, uint256, uint256, uint256));
            }
        }
    }

    function _mine(bytes memory args) internal view returns (bytes32) {
        bytes32 initHash = keccak256(abi.encodePacked(type(DiscipleHook).creationCode, args));
        for (uint256 i = 0; i < 3_000_000; i++) {
            address x = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(i), initHash))))
            );
            if (uint160(x) & Hooks.ALL_HOOK_MASK == FLAGS) return bytes32(i);
        }
        revert("no salt");
    }

    receive() external payable {}

    /// @dev Select a fork and pin its basefee. Foundry 1.9.0 shows a forked block's basefee to the test contract and to
    ///      view calls but gives state-changing calls a basefee of 0 unless vm.fee sets it (test/hook/BasefeeDiag).
    ///      The sender and the hook price gas at block.basefee, so without the pin their gas refunds come out 0.
    function _select(uint256 fork) internal {
        vm.selectFork(fork);
        vm.fee(block.basefee);
    }
}
