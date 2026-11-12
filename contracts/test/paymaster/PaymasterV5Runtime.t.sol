// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PaymasterBootstrapFixture, BootstrapAccount, BootstrapFactory, BootstrapBuy} from "./PaymasterBootstrap.t.sol";
import {RuntimeMarket} from "./PaymasterRuntime.t.sol";
import {MockUSDG, MiniAccount} from "./PaymasterTestBase.sol";
import {PackedUserOperation as EpOp} from "../vendor/aa-v07/interfaces/PackedUserOperation.sol";
import {PackedUserOperation as PmOp} from "../../src/paymaster/IPaymasterV07.sol";
import {IEntryPoint} from "../vendor/aa-v07/interfaces/IEntryPoint.sol";
import {DisciplePaymasterV5 as PM} from "../../src/paymaster/DisciplePaymasterV5.sol";
import {DiscipleSessionPolicyV143 as Policy} from "../../src/session/DiscipleSessionPolicyV143.sol";
import {DiscipleRouter} from "../../src/DiscipleRouter.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Gas table for the v5 credit paymaster on the production curve, at the observed 0.01 gwei fee.
///         USDG figures below are recomputed at 6 decimals and 2300 USDG/ETH from the measured gas units.
contract PaymasterV5RuntimeTest is PaymasterBootstrapFixture {
    RuntimeMarket market;
    PM v5;
    Policy policy5;
    uint256 sessionNonce;
    address launchTarget;
    uint256 constant FEE = 10_000_000;
    uint256 constant RATE6 = 2_300_000_000;
    uint256 constant PM_V = 300_000;
    uint256 constant PM_P = 160_000;
    bytes4 constant DEPOSIT_SEL = bytes4(keccak256("deposit(address,uint256)"));

    function setUp() public override {
        super.setUp();
        market = new RuntimeMarket();
        market.prepare(smart);
        usdg = MockUSDG(market.usdgAddress());
        rate = 3000 ether;
        v5 = new PM(EP, address(usdg), owner, signer, treasury, rate / 10, rate * 10, 7_068_712, 150_000);
        vm.prank(owner);
        v5.setLaunchGasLimit(21_840_770);
        v5.deposit{value: 1 ether}();
        vm.fee(0);
        trade = BootstrapBuy(market.routerAddress());
        bought = MockUSDG(address(market.token()));
        policy5 = new Policy(address(0), address(v5));
    }

    function _usdg6(uint256 gasUsed) internal pure returns (uint256) {
        return (gasUsed * FEE * RATE6 + 1e18 - 1) / 1e18;
    }

    function _prefix(uint128 post) internal view returns (bytes memory) {
        return abi.encodePacked(address(v5), uint128(PM_V), post);
    }

    function _sign(EpOp memory op, uint256 maxTok, bool launch, bool exact) internal view returns (EpOp memory) {
        uint48 until = uint48(block.timestamp + 120);
        uint48 afterTs = uint48(block.timestamp - 10);
        op.paymasterAndData = abi.encodePacked(_prefix(uint128(PM_P)), until, afterTs, rate, maxTok, new bytes(65));
        PmOp memory packed = abi.decode(abi.encode(op), (PmOp));
        bytes32 h = launch
            ? v5.getLaunchOpHash(packed, until, afterTs, rate, maxTok)
            : exact
                ? v5.getOpHash(packed, until, afterTs, rate, maxTok)
                : v5.getHash(op.sender, until, afterTs, rate, maxTok);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, MessageHashUtils.toEthSignedMessageHash(h));
        op.paymasterAndData = abi.encodePacked(_prefix(uint128(PM_P)), until, afterTs, rate, maxTok, r, s, v);
        return op;
    }

    function _limits(EpOp memory op, uint256 verif, uint256 callGas) internal pure returns (EpOp memory) {
        op.accountGasLimits = bytes32((verif << 128) | callGas);
        op.preVerificationGas = 80_000;
        op.gasFees = bytes32((FEE << 128) | FEE);
        return op;
    }

    function _need(EpOp memory op) internal view returns (uint256) {
        uint256 units = uint128(uint256(op.accountGasLimits) >> 128) + uint128(uint256(op.accountGasLimits))
            + op.preVerificationGas + PM_V + PM_P;
        return v5.tokenCost(units * FEE, rate);
    }

    function _install() internal view override returns (bytes memory) {
        Policy.SessionConfig memory cfg;
        cfg.validUntil = uint48(block.timestamp + 1 days);
        cfg.permissions = (1 << 10) - 1;
        cfg.router = address(trade);
        cfg.launchpad = launchTarget == address(0) ? address(trade) : launchTarget;
        cfg.quote0 = address(usdg);
        cfg.cap0 = type(uint128).max;
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = MiniAccount.execute.selector;
        selectors[1] = MiniAccount.executeBatch.selector;
        bytes[] memory hooks = new bytes[](2);
        hooks[0] = abi.encodePacked(
            bytes25(abi.encodePacked(address(policy5), ENTITY, uint8(1))), abi.encode(ENTITY, cfg)
        );
        hooks[1] = abi.encodePacked(
            bytes25(abi.encodePacked(address(policy5), ENTITY | policy5.EXEC_HOOK_FLAG(), uint8(4))),
            abi.encode(ENTITY | policy5.EXEC_HOOK_FLAG())
        );
        return abi.encodeCall(
            BootstrapAccount.installValidation,
            (
                bytes25(abi.encodePacked(singleSigner, ENTITY, uint8(1))),
                selectors,
                abi.encode(ENTITY, vm.addr(SESSION_PK)),
                hooks
            )
        );
    }

    /// @dev The semi-modular owner authorizes this op with the account's deferred-action nonce. The deferred
    ///      call only installs the session (account-associated storage). The token approve and credit deposit
    ///      run later, in execution.
    function _owner(bytes memory callData, uint256 callGas) internal view returns (EpOp memory op) {
        op.sender = smart;
        op.nonce = uint256(3) << 64;
        op.initCode = abi.encodePacked(factory, abi.encodeCall(BootstrapFactory.createSemiModularAccount, (user, 0)));
        op.callData = callData;
        op = _limits(op, 900_000, callGas);
        uint256 maxTok = _need(op);
        if (maxTok < 1 ether) maxTok = 1 ether;
        op = _sign(op, maxTok, false, true);
        bytes memory install = _install();
        uint48 deadline = uint48(block.timestamp + 120);
        bytes32 domain = keccak256(
            abi.encode(keccak256("EIP712Domain(uint256 chainId,address verifyingContract)"), block.chainid, smart)
        );
        bytes32 action = keccak256(
            abi.encode(
                keccak256("DeferredAction(uint256 nonce,uint48 deadline,bytes call)"),
                op.nonce,
                deadline,
                keccak256(install)
            )
        );
        bytes memory auth =
            abi.encodePacked(uint8(0), _nativeSig(userPk, MessageHashUtils.toTypedDataHash(domain, action)));
        bytes memory encoded = abi.encodePacked(uint168(1), deadline, install);
        op.signature = abi.encodePacked(
            uint32(encoded.length),
            encoded,
            uint32(auth.length),
            auth,
            hex"ff00",
            _nativeSig(userPk, MessageHashUtils.toEthSignedMessageHash(ep.getUserOpHash(op)))
        );
    }

    function _session(bytes memory inner, uint256 callGas, bool launch) internal view returns (EpOp memory op) {
        op.sender = smart;
        op.nonce = (uint256(ENTITY) << 72) | sessionNonce;
        op.callData = abi.encodePacked(bytes4(0x8dd7712f), inner);
        op = _limits(op, 500_000, callGas);
        op = _sign(op, _need(op), launch, false);
        op.signature =
            abi.encodePacked(hex"ff00", _nativeSig(SESSION_PK, MessageHashUtils.toEthSignedMessageHash(ep.getUserOpHash(op))));
    }

    function _measure(string memory label, EpOp memory op) internal returns (uint256 used) {
        vm.recordLogs();
        _send(op);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(ep) && logs[i].topics[0] == IEntryPoint.UserOperationEvent.selector) {
                (, bool ok, uint256 cost, uint256 gasUsed) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                assertTrue(ok, label);
                used = gasUsed;
                console2.log(label, gasUsed);
                console2.log("usdg6rawAt0.01gwei", _usdg6(gasUsed));
                console2.log("receiptWei", cost);
                found = true;
            }
        }
        assertTrue(found, label);
        assertEq(smart.balance, 0);
    }

    function _setupCalls(uint256 fund) internal view returns (bytes memory) {
        MiniAccount.Call[] memory calls = new MiniAccount.Call[](2);
        calls[0] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(v5), fund)));
        calls[1] = MiniAccount.Call(address(v5), 0, abi.encodeWithSelector(DEPOSIT_SEL, smart, fund));
        return abi.encodeCall(MiniAccount.executeBatch, (calls));
    }

    function _tap(bool sell, uint256 amount, bool topUp) internal returns (bytes memory) {
        (uint256 quoted,) = DiscipleRouter(address(trade)).quoteUsdgRouteFor(smart, address(bought), !sell, amount);
        uint256 minOut = quoted * 995 / 1000;
        uint256 n = topUp ? 4 : 2;
        MiniAccount.Call[] memory calls = new MiniAccount.Call[](n);
        uint256 i;
        if (topUp) {
            calls[i++] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(v5), 1 ether)));
            calls[i++] = MiniAccount.Call(address(v5), 0, abi.encodeWithSelector(DEPOSIT_SEL, smart, 1 ether));
        }
        calls[i++] = MiniAccount.Call(
            sell ? address(bought) : address(usdg), 0, abi.encodeCall(ERC20.approve, (address(trade), amount))
        );
        calls[i] = MiniAccount.Call(
            address(trade),
            0,
            sell
                ? abi.encodeCall(DiscipleRouter.sellToUsdg, (address(bought), amount, minOut, block.timestamp + 60))
                : abi.encodeCall(DiscipleRouter.buyWithUsdg, (address(bought), amount, minOut, block.timestamp + 60))
        );
        return abi.encodeCall(MiniAccount.executeBatch, (calls));
    }

    function test_runtimeGas_setup_buy_sell_graduation_topup_withdraw() public {
        vm.prank(owner);
        v5.setBootstrapGasLimit(4_000_000);
        uint256 used = _measure("setupDeployDepositInstall", _owner(_setupCalls(5 ether), 1_200_000));
        assertGt(used, 0);
        assertTrue(v5.bootstrapUsed(smart));
        assertGt(v5.creditOf(smart), 0);
        console2.log("setupCodehash");
        console2.logBytes32(smart.codehash);
        sessionNonce = 0;
        _measure("warmTwoHopCurveBuy", _session(_tap(false, 10 ether, false), 4_500_000, false));
        sessionNonce++;
        _measure("warmTwoHopCurveSell", _session(_tap(true, bought.balanceOf(smart) / 4, false), 4_500_000, false));
        sessionNonce++;
        market.approachGraduation();
        _measure("graduatingTwoHopBuy", _session(_tap(false, 1000 ether, false), 4_500_000, false));
        sessionNonce++;
        assertTrue(market.curve().graduated());
        _measure("warmTwoHopV4Buy", _session(_tap(false, 10 ether, true), 4_500_000, false));
        sessionNonce++;
        _measure(
            "withdrawRemainingCredit",
            _session(
                abi.encodeCall(MiniAccount.execute, (address(v5), 0, abi.encodeWithSelector(v5.withdraw.selector))),
                500_000,
                false
            )
        );
        assertEq(v5.creditOf(smart), 0);
        console2.log("directPostOpCeiling", uint256(150_000));
    }

    function _filled(uint256 n) internal pure returns (string memory) {
        bytes memory v = new bytes(n);
        for (uint256 i; i < n; ++i) v[i] = bytes1(uint8(97 + (i % 26)));
        return string(v);
    }

    function test_runtimeGas_launchWithMode() public {
        launchTarget = market.launchpadAddress();
        vm.prank(owner);
        v5.setBootstrapGasLimit(4_000_000);
        _measure("setupBeforeLaunch", _owner(_setupCalls(8 ether), 1_200_000));
        sessionNonce = 0;
        ILaunchpad.LaunchParams memory p = ILaunchpad.LaunchParams({
            name: _filled(31),
            ticker: _filled(10),
            imageURI: _filled(96),
            description: _filled(512),
            socialsURI: _filled(256),
            quote: address(usdg),
            creatorTaxBps: 100,
            creatorBuyQuoteIn: 0,
            creatorBuyMinTokensOut: 0,
            deadline: block.timestamp + 60
        });
        bytes memory inner = abi.encodeCall(
            MiniAccount.execute, (launchTarget, 0, abi.encodeCall(Launchpad.launchWithMode, (p, uint8(0))))
        );
        _measure("launchWithModeNoBoost", _session(inner, 14_000_000, true));
    }
}
