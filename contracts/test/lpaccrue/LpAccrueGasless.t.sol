// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {CurveDeployer} from "../../src/CurveDeployer.sol";
import {DiscipleRouter, IPermit2Witness} from "../../src/DiscipleRouter.sol";
import {Permit2Code} from "../helpers/Permit2Code.sol";
import {CurveDeployerV1} from "./legacy/CurveDeployerV1.sol";

/// @notice Apples-to-apples per-trade gas through the gasless router (buyWithPermit2 / sellWithPermit2, relayer EOA
///         submits): OLD curve (pre lp-accrue copy) vs NEW curve, USDG-quoted coin (1 hop), steady state, cold access.
///         Signing helpers copied from test/integration/DiscipleRouterPermit2.t.sol.
contract LpAccrueGaslessTest is IntegrationBase {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    uint256 aliceKey = 0xA11CE;
    address alice;
    address relayer = makeAddr("relayer");
    uint256 nonce;

    function setUp() public override {
        super.setUp();
        alice = vm.addr(aliceKey);
        vm.etch(PERMIT2, Permit2Code.RUNTIME);
        router.setUsdgRouting(address(quote), address(launchpad));
        quote.mint(alice, 1_000_000 ether);
    }

    function _domain() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
                keccak256("Permit2"),
                block.chainid,
                PERMIT2
            )
        );
    }

    function _sign(IPermit2Witness.PermitTransferFrom memory p, DiscipleRouter.Trade memory t)
        internal
        view
        returns (bytes memory)
    {
        bytes32 typeHash = keccak256(
            abi.encodePacked(
                "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
                router.TRADE_WITNESS_TYPE()
            )
        );
        bytes32 witness = keccak256(
            abi.encode(router.TRADE_TYPEHASH(), t.coin, t.isBuy, t.amountIn, t.minOut, t.recipient, t.deadline)
        );
        bytes32 structHash = keccak256(
            abi.encode(
                typeHash,
                keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, p.permitted.token, p.permitted.amount)),
                address(router),
                p.nonce,
                p.deadline,
                witness
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, keccak256(abi.encodePacked("\x19\x01", _domain(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _cool(Token t) internal {
        address c = launchpad.curveOf(address(t));
        address[11] memory a = [
            c,
            address(t),
            address(quote),
            address(feeRouter),
            address(lockedLP),
            address(launchpad),
            address(referrals),
            address(feeVault),
            address(router),
            PERMIT2,
            alice
        ];
        for (uint256 i; i < a.length; ++i) {
            vm.cool(a[i]);
        }
    }

    function _trade(Token t, bool isBuy, uint256 amt) internal returns (uint256 out, uint256 gasUsed) {
        DiscipleRouter.Trade memory tr = DiscipleRouter.Trade({
            coin: address(t), isBuy: isBuy, amountIn: amt, minOut: 1, recipient: alice, deadline: block.timestamp + 5 minutes
        });
        IPermit2Witness.PermitTransferFrom memory p;
        p.permitted = IPermit2Witness.TokenPermissions({token: isBuy ? address(quote) : address(t), amount: amt});
        p.nonce = nonce++;
        p.deadline = tr.deadline;
        bytes memory sig = _sign(p, tr);
        _cool(t);
        vm.prank(relayer, relayer);
        uint256 g = gasleft();
        out = isBuy ? router.buyWithPermit2(alice, p, tr, sig) : router.sellWithPermit2(alice, p, tr, sig);
        gasUsed = g - gasleft();
    }

    function _measure(bool legacy) internal returns (uint256 gb, uint256 gs) {
        address d = legacy ? address(new CurveDeployerV1()) : address(new CurveDeployer(address(feeVault)));
        vm.prank(owner);
        launchpad.setCurveDeployer(d);
        (BondingCurve c, Token t) = _launchWithQuote(address(quote), 0, 0);
        c;
        _warpPastSnipe();
        vm.startPrank(alice);
        quote.approve(PERMIT2, type(uint256).max);
        t.approve(PERMIT2, type(uint256).max);
        vm.stopPrank();
        _trade(t, true, 50 ether); // warm-up: steady-state non-zero slots
        uint256 out;
        (out, gb) = _trade(t, true, 3 ether); // $3 minimum trade
        (, gs) = _trade(t, false, out);
    }

    function test_gas_gaslessRouter_oldVsNew() public {
        (uint256 ob, uint256 os) = _measure(true);
        (uint256 nb, uint256 ns) = _measure(false);
        console2.log("gasless buyWithPermit2  old/new (exec gas, excl. 21k intrinsic + calldata)", ob, nb);
        console2.log("gasless sellWithPermit2 old/new (exec gas, excl. 21k intrinsic + calldata)", os, ns);
        assertLt(nb, ob);
        assertLt(ns, os);
    }
}
