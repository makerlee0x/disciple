// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DiscipleHook} from "../../src/bridge/DiscipleHook.sol";
import {DiscipleMath} from "../../src/bridge/DiscipleMath.sol";
import {DiscipleAnchor} from "../../src/bridge/DiscipleAnchor.sol";
import {DiscipleBook} from "../../src/bridge/DiscipleBook.sol";
import {DiscipleLp} from "../../src/bridge/DiscipleLp.sol";
import {BridgeConstants as C} from "../../src/bridge/libraries/BridgeConstants.sol";
import {BridgeFixture} from "./BridgeFixture.sol";

/// @notice The hook plus its four linked libraries stay under EIP-170, hold no swappable role,
///         and keep library storage empty. Math, the anchor reader, and the hook itself do not SSTORE.
contract DisciplePublicGoodsTest is BridgeFixture {
    function setUp() public {
        _deployStack(18);
        coin = _newCoin("JESUS", 18);
        (key, id) = _create(coin, 77e18, 0, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        _price(id, 1e18, 725_000e18);
        usdg.mint(address(this), 5e18);
        _buy(key, address(coin), 1e18);
    }

    function test_eachContractFitsEip170() public view {
        assertLe(address(hook).code.length, 24_576, "hook");
        assertLe(address(DiscipleMath).code.length, 24_576, "math");
        assertLe(address(DiscipleAnchor).code.length, 24_576, "anchor");
        assertLe(address(DiscipleBook).code.length, 24_576, "book");
        assertLe(address(DiscipleLp).code.length, 24_576, "lp");
    }

    function test_noPrivilegedSelectorsAndNoMutableAddressRole() public {
        address[5] memory code =
            [address(hook), address(DiscipleMath), address(DiscipleAnchor), address(DiscipleBook), address(DiscipleLp)];
        bytes4[16] memory banned = [
            bytes4(keccak256("owner()")),
            bytes4(keccak256("setOwner(address)")),
            bytes4(keccak256("transferOwnership(address)")),
            bytes4(keccak256("builder()")),
            bytes4(keccak256("proposeBuilder(address)")),
            bytes4(keccak256("acceptBuilder()")),
            bytes4(keccak256("pendingBuilder()")),
            bytes4(keccak256("rescueEth(address)")),
            bytes4(keccak256("setCreator(bytes32,address)")),
            bytes4(keccak256("setLensAllowed(address,bool)")),
            bytes4(keccak256("setOracleAllowed(address,bool)")),
            bytes4(keccak256("updatePrice(bytes32)")),
            bytes4(keccak256("fundTip(bytes32,uint256)")),
            bytes4(keccak256("claimBuilderFees(bytes32)")),
            bytes4(keccak256("upgradeTo(address)")),
            bytes4(keccak256("setHook(address)"))
        ];
        for (uint256 i; i < code.length; ++i) {
            for (uint256 j; j < banned.length; ++j) {
                (bool ok,) = code[i].call(abi.encodeWithSelector(banned[j]));
                assertFalse(ok, "privileged selector");
            }
        }
        assertEq(_sstoreCount(address(hook)), 0, "hook storage writes live in the libraries");
        assertEq(_sstoreCount(address(DiscipleMath)), 0);
        assertEq(_sstoreCount(address(DiscipleAnchor)), 0);
    }

    function test_librariesKeepEmptyStorageAfterATrade() public view {
        address[4] memory libs =
            [address(DiscipleMath), address(DiscipleAnchor), address(DiscipleBook), address(DiscipleLp)];
        for (uint256 i; i < libs.length; ++i) {
            for (uint256 slot; slot < 8; ++slot) {
                assertEq(vm.load(libs[i], bytes32(slot)), bytes32(0));
            }
        }
        assertEq(address(hook.poolManager()), address(manager));
        assertEq(hook.usdg(), address(usdg));
        assertEq(hook.v2Factory(), address(v2Factory));
        assertEq(hook.v3Factory(), address(v3Factory));
        assertEq(hook.mathLibrary(), address(DiscipleMath));
        assertEq(hook.bookLibrary(), address(DiscipleBook));
    }

    function test_feeThirdsAndNoEth() public {
        assertEq(C.FEE_CREATOR_BPS, 3_333);
        assertEq(C.FEE_LOCKED_BPS, 3_333);
        assertEq(C.ANCHOR_V2, 0);
        assertEq(C.ANCHOR_V3, 1);
        assertEq(C.ANCHOR_V4, 2);
        (bool ok,) = address(hook).call{value: 1}("");
        assertFalse(ok);
        assertEq(address(hook).balance, 0);
    }

    /// @dev Count SSTORE, skipping PUSH immediates and the CBOR metadata suffix.
    function _sstoreCount(address target) internal view returns (uint256 n) {
        bytes memory code = target.code;
        uint256 end = code.length;
        if (end >= 2) {
            uint256 meta = (uint256(uint8(code[end - 2])) << 8) | uint8(code[end - 1]);
            if (meta >= 40 && meta + 2 < end) {
                uint256 start = end - meta - 2;
                uint8 mark = uint8(code[start]);
                if (mark == 0xa1 || mark == 0xa2) end = start;
            }
        }
        uint256 i;
        while (i < end) {
            uint8 op = uint8(code[i]);
            if (op == 0x55) ++n;
            if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
            ++i;
        }
    }
}
