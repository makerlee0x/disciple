// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReferralRegistry} from "../../src/ReferralRegistry.sol";
import {UsdgDepositNotifier} from "../../src/UsdgDepositNotifier.sol";
import {IReferralRegistry} from "../../src/interfaces/IReferralRegistry.sol";

contract DecUSDG is ERC20 {
    uint8 internal immutable _d;

    constructor(uint8 d) ERC20("USDG", "USDG") {
        _d = d;
    }

    function decimals() public view override returns (uint8) {
        return _d;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// @notice (g) the $10 referral gate / deposit minimum scales with the USDG token's decimals (6-dec mainnet USDG).
contract UsdgDecimalsTest is Test {
    address owner = makeAddr("owner");
    address kol = makeAddr("kol");
    address w = makeAddr("w");

    function _stack(uint8 d) internal returns (DecUSDG u, ReferralRegistry reg, UsdgDepositNotifier n) {
        u = new DecUSDG(d);
        reg = new ReferralRegistry(owner, address(u));
        n = new UsdgDepositNotifier(owner, IReferralRegistry(address(reg)), IERC20(address(u)));
        vm.prank(owner);
        reg.setDepositHook(address(n));
    }

    function test_gate_scales_18_and_6_decimals() public {
        (, ReferralRegistry r18, UsdgDepositNotifier n18) = _stack(18);
        assertEq(n18.minDeposit(), 10e18);
        assertEq(r18.usdgGate(), 10e18);
        (, ReferralRegistry r6, UsdgDepositNotifier n6) = _stack(6);
        assertEq(n6.minDeposit(), 10e6);
        assertEq(r6.usdgGate(), 10e6);
    }

    function test_6dec_deposit_of_ten_dollars_attributes() public {
        (DecUSDG u, ReferralRegistry reg, UsdgDepositNotifier n) = _stack(6);
        u.mint(w, 20e6);
        vm.startPrank(w);
        reg.tryAttribute(w, kol);
        u.approve(address(n), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(UsdgDepositNotifier.BelowMinimum.selector, 10e6));
        n.deposit(w, 10e6 - 1);
        n.deposit(w, 10e6); // exactly $10 of 6-dec USDG
        vm.stopPrank();
        assertEq(reg.referrerOf(w), kol);
    }
}
