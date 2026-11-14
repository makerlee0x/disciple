// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {DisciplePermitForwarder, IPermit2SignatureTransfer} from "../../src/addons/DisciplePermitForwarder.sol";

/// @notice The DEPLOYED testnet forwarder against live Robinhood testnet state (real USDG, real Permit2, real AnonLauncher).
///         Skipped unless FORK_RPC_URL is set:  FORK_RPC_URL=https://rpc.testnet.chain.robinhood.com forge test --match-contract PermitForwarderTestnet
contract PermitForwarderTestnet is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    DisciplePermitForwarder constant FWD = DisciplePermitForwarder(0x18c2375C08b992B704124c2D37151a27d81e7c55);
    address constant USDG = 0x9dC7A988a8707dC4AB7ac08fC2CB4D5bf906158D;
    address constant ANON_LAUNCHER = 0x526784706e5Ef369412ABe65213ED65256182C6b;
    bytes32 constant TP = keccak256("TokenPermissions(address token,uint256 amount)");
    uint256 key = 0xD15C1;
    address alice;
    address bob = makeAddr("bob");
    address relayer = makeAddr("relayer");
    address mallory = makeAddr("mallory");
    bool on;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        on = true;
        alice = vm.addr(key);
        deal(USDG, alice, 1_000e6);
        vm.prank(alice);
        IERC20(USDG).approve(PERMIT2, type(uint256).max);
    }

    function _sign(IPermit2SignatureTransfer.PermitTransferFrom memory p, string memory wt, bytes32 w) internal view returns (bytes memory) {
        bytes32 dom = keccak256(abi.encode(keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"), keccak256("Permit2"), block.chainid, PERMIT2));
        bytes32 th = keccak256(abi.encodePacked("PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,", wt));
        bytes32 sh = keccak256(abi.encode(th, keccak256(abi.encode(TP, p.permitted.token, p.permitted.amount)), address(FWD), p.nonce, p.deadline, w));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", dom, sh)));
        return abi.encodePacked(r, s, v);
    }

    function _p(uint256 amount, uint256 nonce) internal view returns (IPermit2SignatureTransfer.PermitTransferFrom memory p) {
        p.permitted = IPermit2SignatureTransfer.TokenPermissions(USDG, amount);
        p.nonce = nonce;
        p.deadline = block.timestamp + 5 minutes;
    }

    function test_deployed_withdraw_and_redirectRefused() public {
        if (!on) return;
        assertGt(address(FWD).code.length, 0, "forwarder deployed");
        IPermit2SignatureTransfer.PermitTransferFrom memory p = _p(25e6, uint256(keccak256("w1")));
        DisciplePermitForwarder.Withdraw memory w = DisciplePermitForwarder.Withdraw({to: bob, fee: 1e5, feeTo: relayer});
        bytes memory sig = _sign(p, FWD.WITHDRAW_WITNESS_TYPE(), FWD.hashWithdraw(w));
        DisciplePermitForwarder.Approval memory none;

        DisciplePermitForwarder.Withdraw memory stolen = DisciplePermitForwarder.Withdraw({to: mallory, fee: 1e5, feeTo: relayer});
        vm.prank(mallory);
        vm.expectRevert();
        FWD.withdraw(p, stolen, alice, sig, none);

        vm.prank(relayer);
        FWD.withdraw(p, w, alice, sig, none);
        assertEq(IERC20(USDG).balanceOf(bob), 25e6 - 1e5);
        assertEq(IERC20(USDG).balanceOf(relayer), 1e5);
        assertEq(IERC20(USDG).balanceOf(mallory), 0);
        assertEq(IERC20(USDG).balanceOf(address(FWD)), 0);
    }

    function test_deployed_privateLaunch_realAnonLauncher() public {
        if (!on) return;
        (bool ok, bytes memory ret) = ANON_LAUNCHER.staticcall(abi.encodeWithSignature("launchFee()"));
        require(ok, "launchFee");
        uint256 fee = abi.decode(ret, (uint256));
        DisciplePermitForwarder.AnonLaunch memory l;
        l.name = "Forwarder Fork Check";
        l.ticker = "FWDCHK";
        l.imageURI = "ipfs://bafkreigh2akiscaildc6bnpz3x3qkxjdjhdfo7cwyuxxkjt5yvsmdwbe2a";
        l.quote = USDG;
        l.deadline = block.timestamp + 5 minutes;
        l.stealthOwner = makeAddr("stealth");
        l.buyRecipient = l.stealthOwner;
        l.ephemeralPubKey = hex"02aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
        l.viewTag = bytes1(0x42);
        l.maxFee = fee;
        l.usdgIn = 0;
        l.refundTo = alice;
        l.launcher = ANON_LAUNCHER;
        IPermit2SignatureTransfer.PermitTransferFrom memory p = _p(fee, uint256(keccak256("l1")));
        bytes memory sig = _sign(p, FWD.ANON_LAUNCH_WITNESS_TYPE(), FWD.hashAnonLaunch(l));
        DisciplePermitForwarder.Approval memory none;

        DisciplePermitForwarder.AnonLaunch memory m = l;
        m.refundTo = mallory; // (memory alias: restore below)
        vm.prank(mallory);
        vm.expectRevert();
        FWD.launchAnon(p, m, alice, sig, none);
        m.refundTo = alice;

        uint256 a0 = IERC20(USDG).balanceOf(alice);
        vm.prank(relayer);
        ILaunchpad.LaunchResult memory r = FWD.launchAnon(p, l, alice, sig, none);
        assertGt(r.token.code.length, 0, "coin launched");
        assertEq(a0 - IERC20(USDG).balanceOf(alice), fee, "paid exactly the launch fee");
        assertEq(IERC20(USDG).balanceOf(address(FWD)), 0, "nothing left on the forwarder");
    }
}
