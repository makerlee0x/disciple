// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LibConfig, SetConfigParam} from "./ILayerZeroEndpointV2Lite.sol";

/// @notice LayerZero ULN config (same layout as LayerZero's UlnConfig). DVN lists must be sorted ascending.
struct UlnConfig {
    uint64 confirmations;
    uint8 requiredDVNCount;
    uint8 optionalDVNCount;
    uint8 optionalDVNThreshold;
    address[] requiredDVNs;
    address[] optionalDVNs;
}

/// @title DiscipleRoutesV0
/// @notice v0 cross-chain wiring (maker, 2026-11-04): Ethereum -> Robinhood Chain over LayerZero push. Robinhood's
///         endpoint defaults to a dead DVN on every pathway, so the sender and receiver set their own ULN config at
///         construction. DVN sets are the ones a live Ethereum <-> Robinhood OApp
///         (0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34) uses; confirmations lowered to 5 Ethereum blocks (~1 min),
///         maker's choice. Ethereum's send side and Robinhood's receive side must agree on DVNs and confirmations.
library DiscipleRoutesV0 {
    uint32 internal constant ETH_EID = 30101;
    uint32 internal constant RH_EID = 30416;
    address internal constant ETH_ENDPOINT = 0x1a44076050125825900e736c501f859c50fE728c;
    address internal constant RH_ENDPOINT = 0x6F475642a6e85809B1c36Fa62763669b1b48DD5B;
    uint64 internal constant CONFIRMATIONS = 5;
    uint32 internal constant CONFIG_TYPE_ULN = 2;

    /// @dev Ethereum SendUln302 config for messages to Robinhood (eid 30416).
    function ethSendToRobinhood(address sendLib) internal pure returns (LibConfig[] memory c) {
        address[] memory req = new address[](2);
        req[0] = 0x589dEDbD617e0CBcB916A9223F4d1300c294236b;
        req[1] = 0x8bD47CbD47980Cc6f3f8451FA7586548014b10dB;
        address[] memory opt = new address[](3);
        opt[0] = 0x380275805876Ff19055EA900CDb2B46a94ecF20D;
        opt[1] = 0x394fe81886BaF6e2d5BEe37ffA24b07133C320c6;
        opt[2] = 0xa59BA433ac34D2927232918Ef5B2eaAfcF130BA5;
        c = _one(sendLib, RH_EID, req, opt);
    }

    /// @dev Robinhood ReceiveUln302 config for messages from Ethereum (eid 30101).
    function rhReceiveFromEthereum(address receiveLib) internal pure returns (LibConfig[] memory c) {
        address[] memory req = new address[](2);
        req[0] = 0x80008dB0e86e421C50AaB5f5B5eBa904e9A54b69;
        req[1] = 0xd01ae6905d48315f7bE10C7330aeCF8360Ef5b12;
        address[] memory opt = new address[](3);
        opt[0] = 0x0Ffe02DF012299A370D5dd69298A5826EAcaFdF8;
        opt[1] = 0x1258A278519c7f4bd997a9c3BFd4Aa802a028D89;
        opt[2] = 0x786804435F1a9F583cA0cd7A4584eBBFcAE35855;
        c = _one(receiveLib, ETH_EID, req, opt);
    }

    /// @dev The Robinhood-side DVNs, for tests that act as them.
    function rhDvns() internal pure returns (address[] memory req, address[] memory opt) {
        LibConfig[] memory c = rhReceiveFromEthereum(address(0));
        UlnConfig memory u = abi.decode(c[0].params[0].config, (UlnConfig));
        return (u.requiredDVNs, u.optionalDVNs);
    }

    function _one(address lib, uint32 eid, address[] memory req, address[] memory opt)
        private
        pure
        returns (LibConfig[] memory c)
    {
        UlnConfig memory u = UlnConfig({
            confirmations: CONFIRMATIONS,
            requiredDVNCount: uint8(req.length),
            optionalDVNCount: uint8(opt.length),
            optionalDVNThreshold: 2,
            requiredDVNs: req,
            optionalDVNs: opt
        });
        c = new LibConfig[](1);
        c[0].lib = lib;
        c[0].params = new SetConfigParam[](1);
        c[0].params[0] = SetConfigParam(eid, CONFIG_TYPE_ULN, abi.encode(u));
    }
}
