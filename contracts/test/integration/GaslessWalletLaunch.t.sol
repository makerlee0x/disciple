// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase} from "./IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {CreatorFeeHarvest} from "../../src/addons/CreatorFeeHarvest.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {IPermit2Witness} from "../../src/interfaces/IPermit2Witness.sol";
import {Permit2Code} from "../helpers/Permit2Code.sol";

/// @notice maker 2026-11-19: players hold USDG only. A wallet (non-hidden) launch is relayed: the player signs one
///         Permit2 witness, the relayer submits it and gets the USDG network fee, the player is the coin creator.
contract GaslessWalletLaunchTest is IntegrationBase {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    uint256 pk = 0xB0B;
    address player;
    address relayer = makeAddr("relayer");

    function setUp() public override {
        super.setUp();
        player = vm.addr(pk);
        vm.etch(PERMIT2, Permit2Code.RUNTIME);
        router.setUsdgRouting(address(quote), address(launchpad));
        router.setUsdgPool(address(strategy), strategyUsdgKey);
        vm.startPrank(owner);
        harvest.wire(address(launchpad), address(feeRouter), address(lockedLP), address(router), address(manager));
        launchpad.setTrustedRouter(address(harvest), true);
        launchpad.setTrustedRouter(address(router), true);
        vm.stopPrank();
        quote.mint(player, 1_000 * U);
        vm.prank(player);
        quote.approve(PERMIT2, type(uint256).max);
    }

    function _params(address q, uint256 dl) internal pure returns (ILaunchpad.LaunchParams memory) {
        return ILaunchpad.LaunchParams({
            name: "Gasless",
            ticker: "GAS",
            imageURI: "ipfs://g",
            description: "",
            socialsURI: "",
            quote: q,
            creatorTaxBps: 0,
            creatorBuyQuoteIn: 0,
            creatorBuyMinTokensOut: 0,
            deadline: dl
        });
    }

    function _sign(IPermit2Witness.PermitTransferFrom memory p, CreatorFeeHarvest.GaslessLaunch memory w)
        internal
        view
        returns (bytes memory)
    {
        bytes32 typeHash = keccak256(
            abi.encodePacked(
                "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
                harvest.GASLESS_LAUNCH_WITNESS_TYPE()
            )
        );
        bytes32 witness = keccak256(
            abi.encode(
                harvest.GASLESS_LAUNCH_TYPEHASH(), w.paramsHash, w.mode, w.usdgIn, w.minQuoteIn, w.creatorFeeDestination, w.gasFee
            )
        );
        bytes32 sh = keccak256(
            abi.encode(
                typeHash,
                keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, p.permitted.token, p.permitted.amount)),
                address(harvest),
                p.nonce,
                p.deadline,
                witness
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
                keccak256("Permit2"),
                block.chainid,
                PERMIT2
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domain, sh)));
        return abi.encodePacked(r, s, v);
    }

    function _go(address q, uint256 boost, uint256 minQ, uint8 dest, uint256 fee, uint256 nonce)
        internal
        returns (ILaunchpad.LaunchResult memory r)
    {
        ILaunchpad.LaunchParams memory p = _params(q, block.timestamp + 1 hours);
        CreatorFeeHarvest.GaslessLaunch memory w =
            CreatorFeeHarvest.GaslessLaunch(keccak256(abi.encode(p)), 0, boost, minQ, dest, fee);
        IPermit2Witness.PermitTransferFrom memory pm = IPermit2Witness.PermitTransferFrom(
            IPermit2Witness.TokenPermissions(address(quote), boost + fee), nonce, block.timestamp + 1 hours
        );
        bytes memory sig = _sign(pm, w);
        uint256 rl0 = quote.balanceOf(relayer);
        vm.prank(relayer);
        (r,) = harvest.launchWithPermit2(player, pm, p, w, sig);
        assertEq(quote.balanceOf(relayer) - rl0, fee, "network fee to the relayer");
        assertEq(launchpad.creatorOf(r.token), player, "the signer is the coin creator");
        assertEq(harvest.creatorFeeDestinationOf(r.token), dest);
    }

    function test_noBoost_paysOnlyTheFee() public {
        uint256 b0 = quote.balanceOf(player);
        _go(address(quote), 0, 0, 0, U / 5, 0);
        assertEq(b0 - quote.balanceOf(player), U / 5);
    }

    function test_usdgBoost_and_burnDest() public {
        uint256 b0 = quote.balanceOf(player);
        ILaunchpad.LaunchResult memory r = _go(address(quote), 10 * U, 10 * U, 2, U / 5, 0);
        assertGt(Token(r.token).balanceOf(player), 0, "First BOOST tokens to the coin creator");
        assertLe(b0 - quote.balanceOf(player), 10 * U + U / 5);
        assertEq(quote.balanceOf(address(harvest)), 0, "nothing left on the harvest");
    }

    function test_strategyPair_boost() public {
        _warmStrategy();
        ILaunchpad.LaunchResult memory r = _go(address(strategy), 10 * U, 1, 0, 0, 0);
        assertGt(Token(r.token).balanceOf(player), 0);
        assertEq(strategy.balanceOf(address(harvest)), 0);
    }

    function test_relayerCannotChangeAnything() public {
        ILaunchpad.LaunchParams memory p = _params(address(quote), block.timestamp + 1 hours);
        CreatorFeeHarvest.GaslessLaunch memory w = CreatorFeeHarvest.GaslessLaunch(keccak256(abi.encode(p)), 0, 0, 0, 0, U / 5);
        IPermit2Witness.PermitTransferFrom memory pm =
            IPermit2Witness.PermitTransferFrom(IPermit2Witness.TokenPermissions(address(quote), U / 5), 0, block.timestamp + 1 hours);
        bytes memory sig = _sign(pm, w);
        CreatorFeeHarvest.GaslessLaunch memory greedy = w;
        greedy.gasFee = U / 2;
        pm.permitted.amount = U / 2;
        vm.prank(relayer);
        vm.expectRevert(); // Permit2 rejects: the witness no longer matches the signature
        harvest.launchWithPermit2(player, pm, p, greedy, sig);
        p.name = "Other";
        pm.permitted.amount = U / 5;
        vm.prank(relayer);
        vm.expectRevert(CreatorFeeHarvest.BadPermit.selector); // params no longer match the signed hash
        harvest.launchWithPermit2(player, pm, p, w, sig);
    }

    function test_feeAboveThreeDollars_refused() public {
        ILaunchpad.LaunchParams memory p = _params(address(quote), block.timestamp + 1 hours);
        CreatorFeeHarvest.GaslessLaunch memory w = CreatorFeeHarvest.GaslessLaunch(keccak256(abi.encode(p)), 0, 0, 0, 0, 3 * U + 1);
        IPermit2Witness.PermitTransferFrom memory pm =
            IPermit2Witness.PermitTransferFrom(IPermit2Witness.TokenPermissions(address(quote), 3 * U + 1), 0, block.timestamp + 1 hours);
        bytes memory sig = _sign(pm, w);
        vm.prank(relayer);
        vm.expectRevert(CreatorFeeHarvest.BadPermit.selector);
        harvest.launchWithPermit2(player, pm, p, w, sig);
    }
}
