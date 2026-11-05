// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {PaymasterTestBase, MockUSDG, MiniAccount} from "./PaymasterTestBase.sol";
import {DisciplePaymaster} from "../../src/paymaster/DisciplePaymaster.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PackedUserOperation as EpOp} from "../vendor/aa-v07/interfaces/PackedUserOperation.sol";
import {PackedUserOperation as PmOp, PostOpMode} from "../../src/paymaster/IPaymasterV07.sol";

contract GriefUSDG is MockUSDG {
    constructor() MockUSDG(6) {}
    function transfer(address, uint256) public pure override returns (bool) { assembly { invalid() } }
}
contract PaymasterGasGriefTest is PaymasterTestBase {
    function setUp() public { _setUp(6); }
    function test_tokenBurnsBothTransferBudgets_postOpStillRecordsFullyBackedCredits() public {
        usdg = new GriefUSDG();
        pm = new DisciplePaymaster(address(ep), address(usdg), owner, signer, treasury, rate / 10, rate * 10, 12_000_000, 200_000);
        pm.deposit{value: 1 ether}();
        usdg.mint(address(acct), 100e6);
        vm.prank(address(acct)); usdg.approve(address(pm), type(uint256).max);
        uint256 cap = _maxTok();
        bytes memory cd = abi.encodeCall(MiniAccount.execute, (address(usdg), 0, abi.encodeCall(ERC20.approve, (address(pm), type(uint256).max))));
        (bool ok, uint256 gasCost, uint256 charged) = _sendRecord(_full(cd, rate, cap));
        assertTrue(ok, "bounded gas grief cannot revert postOp");
        assertGe(charged, pm.tokenCost(gasCost, rate));
        assertEq(pm.creditOf(treasury), charged);
        assertEq(pm.creditOf(address(acct)), cap - charged);
        assertEq(usdg.balanceOf(address(pm)), cap);
        assertEq(pm.owedOf(address(acct)), 0);
    }
    function test_postOpRevertedMode_settlesFromPrecharge_notFromAccount() public {
        uint256 cap = _maxTok();
        EpOp memory op = _full(_approveThen(cap, _transferCall(owner, 1)), rate, cap);
        PmOp memory packed = abi.decode(abi.encode(op), (PmOp));
        bytes32 hash = ep.getUserOpHash(op);
        vm.prank(address(ep));
        (bytes memory context,) = pm.validatePaymasterUserOp(packed, hash, _maxCost());
        vm.prank(address(acct)); usdg.approve(address(pm), 0);
        vm.prank(address(ep)); pm.postOp(PostOpMode.postOpReverted, context, 100_000 * TIP, TIP);
        assertGt(usdg.balanceOf(treasury), 0);
        assertEq(pm.prechargeOf(hash), 0);
        assertEq(usdg.balanceOf(address(pm)), 0);
    }
    function test_entrypointV07NeverRetriesRevertingPostOp_maximumRemainsSecured() public {
        uint256 cap = _maxTok();
        EpOp memory op = _full(_approveThen(cap, _transferCall(owner, 1)), rate, cap);
        uint256 depositBefore = pm.getDeposit();
        vm.mockCallRevert(address(pm), abi.encodeWithSelector(DisciplePaymaster.postOp.selector), hex"dead");
        (bool ok,,) = _sendRecord(op);
        assertFalse(ok, "EntryPoint rolls back account execution, not validation");
        assertGe(usdg.balanceOf(address(pm)), pm.tokenCost(depositBefore - pm.getDeposit(), rate));
        assertEq(pm.prechargeOf(ep.getUserOpHash(op)), cap);
        assertEq(pm.owedOf(address(acct)), 0);
        uint256 actualWeiCost = depositBefore - pm.getDeposit();
        bytes memory context = abi.encode(DisciplePaymaster.Context({
            sender: address(acct), userOpHash: ep.getUserOpHash(op), rate: rate, precharged: cap,
            executionGasLimit: CALL_GAS + PM_POSTOP_GAS,
            preOpGas: PVG + VERIF_GAS + PM_VERIF_GAS, validUntil: uint48(block.timestamp + 120)
        }));
        vm.prank(owner); vm.expectRevert(DisciplePaymaster.RecoveryNotReady.selector);
        pm.settleStuckPrecharge(context, actualWeiCost);
        vm.prank(owner); pm.setPaused(true);
        vm.warp(block.timestamp + 1 days + 121);
        vm.prank(owner); pm.settleStuckPrecharge(context, actualWeiCost);
        assertEq(usdg.balanceOf(treasury), pm.tokenCost(actualWeiCost, rate));
        assertEq(usdg.balanceOf(address(pm)), 0);
        vm.prank(owner); vm.expectRevert(DisciplePaymaster.InvalidContext.selector);
        pm.settleStuckPrecharge(context, actualWeiCost);
    }
}
