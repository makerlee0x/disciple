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
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Disciple} from "../../src/disciple/Disciple.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {DisciplePushSender} from "../../src/disciple/routes/DisciplePushSender.sol";
import {DisciplePushReceiver} from "../../src/disciple/routes/DisciplePushReceiver.sol";
import {IDisciplePriceTarget} from "../../src/disciple/routes/DiscipleSourceReader.sol";
import {ILayerZeroEndpointV2Lite, Origin, LibConfig} from "../../src/disciple/routes/ILayerZeroEndpointV2Lite.sol";
import {DiscipleRoutesV0 as V0} from "../../src/disciple/routes/DiscipleRoutesV0.sol";
import {DiscipleSelfExecutor} from "../../src/disciple/routes/DiscipleSelfExecutor.sol";
import {IEndpointFull, IReceiveUln, UlnConfigLite} from "./PushFork.t.sol";

/// @notice Two-fork test of the v0 Robinhood -> Ethereum LayerZero push (the mirror of PushFork), on the real
///         endpoints and libraries. Forks only: nothing is deployed on a live chain (maker: no Ethereum deploy
///         before the audit).
///           Robinhood: DisciplePushSender with the rhSend config (20 confirmations, self-executor); a keeper pushes
///                      a real Robinhood v4 pool's state; the test captures the real PacketSent bytes.
///           Ethereum:  DisciplePushReceiver with the ethReceive config, bound to ONE combined Disciple hook on the
///                      real Ethereum PoolManager with the real v2 and v3 factories. The test acts as the Ethereum
///                      DVNs on the real ReceiveUln302, commits, and executes through the real endpoint.
///         Asserts: config stored on both libraries; too few DVNs or confirmations cannot commit; the price opens
///         the pool with the anchor read on Robinhood; a second execution is refused; a heartbeat after a trade is
///         refunded on Ethereum, to the sending keeper, whoever delivers.
///         Skips unless FORK_RPC_ETH and FORK_RPC_RH are set. Env: PUSH_DVNS=live|lean, PUSH_V4_RH (pool id).
contract PushForkReverseTest is Test {
    bytes32 internal constant PACKET_SENT = keccak256("PacketSent(bytes,bytes,address)");
    address internal constant RH_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant ETH_POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address internal constant ETH_V2_FACTORY = 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f;
    address internal constant ETH_V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );
    uint128 internal constant RECEIVE_GAS = 600_000;
    uint64 internal constant CONF = 20; // V0.RH_CONFIRMATIONS

    struct Packet {
        bytes header;
        bytes32 guid;
        bytes message;
        uint64 nonce;
        uint64 observedAt;
        uint256 fee;
        uint256 gas; // keeper's whole Robinhood transaction: execution + 21k + calldata
        uint256 basefee; // Robinhood basefee at the push
    }

    uint256 eth;
    uint256 rh;
    bytes32 v4Id;
    address keeper;
    DisciplePushSender sender;
    DisciplePushReceiver receiver;
    Disciple hook;
    PoolId pid;
    address ethLib;
    bool lean;
    PoolSwapTest swapper;
    PoolKey key;
    address quoteToken;
    mapping(bytes32 => address) quoteOf;

    function test_fork_pushRobinhoodToEthereumLz() public {
        string memory ethRpc = vm.envOr("FORK_RPC_ETH", string(""));
        string memory rhRpc = vm.envOr("FORK_RPC_RH", string(""));
        if (bytes(ethRpc).length == 0 || bytes(rhRpc).length == 0) return;
        v4Id = vm.envOr("PUSH_V4_RH", bytes32(0xa6975f4720a95aa9cdfa9b010a065b0e941534c93f9fa708104c08f0ac029ca0));
        eth = vm.createFork(ethRpc);
        rh = vm.createFork(rhRpc);
        keeper = makeAddr("keeper");
        lean = keccak256(bytes(vm.envOr("PUSH_DVNS", string("live")))) == keccak256("lean");
        emit log_string(lean ? "DVN set: lean (2 required)" : "DVN set: live (2 + 2 of 3)");

        // ---- Robinhood: sender with the rhSend config, zero-fee self-executor
        _select(rh);
        address rhLib = IEndpointFull(V0.RH_ENDPOINT).defaultSendLibrary(V0.ETH_EID);
        (address[] memory req, address[] memory opt, uint8 th) = lean ? V0.rhLeanDvns() : V0.rhLiveDvns();
        LibConfig[] memory cfg = V0.rhSend(rhLib, address(new DiscipleSelfExecutor()), req, opt, th);
        sender = new DisciplePushSender(ILayerZeroEndpointV2Lite(V0.RH_ENDPOINT), cfg, V0.sendGas(lean, true));
        assertEq(
            keccak256(IEndpointFull(V0.RH_ENDPOINT).getConfig(address(sender), rhLib, V0.ETH_EID, 2)),
            keccak256(_resolved(cfg[0].params[0].config)),
            "send config stored"
        );
        vm.deal(keeper, 10 ether);
        (uint256 a,) = sender.read(3, RH_POOL_MANAGER, v4Id);

        // ---- Ethereum: receiver + combined hook + a pool priced off the Robinhood source
        _select(eth);
        _deployEthereum();
        assertEq(
            keccak256(IEndpointFull(V0.ETH_ENDPOINT).getConfig(address(receiver), ethLib, V0.RH_EID, 2)),
            keccak256(_resolved(_ethCfg()[0].params[0].config)),
            "receive config stored"
        );
        assertEq(hook.v2Factory(), ETH_V2_FACTORY, "combined hook keeps v2 sources");
        assertEq(hook.v3Factory(), ETH_V3_FACTORY, "combined hook keeps v3 sources");

        // ---- opening price
        _syncRhClock();
        Packet memory p = _push();
        emit log_named_uint("LayerZero fee on Robinhood (wei)", p.fee);
        _select(eth);
        vm.warp(uint256(p.observedAt) + 30); // 20 Robinhood blocks + DVNs + keeper
        _checkConfigIsEnforced(p);
        _verifyAndCommit(p, CONF);
        uint256 g = gasleft();
        IEndpointFull(V0.ETH_ENDPOINT).lzReceive(_origin(p), address(receiver), p.guid, p.message, "");
        emit log_named_uint("Ethereum execution gas, opening price", g - gasleft());
        Disciple.PoolView memory v = hook.poolState(pid);
        assertTrue(v.live, "pushed price opens the pool");
        assertEq(v.anchorX128, Math.mulDiv(a, a, 1 << 64), "anchor = sqrtP^2 as read on Robinhood");
        assertEq(v.ageOrBlock, 30);

        vm.expectRevert(); // the endpoint will not execute the same packet twice
        IEndpointFull(V0.ETH_ENDPOINT).lzReceive(_origin(p), address(receiver), p.guid, p.message, "");

        // ---- a trade, then the heartbeat: refunded on Ethereum from the pool's tank
        bool zf = Currency.unwrap(key.currency0) == quoteToken;
        swapper.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zf,
                // ~0.06% of the quote reserve. A trade under ~1e-15 of the reserves rounds to zero output (the curve's
                // LN_SLACK) and reverts ZeroOutput, which is what the old 1e6-vs-1e36 sizing hit.
                amountSpecified: -int256(1e16),
                sqrtPriceLimitX96: zf ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.warp(uint256(p.observedAt) + 59 minutes + 30);
        _syncRhClock();
        Packet memory hb = _push();
        _select(eth);
        vm.warp(uint256(hb.observedAt) + 30);
        _verifyAndCommit(hb, CONF);
        uint256 kb = keeper.balance;
        address other = makeAddr("another keeper");
        g = gasleft();
        vm.prank(other);
        IEndpointFull(V0.ETH_ENDPOINT).lzReceive(_origin(hb), address(receiver), hb.guid, hb.message, "");
        emit log_named_uint("Ethereum execution gas, heartbeat", g - gasleft());
        assertEq(other.balance, 0, "the deliverer is not paid; the sending keeper is");
        assertEq(hook.poolState(pid).ageOrBlock, 30, "heartbeat accepted");
        uint256 cost = _cost(hb.message) + (receiver.msgGas() + receiver.POOL_GAS()) * block.basefee;
        if (cost > 0.002 ether) cost = 0.002 ether;
        assertEq(keeper.balance - kb, cost * 12 / 10, "keeper refunded (LZ fee + Robinhood gas + ETH delivery) * 1.2");
        emit log_named_uint("cost carried from Robinhood (LZ fee + measured gas)", _cost(hb.message));
        emit log_named_uint("keeper push gas on Robinhood", hb.gas);
        emit log_named_uint("Ethereum basefee (wei)", block.basefee);
        emit log_named_uint("refund paid on Ethereum (wei)", cost * 12 / 10);
    }

    /// @notice The keeper's whole expense for a heartbeat to k pools in one message, against what the pools pay back:
    ///         Robinhood push transaction + LayerZero fee + Ethereum commitVerification transaction + Ethereum
    ///         lzReceive transaction (separate transactions, each with its 21k and calldata), all at basefee.
    ///         DVN verification is paid by the DVNs (inside the LayerZero fee), so the test's own verify calls are
    ///         not keeper expense. Asserts payout >= expense * 1.2 (the keeper margin) and <= expense * 1.2 * 1.03.
    function test_fork_destinationCost() public {
        string memory ethRpc = vm.envOr("FORK_RPC_ETH", string(""));
        string memory rhRpc = vm.envOr("FORK_RPC_RH", string(""));
        if (bytes(ethRpc).length == 0 || bytes(rhRpc).length == 0) return;
        v4Id = vm.envOr("PUSH_V4_RH", bytes32(0xa6975f4720a95aa9cdfa9b010a065b0e941534c93f9fa708104c08f0ac029ca0));
        eth = vm.createFork(ethRpc);
        rh = vm.createFork(rhRpc);
        keeper = makeAddr("keeper");
        lean = keccak256(bytes(vm.envOr("PUSH_DVNS", string("live")))) == keccak256("lean");
        emit log_string(lean ? "DVN set: lean (2 required)" : "DVN set: live (2 + 2 of 3)");
        _select(rh);
        address rhLib = IEndpointFull(V0.RH_ENDPOINT).defaultSendLibrary(V0.ETH_EID);
        (address[] memory req, address[] memory opt, uint8 th) = lean ? V0.rhLeanDvns() : V0.rhLiveDvns();
        sender = new DisciplePushSender(
            ILayerZeroEndpointV2Lite(V0.RH_ENDPOINT),
            V0.rhSend(rhLib, address(new DiscipleSelfExecutor()), req, opt, th),
            V0.sendGas(lean, true)
        );
        vm.deal(keeper, 10 ether);
        _select(eth);
        _deployEthereum();
        PoolKey[] memory keys = new PoolKey[](10);
        PoolId[] memory ids = new PoolId[](10);
        (keys[0], ids[0]) = (key, pid);
        for (uint256 i = 1; i < 10; i++) {
            (keys[i], ids[i]) = _addPool();
        }

        // opening price for all ten, then a trade in each, so every pool owes its heartbeat
        _syncRhClock();
        Packet memory p = _push(ids);
        _select(eth);
        vm.warp(uint256(p.observedAt) + 30);
        _verifyAndCommit(p, CONF);
        IEndpointFull(V0.ETH_ENDPOINT).lzReceive(_origin(p), address(receiver), p.guid, p.message, "");
        for (uint256 i = 0; i < 10; i++) {
            assertTrue(hook.poolState(ids[i]).live, "opened");
            _trade(keys[i], ids[i]);
        }
        vm.warp(uint256(p.observedAt) + 59 minutes + 30);
        _syncRhClock();
        uint256 snap = vm.snapshotState();

        uint8[3] memory sizes = [uint8(1), 5, 10];
        for (uint256 r = 0; r < 3; r++) {
            vm.revertToState(snap);
            uint256 k = sizes[r];
            PoolId[] memory list = new PoolId[](k);
            for (uint256 i = 0; i < k; i++) {
                list[i] = ids[i];
            }
            Packet memory hb = _push(list);
            _select(eth);
            vm.warp(uint256(hb.observedAt) + 30);
            _verifyAs(hb, CONF);
            uint256 kb = keeper.balance;
            bytes32 h = keccak256(abi.encodePacked(hb.guid, hb.message));
            vm.prank(keeper);
            uint256 g = gasleft();
            IReceiveUln(ethLib).commitVerification(hb.header, h);
            uint256 commitGas =
                g - gasleft() + 21_000 + _calldataGas(abi.encodeCall(IReceiveUln.commitVerification, (hb.header, h)));
            vm.prank(keeper);
            g = gasleft();
            IEndpointFull(V0.ETH_ENDPOINT).lzReceive(_origin(hb), address(receiver), hb.guid, hb.message, "");
            uint256 execGas = g - gasleft() + 21_000
                + _calldataGas(
                    abi.encodeCall(IEndpointFull.lzReceive, (_origin(hb), address(receiver), hb.guid, hb.message, ""))
                );
            uint256 paid = keeper.balance - kb; // gas is not charged to balances in the test, only refunds land
            uint256 expense = hb.fee + hb.gas * hb.basefee + (commitGas + execGas) * block.basefee;
            string memory tag = string.concat("  pools ", vm.toString(k), ": ");
            emit log_named_uint(string.concat(tag, "Robinhood push tx gas"), hb.gas);
            emit log_named_uint(string.concat(tag, "Ethereum commit tx gas"), commitGas);
            emit log_named_uint(string.concat(tag, "Ethereum lzReceive tx gas"), execGas);
            emit log_named_uint(string.concat(tag, "keeper expense (wei)"), expense);
            emit log_named_uint(string.concat(tag, "paid back to keeper (wei)"), paid);
            emit log_named_uint(string.concat(tag, "payout / expense (bps)"), paid * 10_000 / expense);
            assertGe(paid * 10, expense * 12, "keeper paid its whole expense + 20%");
            assertLe(paid * 1000, expense * 1236, "and at most 3% more than that");
        }
        emit log_named_uint("Ethereum basefee (wei)", block.basefee);
    }

    function _calldataGas(bytes memory data) internal pure returns (uint256 g) {
        for (uint256 i = 0; i < data.length; i++) {
            g += data[i] == 0 ? 4 : 16;
        }
    }

    // -----------------------------------------------------------------------------------------

    function _deployEthereum() internal {
        IPoolManager m = IPoolManager(ETH_POOL_MANAGER);
        ethLib = IEndpointFull(V0.ETH_ENDPOINT).defaultReceiveLibrary(V0.RH_EID);
        uint32[] memory eids = new uint32[](1);
        address[] memory senders = new address[](1);
        bool[] memory ethGas = new bool[](1);
        (eids[0], senders[0], ethGas[0]) = (V0.RH_EID, address(sender), true);
        receiver =
            new DisciplePushReceiver(
            ILayerZeroEndpointV2Lite(V0.ETH_ENDPOINT), eids, senders, ethGas, _ethCfg(), V0.destMsgGas(lean)
        );
        bytes memory args = abi.encode(m, address(receiver), ETH_V2_FACTORY, ETH_V3_FACTORY, address(0));
        hook = new Disciple{salt: _mine(args)}(m, address(receiver), ETH_V2_FACTORY, ETH_V3_FACTORY, address(0));
        receiver.bind(IDisciplePriceTarget(address(hook)));
        vm.deal(address(this), 10 ether);
        swapper = new PoolSwapTest(m);
        (key, pid) = _addPool();
        quoteToken = quoteOf[PoolId.unwrap(pid)];
    }

    /// @dev A Disciple pool on Ethereum priced off the Robinhood source, with its own coin and quote tokens.
    function _addPool() internal returns (PoolKey memory k, PoolId id) {
        MockERC20 coin = new MockERC20("COIN", "COIN", 18);
        MockERC20 quote = new MockERC20("USDG", "USDG", 6);
        coin.mint(address(this), 1e40);
        quote.mint(address(this), 1e40);
        coin.approve(address(hook), type(uint256).max);
        quote.approve(address(hook), type(uint256).max);
        coin.approve(address(swapper), type(uint256).max);
        quote.approve(address(swapper), type(uint256).max);
        Disciple.Source memory s;
        s.kind = 3; // v4 on Robinhood
        s.coinIs0 = true;
        s.target = RH_POOL_MANAGER;
        s.v4Id = v4Id;
        s.remoteEid = V0.RH_EID;
        s.push = true;
        (k, id) = hook.createPool{value: 0.05 ether}(
            Disciple.CreateParams({coin: address(coin), quote: address(quote), fee: 3000, src: s, coinIn: 1e24, quoteIn: 1e20, srcKey: _noKey(), srcKey2: _noKey()})
        );
        quoteOf[PoolId.unwrap(id)] = address(quote);
    }

    /// @dev Buy coin with ~0.06% of the quote reserve.
    function _trade(PoolKey memory k, PoolId id) internal {
        bool zf = Currency.unwrap(k.currency0) == quoteOf[PoolId.unwrap(id)];
        swapper.swap(
            k,
            IPoolManager.SwapParams({
                zeroForOne: zf,
                amountSpecified: -int256(1e16),
                sqrtPriceLimitX96: zf ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _push() internal returns (Packet memory p) {
        PoolId[] memory list = new PoolId[](1);
        list[0] = pid;
        return _push(list);
    }

    function _push(PoolId[] memory list) internal returns (Packet memory p) {
        _select(rh);
        bytes32 to = bytes32(uint256(uint160(address(receiver))));
        DisciplePushSender.Req[] memory r = new DisciplePushSender.Req[](1);
        r[0].kind = 3;
        r[0].target = RH_POOL_MANAGER;
        r[0].v4Id = v4Id;
        r[0].pools = list;
        p.fee = sender.quote(V0.ETH_EID, to, r, RECEIVE_GAS);
        vm.recordLogs();
        vm.prank(keeper);
        uint256 g = gasleft();
        sender.push{value: p.fee}(V0.ETH_EID, to, r, RECEIVE_GAS);
        p.gas = g - gasleft() + 21_000 + _calldataGas(abi.encodeCall(DisciplePushSender.push, (V0.ETH_EID, to, r, RECEIVE_GAS)));
        p.basefee = block.basefee;
        p.observedAt = uint64(vm.getBlockTimestamp());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes memory packet;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == V0.RH_ENDPOINT && logs[i].topics.length > 0 && logs[i].topics[0] == PACKET_SENT) {
                (packet,,) = abi.decode(logs[i].data, (bytes, bytes, address));
            }
        }
        require(packet.length > 113, "no PacketSent");
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

    function _checkConfigIsEnforced(Packet memory p) internal {
        bytes32 h = keccak256(abi.encodePacked(p.guid, p.message));
        (address[] memory req,,) = _ethDvns();
        uint256 snap = vm.snapshotState();
        for (uint256 i = 0; i < (lean ? 1 : req.length); i++) {
            vm.prank(req[i]);
            IReceiveUln(ethLib).verify(p.header, h, CONF);
        }
        vm.expectRevert();
        IReceiveUln(ethLib).commitVerification(p.header, h);
        vm.revertToState(snap);
        snap = vm.snapshotState();
        _verifyAs(p, CONF - 1);
        vm.expectRevert(); // 19 < 20 confirmations
        IReceiveUln(ethLib).commitVerification(p.header, h);
        vm.revertToState(snap);
    }

    function _verifyAndCommit(Packet memory p, uint64 conf) internal {
        _verifyAs(p, conf);
        IReceiveUln(ethLib).commitVerification(p.header, keccak256(abi.encodePacked(p.guid, p.message)));
    }

    function _verifyAs(Packet memory p, uint64 conf) internal {
        bytes32 h = keccak256(abi.encodePacked(p.guid, p.message));
        (address[] memory req, address[] memory opt, uint8 th) = _ethDvns();
        for (uint256 i = 0; i < req.length; i++) {
            vm.prank(req[i]);
            IReceiveUln(ethLib).verify(p.header, h, conf);
        }
        for (uint256 i = 0; i < th; i++) {
            vm.prank(opt[i]);
            IReceiveUln(ethLib).verify(p.header, h, conf);
        }
    }

    function _origin(Packet memory p) internal view returns (Origin memory) {
        return Origin(V0.RH_EID, bytes32(uint256(uint160(address(sender)))), p.nonce);
    }

    function _syncRhClock() internal {
        uint256 now_ = vm.getBlockTimestamp();
        _select(rh);
        if (now_ > vm.getBlockTimestamp()) vm.warp(now_);
        vm.roll(block.number + 1);
    }

    function _cost(bytes memory message) internal pure returns (uint256 c) {
        (,, c) = abi.decode(message, (uint64, address, uint256));
    }

    function _ethCfg() internal view returns (LibConfig[] memory) {
        (address[] memory req, address[] memory opt, uint8 th) = _ethDvns();
        return V0.ethReceive(ethLib, req, opt, th);
    }

    function _ethDvns() internal view returns (address[] memory, address[] memory, uint8) {
        return lean ? V0.ethLeanDvns() : V0.ethLiveDvns();
    }

    function _resolved(bytes memory raw) internal pure returns (bytes memory) {
        UlnConfigLite memory c = abi.decode(raw, (UlnConfigLite));
        if (c.optionalDVNCount == type(uint8).max) c.optionalDVNCount = 0;
        if (c.requiredDVNCount == type(uint8).max) c.requiredDVNCount = 0;
        return abi.encode(c);
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

    /// @dev Select a fork and pin its basefee. Foundry 1.9.0 shows a forked block's basefee to the test contract and to
    ///      view calls but gives state-changing calls a basefee of 0 unless vm.fee sets it (test/disciple/BasefeeDiag).
    ///      The sender and the hook price gas at block.basefee, so without the pin their gas refunds come out 0.
    function _select(uint256 fork) internal {
        vm.selectFork(fork);
        vm.fee(block.basefee);
    }
}
