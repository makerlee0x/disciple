// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {DisciplePushSender} from "../../src/disciple/routes/DisciplePushSender.sol";
import {DisciplePushReceiver} from "../../src/disciple/routes/DisciplePushReceiver.sol";
import {IDisciplePriceTarget} from "../../src/disciple/routes/DiscipleSourceReader.sol";
import {ILayerZeroEndpointV2Lite} from "../../src/disciple/routes/ILayerZeroEndpointV2Lite.sol";
import {DiscipleRoutesV0 as V0} from "../../src/disciple/routes/DiscipleRoutesV0.sol";
import {DiscipleSelfExecutor} from "../../src/disciple/routes/DiscipleSelfExecutor.sol";

interface IEndpointRecvLib {
    function defaultSendLibrary(uint32 eid) external view returns (address);
    function defaultReceiveLibrary(uint32 eid) external view returns (address);
}

/// @notice Stands in for the hook in the live transport test: records what the receiver delivers. Holds no funds.
contract PriceRecorder is IDisciplePriceTarget {
    address public immutable receiver;
    uint256 public count;
    uint32 public lastSrcEid;
    uint64 public lastObservedAt;
    uint256 public lastA;
    uint256 public lastB;
    address public lastKeeper;
    uint256 public lastCost;

    constructor(address receiver_) {
        receiver = receiver_;
    }

    function onBridgePrice(
        PoolId,
        uint32 srcEid,
        uint8,
        address,
        bytes32,
        uint256 a,
        uint256 b,
        uint64 observedAt,
        address keeper,
        uint256 keeperCost
    ) external {
        require(msg.sender == receiver, "receiver only");
        count++;
        (lastSrcEid, lastObservedAt, lastA, lastB, lastKeeper, lastCost) = (srcEid, observedAt, a, b, keeper, keeperCost);
    }
}

/// @title Live transport test of the v0 push, both directions (lean DVNs, self-executed)
/// @notice No hook and no pool: a PriceRecorder stands in for the hook, so only the transport is tested.
///   1. Ethereum:  forge script script/disciple/LiveTestV0Push.s.sol --sig "ethSender()"
///   2. Robinhood: PUSH_SENDER=<1> forge script script/disciple/LiveTestV0Push.s.sol --sig "robinhood()"
///   3. Ethereum:  PUSH_SENDER=<1> RECEIVER=<2> forge script script/disciple/LiveTestV0Push.s.sol --sig "push()"
///   4. wait for 5 Ethereum blocks + both DVNs, then on Robinhood: PACKET=<from 3's receipt> DeliverV0Push
///   5. Robinhood: cast call <recorder> "count()" -> 1, and "lastA()" / "lastB()" = the pair's reserves.
///   Reverse (Robinhood -> Ethereum), approved by maker for before the code lock (2026-11-04):
///   6. Robinhood: DVN_SET=lean DeployV0Push --sig "rhSender()"
///   7. Ethereum:  PUSH_SENDER=<6> LiveTestV0Push --sig "ethereum()"   (receiver + recorder, holds no funds)
///   8. Robinhood: PUSH_SENDER=<6> RECEIVER=<7> LiveTestV0Push --sig "rhPush()"   (reads a Robinhood v4 pool)
///   9. wait for 20 Robinhood blocks + both DVNs, then on Ethereum: PACKET=<from 8's receipt> DeliverV0Push
///   The Ethereum steps here (1, 7) deploy test contracts only, not the hook: ethSender() deploys the same lean,
///   self-executed sender as DeployV0Push.sender(), which itself waits for the audit flag.
contract LiveTestV0Push is Script {
    address internal constant RH_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    bytes32 internal constant RH_TEST_POOL = 0xa6975f4720a95aa9cdfa9b010a065b0e941534c93f9fa708104c08f0ac029ca0;

    /// @notice Step 1: the lean, self-executed Ethereum sender (DeployV0Push.sender() waits for the audit).
    function ethSender() external {
        require(block.chainid == 1, "run on Ethereum");
        address lib = IEndpointRecvLib(V0.ETH_ENDPOINT).defaultSendLibrary(V0.RH_EID);
        (address[] memory req, address[] memory opt, uint8 th) = V0.ethLeanDvns();
        vm.startBroadcast();
        address ex = address(new DiscipleSelfExecutor());
        DisciplePushSender s =
            new DisciplePushSender(
                ILayerZeroEndpointV2Lite(V0.ETH_ENDPOINT), V0.ethSend(lib, ex, req, opt, th), V0.sendGas(true, true)
            );
        vm.stopBroadcast();
        console2.log("PUSH_SENDER (Ethereum)", address(s));
    }

    /// @notice Step 7: receiver (lean ethReceive config) + recorder on Ethereum.
    function ethereum() external {
        require(block.chainid == 1, "run on Ethereum");
        address pushSender = vm.envAddress("PUSH_SENDER");
        address lib = IEndpointRecvLib(V0.ETH_ENDPOINT).defaultReceiveLibrary(V0.RH_EID);
        (address[] memory req, address[] memory opt, uint8 th) = V0.ethLeanDvns();
        uint32[] memory eids = new uint32[](1);
        address[] memory senders = new address[](1);
        bool[] memory eth = new bool[](1);
        (eids[0], senders[0], eth[0]) = (V0.RH_EID, pushSender, true);
        vm.startBroadcast();
        DisciplePushReceiver r = new DisciplePushReceiver(
            ILayerZeroEndpointV2Lite(V0.ETH_ENDPOINT), eids, senders, eth, V0.ethReceive(lib, req, opt, th), V0.destMsgGas(true)
        );
        PriceRecorder rec = new PriceRecorder(address(r));
        r.bind(IDisciplePriceTarget(address(rec)));
        vm.stopBroadcast();
        console2.log("RECEIVER (Ethereum)", address(r));
        console2.log("RECORDER (Ethereum)", address(rec));
    }

    /// @notice Step 8: push a Robinhood v4 pool's state to the Ethereum receiver.
    function rhPush() external {
        require(block.chainid == 4663, "run on Robinhood Chain");
        DisciplePushSender s = DisciplePushSender(vm.envAddress("PUSH_SENDER"));
        bytes32 to = bytes32(uint256(uint160(vm.envAddress("RECEIVER"))));
        DisciplePushSender.Req[] memory reqs = new DisciplePushSender.Req[](1);
        reqs[0].kind = 3; // v4
        reqs[0].target = RH_POOL_MANAGER;
        reqs[0].v4Id = vm.envOr("PUSH_V4", RH_TEST_POOL);
        reqs[0].pools = new PoolId[](1);
        reqs[0].pools[0] = PoolId.wrap(keccak256("disciple-live-test"));
        uint256 fee = s.quote(V0.ETH_EID, to, reqs, 200_000);
        (uint256 a, uint256 b) = s.read(3, RH_POOL_MANAGER, reqs[0].v4Id);
        console2.log("LayerZero fee (wei)", fee);
        console2.log("sqrtPriceX96", a);
        console2.log("liquidity", b);
        vm.startBroadcast();
        s.push{value: fee}(V0.ETH_EID, to, reqs, 200_000);
        vm.stopBroadcast();
    }

    function robinhood() external {
        require(block.chainid == 4663, "run on Robinhood Chain");
        address pushSender = vm.envAddress("PUSH_SENDER");
        address lib = IEndpointRecvLib(V0.RH_ENDPOINT).defaultReceiveLibrary(V0.ETH_EID);
        (address[] memory req, address[] memory opt, uint8 th) = V0.rhLeanDvns();
        uint32[] memory eids = new uint32[](1);
        address[] memory senders = new address[](1);
        bool[] memory eth = new bool[](1);
        (eids[0], senders[0], eth[0]) = (V0.ETH_EID, pushSender, true);
        vm.startBroadcast();
        DisciplePushReceiver r = new DisciplePushReceiver(
            ILayerZeroEndpointV2Lite(V0.RH_ENDPOINT), eids, senders, eth, V0.rhReceive(lib, req, opt, th), V0.destMsgGas(true)
        );
        PriceRecorder rec = new PriceRecorder(address(r));
        r.bind(IDisciplePriceTarget(address(rec)));
        vm.stopBroadcast();
        console2.log("RECEIVER", address(r));
        console2.log("RECORDER", address(rec));
    }

    function push() external {
        require(block.chainid == 1, "run on Ethereum");
        DisciplePushSender s = DisciplePushSender(vm.envAddress("PUSH_SENDER"));
        bytes32 to = bytes32(uint256(uint160(vm.envAddress("RECEIVER"))));
        DisciplePushSender.Req[] memory reqs = new DisciplePushSender.Req[](1);
        reqs[0].kind = 1; // v2
        reqs[0].target = vm.envOr("PUSH_V2", address(0x8f1B19622a888c53C8eE4F7D7B4Dc8F574ff9068));
        reqs[0].pools = new PoolId[](1);
        reqs[0].pools[0] = PoolId.wrap(keccak256("disciple-live-test"));
        uint256 fee = s.quote(V0.RH_EID, to, reqs, 200_000);
        (uint256 a, uint256 b) = s.read(1, reqs[0].target, bytes32(0));
        console2.log("LayerZero fee (wei)", fee);
        console2.log("reserve0", a);
        console2.log("reserve1", b);
        vm.startBroadcast();
        s.push{value: fee}(V0.RH_EID, to, reqs, 200_000);
        vm.stopBroadcast();
    }
}
