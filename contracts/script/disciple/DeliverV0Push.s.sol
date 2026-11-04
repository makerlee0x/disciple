// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Origin} from "../../src/disciple/routes/ILayerZeroEndpointV2Lite.sol";
import {DiscipleRoutesV0 as V0} from "../../src/disciple/routes/DiscipleRoutesV0.sol";

interface IEndpointDeliver {
    function defaultReceiveLibrary(uint32 eid) external view returns (address);
    function lzReceive(Origin calldata o, address receiver, bytes32 guid, bytes calldata message, bytes calldata extra)
        external
        payable;
}

interface IReceiveUlnCommit {
    function commitVerification(bytes calldata packetHeader, bytes32 payloadHash) external;
}

/// @title Deliver a self-executed push on its destination: Ethereum -> Robinhood on Robinhood, or
///        Robinhood -> Ethereum on Ethereum (run with that chain's RPC)
/// @notice The keeper's second step when the sender uses DiscipleSelfExecutor. After the push's Ethereum
///         transaction has 5 confirmations and the DVNs have verified on Robinhood (each DVN's PayloadVerified event
///         on the ReceiveUln302), run:
///           PACKET=<encodedPayload from the Ethereum endpoint's PacketSent event> \\
///           forge script script/disciple/DeliverV0Push.s.sol --rpc-url $RH_RPC --broadcast
///         It commits the verification and executes the message through the endpoint. Anyone may run it for any
///         packet (takeover); the refund still goes to the keeper who sent and paid on Ethereum. Reverts, changing
///         nothing, if the DVNs have not verified yet or the packet was already delivered.
contract DeliverV0Push is Script {
    function run() external {
        require(block.chainid == 4663 || block.chainid == 1, "run on Robinhood Chain or Ethereum");
        bool here = block.chainid == 4663; // true: Ethereum -> Robinhood; false: Robinhood -> Ethereum
        bytes memory packet = vm.envBytes("PACKET");
        require(packet.length > 113, "PACKET");
        // PacketV1: version(1) nonce(8) srcEid(4) sender(32) dstEid(4) receiver(32) | guid(32) | message
        bytes memory header = new bytes(81);
        for (uint256 i = 0; i < 81; i++) {
            header[i] = packet[i];
        }
        bytes memory message = new bytes(packet.length - 113);
        for (uint256 i = 0; i < message.length; i++) {
            message[i] = packet[113 + i];
        }
        uint64 nonce;
        uint32 srcEid;
        bytes32 sender;
        uint32 dstEid;
        bytes32 receiver;
        bytes32 guid;
        assembly {
            let p := add(packet, 32)
            nonce := shr(192, mload(add(p, 1)))
            srcEid := shr(224, mload(add(p, 9)))
            sender := mload(add(p, 13))
            dstEid := shr(224, mload(add(p, 45)))
            receiver := mload(add(p, 49))
            guid := mload(add(p, 81))
        }
        address endpoint = here ? V0.RH_ENDPOINT : V0.ETH_ENDPOINT;
        require(
            here ? (srcEid == V0.ETH_EID && dstEid == V0.RH_EID) : (srcEid == V0.RH_EID && dstEid == V0.ETH_EID),
            "packet is not addressed to this chain"
        );
        address lib = IEndpointDeliver(endpoint).defaultReceiveLibrary(srcEid);
        vm.startBroadcast();
        IReceiveUlnCommit(lib).commitVerification(header, keccak256(abi.encodePacked(guid, message)));
        IEndpointDeliver(endpoint).lzReceive(
            Origin(srcEid, sender, nonce), address(uint160(uint256(receiver))), guid, message, ""
        );
        vm.stopBroadcast();
        console2.log("delivered nonce", nonce);
    }
}
