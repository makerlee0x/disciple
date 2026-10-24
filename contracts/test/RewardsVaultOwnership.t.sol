// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {RewardsVault} from "../src/RewardsVault.sol";
import {Owned2Step} from "../src/utils/Owned2Step.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract VaultTok is ERC20 {
    constructor() ERC20("T", "T") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// Audit r127 Low (RewardsVault.sol:41): two-step ownership, as FeeRouter / LockedLP / Migration.
contract RewardsVaultOwnershipTest is Test {
    RewardsVault vault;
    address owner = makeAddr("owner");
    address multisig = makeAddr("multisig");

    function setUp() public {
        vault = new RewardsVault(owner);
    }

    function test_ctor_rejectsZeroOwner() public {
        vm.expectRevert(RewardsVault.ZeroAddress.selector);
        new RewardsVault(address(0));
    }

    function test_transferOwnership_isTwoStep() public {
        vm.prank(owner);
        vm.expectEmit(true, true, false, false, address(vault));
        emit Owned2Step.OwnershipTransferStarted(owner, multisig);
        vault.transferOwnership(multisig);
        // nomination only: the old owner keeps control until the nominee accepts
        assertEq(vault.owner(), owner);
        assertEq(vault.pendingOwner(), multisig);
        vm.prank(owner);
        vault.setFeeRouter(address(1));
        vm.prank(multisig);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        vault.setFeeRouter(address(2));
        // a stranger cannot accept
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(Owned2Step.NotPendingOwner.selector);
        vault.acceptOwnership();
        vm.prank(multisig);
        vault.acceptOwnership();
        assertEq(vault.owner(), multisig);
        assertEq(vault.pendingOwner(), address(0));
        vm.prank(owner);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        vault.setFeeRouter(address(3));
    }

    function test_typoNomination_canBeCancelled() public {
        vm.startPrank(owner);
        vault.transferOwnership(address(0xdead));
        vault.transferOwnership(address(0)); // cancel
        vm.stopPrank();
        assertEq(vault.owner(), owner);
        vm.prank(address(0xdead));
        vm.expectRevert(Owned2Step.NotPendingOwner.selector);
        vault.acceptOwnership();
    }

    function test_onlyOwnerFunctions() public {
        VaultTok t = new VaultTok();
        t.mint(address(vault), 100);
        address[] memory to = new address[](1);
        uint256[] memory amt = new uint256[](1);
        to[0] = multisig;
        amt[0] = 40;
        vm.prank(multisig);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        vault.distribute(address(t), to, amt);
        vm.prank(owner);
        vault.distribute(address(t), to, amt);
        assertEq(t.balanceOf(multisig), 40);
    }
}
