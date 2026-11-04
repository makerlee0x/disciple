// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {DisciplePushSender} from "../../src/disciple/routes/DisciplePushSender.sol";
import {DisciplePushReceiver} from "../../src/disciple/routes/DisciplePushReceiver.sol";
import {IDisciplePriceTarget} from "../../src/disciple/routes/DiscipleSourceReader.sol";
import {ILayerZeroEndpointV2Lite} from "../../src/disciple/routes/ILayerZeroEndpointV2Lite.sol";
import {DiscipleRoutesV0 as V0} from "../../src/disciple/routes/DiscipleRoutesV0.sol";

interface IEndpointRecvLib {
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

/// @title Live transport test of the v0 Ethereum -> Robinhood push (lean DVNs, self-executed)
/// @notice No hook and no pool: a PriceRecorder stands in for the hook, so only the transport is tested.
///   1. Ethereum:  DVN_SET=lean SELF_EXECUTOR=1 forge script script/disciple/DeployV0Push.s.sol --sig "sender()"
///   2. Robinhood: PUSH_SENDER=<1> forge script script/disciple/LiveTestV0Push.s.sol --sig "robinhood()"
///   3. Ethereum:  PUSH_SENDER=<1> RECEIVER=<2> forge script script/disciple/LiveTestV0Push.s.sol --sig "push()"
///   4. wait for 5 Ethereum blocks + both DVNs, then on Robinhood: PACKET=<from 3's receipt> DeliverV0Push
///   5. Robinhood: cast call <recorder> "count()" -> 1, and "lastA()" / "lastB()" = the pair's reserves.
contract LiveTestV0Push is Script {
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
            ILayerZeroEndpointV2Lite(V0.RH_ENDPOINT), eids, senders, eth, V0.rhReceive(lib, req, opt, th)
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
