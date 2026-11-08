// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LibConfig, SetConfigParam} from "./ILayerZeroEndpointV2Lite.sol";

/// @notice LayerZero ULN config (same layout as LayerZero's UlnConfig). DVN lists must be sorted ascending.
struct ExecutorConfig {
    uint32 maxMessageSize;
    address executor;
}

struct UlnConfig {
    uint64 confirmations;
    uint8 requiredDVNCount;
    uint8 optionalDVNCount;
    uint8 optionalDVNThreshold;
    address[] requiredDVNs;
    address[] optionalDVNs;
}

/// @title DiscipleRoutesV0
/// @notice v0 cross-chain wiring (maker, 2026-11-04): LayerZero push both ways between Ethereum and Robinhood
///         Chain. Ethereum -> Robinhood: ethSend + rhReceive. Robinhood -> Ethereum: rhSend + ethReceive (one
///         combined hook on Ethereum takes both same-chain sources and pushed Robinhood prices). Robinhood's
///         endpoint defaults to a dead DVN on every pathway, so the sender and receiver set their own ULN config at
///         construction. DVN sets are the ones a live Ethereum <-> Robinhood OApp
///         (0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34) uses; confirmations lowered to 5 Ethereum blocks (~1 min),
///         maker's choice. Ethereum's send side and Robinhood's receive side must agree on DVNs and confirmations.
library DiscipleRoutesV0 {
    uint32 internal constant ETH_EID = 30101;
    uint32 internal constant RH_EID = 30416;
    address internal constant ETH_ENDPOINT = 0x1a44076050125825900e736c501f859c50fE728c;
    address internal constant RH_ENDPOINT = 0x6F475642a6e85809B1c36Fa62763669b1b48DD5B;
    /// @dev Ethereum -> Robinhood: 5 Ethereum blocks (~1 min), maker's choice.
    uint64 internal constant CONFIRMATIONS = 5;
    /// @dev Robinhood -> Ethereum: 20 Robinhood blocks (~2 s at ~100 ms blocks). Robinhood's sequencer orders
    ///      blocks and does not reorg in normal operation; 20 is LayerZero's usual default for Arbitrum-stack
    ///      chains. To check against the live OApp's Robinhood send config before launch.
    uint64 internal constant RH_CONFIRMATIONS = 20;
    uint32 internal constant CONFIG_TYPE_EXECUTOR = 1;
    uint32 internal constant CONFIG_TYPE_ULN = 2;
    uint32 internal constant MAX_MESSAGE_SIZE = 10_000;

    /// @dev DisciplePushSender.sendGas per config: gas of endpoint.send not visible to the sender's own measurement,
    ///      for a transaction starting cold (as on chain). Ethereum fork, Foundry 1.9.0, 2026-11-04, sized so the
    ///      carried gas is at or just above the measured gas for 1 source (test_fork_quoteMatrix).
    /// @dev DisciplePushReceiver.msgGas per receive DVN set: the keeper's commitVerification transaction (grows with
    ///      the DVNs checked) plus the fixed part of its lzReceive transaction. Ethereum fork, Foundry 1.9.0,
    ///      2026-11-04 (test_fork_destinationCost). +20k on 2026-11-08 (tip-jar hook; fitted with POOL_GAS from the
    ///      1/5/10-pool fork run: ~22.6k more per pool, the fixed part about where it was).
    function destMsgGas(bool lean) internal pure returns (uint256) {
        return lean ? 245_000 : 269_000;
    }

    function sendGas(bool lean, bool selfExecutor) internal pure returns (uint256) {
        if (lean) return selfExecutor ? 127_000 : 148_000;
        return selfExecutor ? 190_000 : 211_000;
    }
    uint8 internal constant NIL_DVN_COUNT = type(uint8).max;

    // ---- DVN sets, Ethereum side (sorted ascending)

    /// @dev The live OApp's set: 2 required + 2 of 3 optional. Measured ~0.000116 ETH of DVN fees per message.
    function ethLiveDvns() internal pure returns (address[] memory req, address[] memory opt, uint8 threshold) {
        req = new address[](2);
        req[0] = 0x589dEDbD617e0CBcB916A9223F4d1300c294236b; // LayerZero Labs
        req[1] = 0x8bD47CbD47980Cc6f3f8451FA7586548014b10dB;
        opt = new address[](3);
        opt[0] = 0x380275805876Ff19055EA900CDb2B46a94ecF20D;
        opt[1] = 0x394fe81886BaF6e2d5BEe37ffA24b07133C320c6;
        opt[2] = 0xa59BA433ac34D2927232918Ef5B2eaAfcF130BA5;
        threshold = 2;
    }

    /// @dev Lean set: two required, no optional. ~0.000004 ETH of DVN fees. Robinhood side: rhLeanDvns.
    function ethLeanDvns() internal pure returns (address[] memory req, address[] memory opt, uint8 threshold) {
        req = new address[](2);
        req[0] = 0x380275805876Ff19055EA900CDb2B46a94ecF20D;
        req[1] = 0x589dEDbD617e0CBcB916A9223F4d1300c294236b; // LayerZero Labs
        opt = new address[](0);
        threshold = 0;
    }

    /// @dev Robinhood-side counterparts of the lean set, matched by signer sets on live traffic (2026-11-04):
    ///      ETH 0x589d (LayerZero Labs) -> RH 0xd01a; ETH 0x3802 -> RH 0x1258.
    function rhLeanDvns() internal pure returns (address[] memory req, address[] memory opt, uint8 threshold) {
        req = new address[](2);
        req[0] = 0x1258A278519c7f4bd997a9c3BFd4Aa802a028D89;
        req[1] = 0xd01ae6905d48315f7bE10C7330aeCF8360Ef5b12;
        opt = new address[](0);
        threshold = 0;
    }

    /// @dev Robinhood-side counterparts of the live set (receive from Ethereum). The same DVN contracts sign the
    ///      reverse pathway: a DVN is one contract per chain for both sending and verifying, so Robinhood -> Ethereum
    ///      sends with rh*Dvns and Ethereum verifies with the matching eth*Dvns.
    function rhLiveDvns() internal pure returns (address[] memory req, address[] memory opt, uint8 threshold) {
        req = new address[](2);
        req[0] = 0x80008dB0e86e421C50AaB5f5B5eBa904e9A54b69;
        req[1] = 0xd01ae6905d48315f7bE10C7330aeCF8360Ef5b12;
        opt = new address[](3);
        opt[0] = 0x0Ffe02DF012299A370D5dd69298A5826EAcaFdF8;
        opt[1] = 0x1258A278519c7f4bd997a9c3BFd4Aa802a028D89;
        opt[2] = 0x786804435F1a9F583cA0cd7A4584eBBFcAE35855;
        threshold = 2;
    }

    // ---- configs

    /// @dev Ethereum SendUln302 config for messages to Robinhood. `executor` 0 keeps the default (paid) executor;
    ///      a DiscipleSelfExecutor makes the keeper finish delivery itself.
    function ethSend(address sendLib, address executor, address[] memory req, address[] memory opt, uint8 threshold)
        internal
        pure
        returns (LibConfig[] memory c)
    {
        c = new LibConfig[](1);
        c[0].lib = sendLib;
        c[0].params = new SetConfigParam[](executor == address(0) ? 1 : 2);
        c[0].params[0] = SetConfigParam(RH_EID, CONFIG_TYPE_ULN, _uln(CONFIRMATIONS, req, opt, threshold));
        if (executor != address(0)) {
            c[0].params[1] =
                SetConfigParam(RH_EID, CONFIG_TYPE_EXECUTOR, abi.encode(ExecutorConfig(MAX_MESSAGE_SIZE, executor)));
        }
    }

    /// @dev Robinhood SendUln302 config for messages to Ethereum (RH_CONFIRMATIONS). `executor` as in ethSend; a
    ///      DiscipleSelfExecutor on Robinhood makes the keeper commit and execute on Ethereum itself.
    function rhSend(address sendLib, address executor, address[] memory req, address[] memory opt, uint8 threshold)
        internal
        pure
        returns (LibConfig[] memory c)
    {
        c = new LibConfig[](1);
        c[0].lib = sendLib;
        c[0].params = new SetConfigParam[](executor == address(0) ? 1 : 2);
        c[0].params[0] = SetConfigParam(ETH_EID, CONFIG_TYPE_ULN, _uln(RH_CONFIRMATIONS, req, opt, threshold));
        if (executor != address(0)) {
            c[0].params[1] =
                SetConfigParam(ETH_EID, CONFIG_TYPE_EXECUTOR, abi.encode(ExecutorConfig(MAX_MESSAGE_SIZE, executor)));
        }
    }

    /// @dev Ethereum ReceiveUln302 config for messages from Robinhood. Must match rhSend's DVNs and confirmations.
    function ethReceive(address receiveLib, address[] memory req, address[] memory opt, uint8 threshold)
        internal
        pure
        returns (LibConfig[] memory c)
    {
        c = new LibConfig[](1);
        c[0].lib = receiveLib;
        c[0].params = new SetConfigParam[](1);
        c[0].params[0] = SetConfigParam(RH_EID, CONFIG_TYPE_ULN, _uln(RH_CONFIRMATIONS, req, opt, threshold));
    }

    /// @dev Robinhood ReceiveUln302 config for messages from Ethereum. Must match the send side's DVNs and
    ///      confirmations.
    function rhReceive(address receiveLib, address[] memory req, address[] memory opt, uint8 threshold)
        internal
        pure
        returns (LibConfig[] memory c)
    {
        c = new LibConfig[](1);
        c[0].lib = receiveLib;
        c[0].params = new SetConfigParam[](1);
        c[0].params[0] = SetConfigParam(ETH_EID, CONFIG_TYPE_ULN, _uln(CONFIRMATIONS, req, opt, threshold));
    }

    function _uln(uint64 confirmations, address[] memory req, address[] memory opt, uint8 threshold) private pure returns (bytes memory) {
        return abi.encode(
            UlnConfig({
                confirmations: confirmations,
                requiredDVNCount: uint8(req.length),
                // ULN reads a count of 0 as "use the endpoint default" (a dead DVN on Robinhood); 255 means none
                optionalDVNCount: opt.length == 0 ? NIL_DVN_COUNT : uint8(opt.length),
                optionalDVNThreshold: threshold,
                requiredDVNs: req,
                optionalDVNs: opt
            })
        );
    }
}
