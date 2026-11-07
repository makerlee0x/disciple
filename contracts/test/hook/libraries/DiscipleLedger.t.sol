// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DiscipleLedger as LG} from "../../../src/hook/libraries/DiscipleLedger.sol";
import {DiscipleLedgerVectors as LV} from "./DiscipleLedgerVectors.sol";

contract LedgerHarness {
    using LG for LG.Book;

    LG.Book internal bk;

    function init(address creator, uint256 x, uint256 y, uint256 mark, bool cc) external {
        bk.init(creator, x, y, mark);
        bk.creatorCompounds = cc;
    }

    function op(uint8 code, int256 a, int256 b, int256 c) external {
        if (code == 0) bk.settle(uint256(a), uint256(b), uint256(b), uint256(b), c == 1);
        else if (code == 1) bk.swap(a, b);
        else if (code == 2) bk.deposit(address(uint160(uint256(a))), uint256(b), uint256(c));
        else if (code == 3) bk.withdraw(uint256(a), bk.lots[uint256(a)].owner, uint256(b), uint256(c));
        else if (code == 4) bk.restake(uint256(a), bk.lots[uint256(a)].owner);
        else if (code == 5) bk.claim(uint256(a), bk.lots[uint256(a)].owner);
        else if (code == 6) bk.poke(uint256(a));
    }

    function poke(uint256 id) external returns (uint256, uint256, uint256, uint256) {
        return bk.poke(id);
    }

    function count() external view returns (uint256) {
        return bk.count;
    }

    function book() external view returns (uint256[11] memory r) {
        r = [
            bk.x,
            bk.y,
            bk.sp,
            bk.b,
            bk.index,
            bk.escrowX,
            bk.escrowY,
            bk.creatorClaimX,
            bk.creatorClaimY,
            bk.lossCarry,
            bk.graduated ? 1 : 0
        ];
    }

    function withdrawAs(address who, uint256 id, uint256 s, uint256 b) external {
        bk.withdraw(id, who, s, b);
    }

    function depositAs(address who, uint256 dx, uint256 dy) external returns (uint256 id) {
        (id,,,) = bk.deposit(who, dx, dy);
    }
}

contract DiscipleLedgerTest is Test {
    uint256 internal constant Q128 = 1 << 128;

    /// Replays the integer mirror's histories; every number must match bit for bit.
    function test_replayMirrorHistories() public {
        string[11] memory names =
            ["x", "y", "sp", "b", "index", "escrowX", "escrowY", "creatorX", "creatorY", "lossCarry", "graduated"];
        for (uint256 i = 0; i < LV.count(); i++) {
            LV.History memory hst = LV.get(i);
            LedgerHarness h = new LedgerHarness();
            h.init(address(1), 500e18, 500e18, Q128, hst.creatorCompounds);
            for (uint256 j = 0; j < hst.ops.length; j++) {
                LV.Op memory o = hst.ops[j];
                h.op(o.op, o.a, o.b, o.c);
            }
            assertEq(h.count(), hst.lots.length, "lot count");
            for (uint256 j = 0; j < hst.lots.length; j++) {
                (uint256 s, uint256 bal, uint256 cx, uint256 cy) = h.poke(j + 1);
                assertEq(s, hst.lots[j].s, "lot principal");
                assertEq(bal, hst.lots[j].bal, "lot compound balance");
                assertEq(cx, hst.lots[j].claimX, "lot coin claim");
                assertEq(cy, hst.lots[j].claimY, "lot quote claim");
            }
            uint256[11] memory got = h.book();
            for (uint256 k = 0; k < 11; k++) {
                assertEq(got[k], hst.book[k], names[k]);
            }
        }
    }

    function test_onlyOwnerWithdraws() public {
        LedgerHarness h = new LedgerHarness();
        h.init(address(1), 500e18, 500e18, Q128, false);
        uint256 id = h.depositAs(address(2), 10e18, 10e18);
        vm.expectRevert(LG.NotOwner.selector);
        h.withdrawAs(address(3), id, 1e18, 0);
        h.withdrawAs(address(2), id, 1e18, 0);
    }

    function test_cannotDrain() public {
        LedgerHarness h = new LedgerHarness();
        h.init(address(1), 500e18, 500e18, Q128, false);
        (uint256 s,,,) = h.poke(1);
        vm.expectRevert(LG.WouldDrain.selector);
        h.withdrawAs(address(1), 1, s, 0);
        h.withdrawAs(address(1), 1, s - 1e6, 0);
    }

    /// Gas for the paths that matter: a swap record, a settle with distribution, a deposit deep in a long line.
    function test_gasLongLine() public {
        LedgerHarness h = new LedgerHarness();
        h.init(address(1), 500e18, 500e18, Q128, false);
        for (uint256 i = 0; i < 300; i++) {
            h.depositAs(address(uint160(100 + i)), 1e18, 1e18);
        }
        uint256 g = gasleft();
        h.op(1, 1e18, -0.99e18, 0);
        emit log_named_uint("swap record gas", g - gasleft());
        g = gasleft();
        h.op(0, int256(Q128), 1e30, 1);
        emit log_named_uint("settle + distribute gas", g - gasleft());
        g = gasleft();
        h.depositAs(address(9), 1e18, 1e18);
        emit log_named_uint("deposit gas at 302 lots", g - gasleft());
        g = gasleft();
        h.withdrawAs(address(100), 2, 5e17, 0);
        emit log_named_uint("withdraw gas (front of line, 302 lots)", g - gasleft());
    }
}
