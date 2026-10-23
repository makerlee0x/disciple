// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {DiscipleSessionPolicyTest, MockMAv2, MockRouter} from "./DiscipleSessionPolicy.t.sol";
import {DiscipleSessionPolicy as P} from "../../src/session/DiscipleSessionPolicy.sol";
import {ReferralRegistry} from "../../src/ReferralRegistry.sol";
import {IReferralRegistry} from "../../src/interfaces/IReferralRegistry.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice P_REFERRAL: session key may call ReferralRegistry.tryAttribute(account, referrer) only.
contract SessionReferralTest is DiscipleSessionPolicyTest {
    address ref = makeAddr("referrer");

    function _refCfg() internal view returns (P.SessionConfig memory c) {
        c = _cfg(uint48(block.timestamp + 24 hours));
        c.permissions |= policy.P_REFERRAL();
    }

    function _reinstall(P.SessionConfig memory c) internal {
        vm.startPrank(owner);
        acct.uninstallSession();
        acct.installSession(policy, E, key, c);
        vm.stopPrank();
    }

    function _attr(address wallet, address r) internal view returns (MockMAv2.Call memory) {
        return MockMAv2.Call(address(registry), 0, abi.encodeCall(IReferralRegistry.tryAttribute, (wallet, r)));
    }

    function test_selectorConstant() public view {
        assertEq(policy.referralRegistry(), address(registry));
        assertEq(IReferralRegistry.tryAttribute.selector, bytes4(keccak256("tryAttribute(address,address)")));
        assertEq(policy.P_REFERRAL(), 1 << 10);
    }

    function test_referralAttributedBuy() public {
        _reinstall(_refCfg());
        MockMAv2.Call[] memory cs = new MockMAv2.Call[](3);
        cs[0] = _attr(address(acct), ref);
        cs[1] = _approve(address(usdg), address(router), 10 * U);
        cs[2] = _buy(10 * U, address(acct));
        vm.prank(key);
        acct.executeBatch(cs);
        assertEq(registry.pendingReferrer(address(acct)), ref);
        assertEq(rocket.balanceOf(address(acct)), 1010 * U);
        assertEq(policy.sessionOf(address(acct), E).spent0, 10 * U);
    }

    function test_userOpPathAllowsAttribute() public {
        _reinstall(_refCfg());
        acct.userOpHook(
            abi.encodeCall(
                MockMAv2.execute,
                (address(registry), 0, abi.encodeCall(IReferralRegistry.tryAttribute, (address(acct), ref)))
            )
        );
    }

    function test_revert_withoutPermission() public {
        // default session (setUp) does not grant P_REFERRAL
        vm.prank(key);
        vm.expectRevert(
            abi.encodeWithSelector(P.NotAllowed.selector, address(registry), IReferralRegistry.tryAttribute.selector)
        );
        acct.execute(address(registry), 0, abi.encodeCall(IReferralRegistry.tryAttribute, (address(acct), ref)));
    }

    function test_revert_attributeOtherWallet() public {
        _reinstall(_refCfg());
        vm.prank(key);
        vm.expectRevert(P.WalletNotAccount.selector);
        acct.execute(address(registry), 0, abi.encodeCall(IReferralRegistry.tryAttribute, (attacker, ref)));
    }

    function test_revert_otherRegistrySelectors() public {
        _reinstall(_refCfg());
        bytes[] memory ds = new bytes[](3);
        ds[0] = abi.encodeCall(ReferralRegistry.setDepositHook, (attacker));
        ds[1] = abi.encodeCall(ReferralRegistry.transferOwnership, (attacker));
        ds[2] = abi.encodeCall(IReferralRegistry.onUsdgDeposit, (address(acct), 1e30));
        for (uint256 i; i < ds.length; ++i) {
            vm.prank(key);
            vm.expectRevert(abi.encodeWithSelector(P.NotAllowed.selector, address(registry), bytes4(ds[i])));
            acct.execute(address(registry), 0, ds[i]);
        }
    }

    function test_revert_registryNotApproveSpender() public {
        _reinstall(_refCfg());
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(P.SpenderNotAllowed.selector, address(registry)));
        acct.execute(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(registry), 1)));
    }

    function test_revert_ethValue() public {
        _reinstall(_refCfg());
        vm.prank(key);
        vm.expectRevert(P.EthValueNotAllowed.selector);
        acct.execute(address(registry), 1, abi.encodeCall(IReferralRegistry.tryAttribute, (address(acct), ref)));
    }

    function test_revert_buyStillPinnedToAccount() public {
        _reinstall(_refCfg());
        _expectBatchRevert(
            abi.encodeWithSelector(P.RecipientNotAccount.selector), _attr(address(acct), ref), _buy(10 * U, attacker)
        );
    }

    function test_revert_afterExpiryAndRevoke() public {
        _reinstall(_refCfg());
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(key);
        vm.expectRevert(P.SessionExpired.selector);
        acct.execute(address(registry), 0, abi.encodeCall(IReferralRegistry.tryAttribute, (address(acct), ref)));
    }

    function test_revert_disabledWhenRegistryUnset() public {
        P p0 = new P(address(0));
        vm.startPrank(owner);
        acct.uninstallSession();
        acct.installSession(p0, E, key, _refCfg());
        vm.stopPrank();
        vm.prank(key);
        vm.expectRevert(
            abi.encodeWithSelector(P.NotAllowed.selector, address(registry), IReferralRegistry.tryAttribute.selector)
        );
        acct.execute(address(registry), 0, abi.encodeCall(IReferralRegistry.tryAttribute, (address(acct), ref)));
    }
}
