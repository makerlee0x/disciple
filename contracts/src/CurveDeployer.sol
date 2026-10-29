// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BondingCurve} from "./BondingCurve.sol";
import {CurveMath} from "./libraries/CurveMath.sol";

/// @title Deploys BondingCurve instances for the Launchpad (keeps Launchpad under EIP-170).
/// @dev Permissionless: the deployed curve's `launchpad` is always msg.sender, so a curve deployed by anyone
///      other than the real Launchpad is inert (not registered, not FeeRouter-authorized).
/// @dev Mode rules v2: BondingCurve's creation code (~24.8 KB) no longer fits inside this contract's runtime code, so
///      the constructor writes it into two SSTORE2-style data contracts (runtime = STOP byte + chunk, uncallable) and
///      `deploy` reassembles it with EXTCODECOPY, appends the ABI-encoded constructor args and CREATEs. The deployed
///      curve is byte-identical to `new BondingCurve(...)` (tested).
contract CurveDeployer {
    address private immutable _chunk0;
    address private immutable _chunk1;
    uint256 private immutable _len0;
    uint256 private immutable _len1;

    error ChunkDeployFailed();
    error CurveDeployFailed();

    constructor() {
        bytes memory code = type(BondingCurve).creationCode;
        uint256 l0 = code.length / 2;
        uint256 l1 = code.length - l0;
        _len0 = l0;
        _len1 = l1;
        _chunk0 = _store(code, 0, l0);
        _chunk1 = _store(code, l0, l1);
    }

    /// @dev Data contract initcode: PUSH2 n DUP1 PUSH1 0x0c PUSH1 0 CODECOPY PUSH1 0 RETURN, then STOP ++ chunk.
    function _store(bytes memory code, uint256 off, uint256 len) private returns (address a) {
        bytes memory init = new bytes(13 + len);
        uint256 n = len + 1; // runtime = STOP byte + chunk (< 24,576)
        assembly ("memory-safe") {
            let p := add(init, 32)
            mstore8(p, 0x61)
            mstore8(add(p, 1), shr(8, n))
            mstore8(add(p, 2), and(n, 0xff))
            // 80 60 0c 60 00 39 60 00 f3 00
            mstore(add(p, 3), shl(176, 0x80600c6000396000f300))
            mcopy(add(p, 13), add(add(code, 32), off), len)
            a := create(0, p, add(13, len))
        }
        if (a == address(0)) revert ChunkDeployFailed();
    }

    function deploy(
        address token,
        address quote,
        address creator,
        address feeRouter,
        address migration,
        uint256 creatorTaxBps,
        CurveMath.Params calldata params,
        uint256 walletCapBps,
        uint8 mode,
        address loginGate,
        address trustedRouter,
        uint256 crewTipThresholdBps,
        uint256 snipeEscrowTimeout
    ) external returns (address curve) {
        bytes memory args = abi.encode(
            token,
            quote,
            creator,
            msg.sender,
            feeRouter,
            migration,
            creatorTaxBps,
            params,
            walletCapBps,
            mode,
            loginGate,
            trustedRouter,
            crewTipThresholdBps,
            snipeEscrowTimeout
        );
        address c0 = _chunk0;
        address c1 = _chunk1;
        uint256 l0 = _len0;
        uint256 l1 = _len1;
        assembly ("memory-safe") {
            let p := mload(0x40)
            extcodecopy(c0, p, 1, l0)
            extcodecopy(c1, add(p, l0), 1, l1)
            let al := mload(args)
            mcopy(add(p, add(l0, l1)), add(args, 32), al)
            curve := create(0, p, add(add(l0, l1), al))
            if iszero(curve) {
                let rs := returndatasize()
                returndatacopy(p, 0, rs)
                revert(p, rs)
            }
        }
    }
}
