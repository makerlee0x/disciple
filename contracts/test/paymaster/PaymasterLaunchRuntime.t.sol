// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {PaymasterBootstrapFixture, BootstrapBuy, BootstrapAccount} from "./PaymasterBootstrap.t.sol";
import {RuntimeMarket} from "./PaymasterRuntime.t.sol";
import {MockUSDG, MiniAccount} from "./PaymasterTestBase.sol";
import {PackedUserOperation as EpOp} from "../vendor/aa-v07/interfaces/PackedUserOperation.sol";
import {PackedUserOperation as PmOp} from "../../src/paymaster/IPaymasterV07.sol";
import {IEntryPoint} from "../vendor/aa-v07/interfaces/IEntryPoint.sol";
import {DisciplePaymaster} from "../../src/paymaster/DisciplePaymaster.sol";
import {DiscipleSessionPolicy as Policy} from "../../src/session/DiscipleSessionPolicy.sol";
import {DiscipleRouter} from "../../src/DiscipleRouter.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {AnonLauncher} from "../../src/addons/AnonLauncher.sol";
import {LoginGate} from "../../src/LoginGate.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

/// ERC-5564 singleton behavior: no storage, canonical announcement event and caller.
contract RuntimeAnnouncer {
    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    function announce(uint256 schemeId, address stealthAddress, bytes calldata ephemeralPubKey, bytes calldata metadata)
        external
    {
        emit Announcement(schemeId, stealthAddress, msg.sender, ephemeralPubKey, metadata);
    }
}

/// Launch paths through canonical Alchemy MAv2 and the real EntryPoint, not mocked gas estimates.
/// Each case measures first deployment + native allowance bootstrap + session install, then a warm session launch.
/// Metadata fixture: 31-byte name, 10-byte ticker, 96-byte image, 512-byte description, 256-byte socials.
contract PaymasterLaunchRuntimeTest is PaymasterBootstrapFixture {
    RuntimeMarket market;
    address lp;
    address anon;
    address gate;
    address pair;
    uint8 kind; // 0 direct Launchpad, 1 USDG router, 2 AnonLauncher
    uint8 mode;
    uint256 boost;
    address quoteAsset;
    uint256 minQuoteIn;
    uint256 constant FEE = 10_000_000; // RH fixture gas price, not a live USD/ETH price
    uint256 constant MAX_LAUNCH_GAS = 21_840_770; // 2x worst measured launch: 10,920,385 gas

    function setUp() public override {
        super.setUp();
        market = new RuntimeMarket();
        market.prepare(smart);
        lp = market.launchpadAddress();
        pair = market.strategyAddress();
        (anon, gate) = market.prepareLaunches(address(new RuntimeAnnouncer()));
        usdg = MockUSDG(market.usdgAddress());
        rate = 3000 ether;
        dec = 18;
        pm = new DisciplePaymaster(EP, address(usdg), owner, signer, treasury, rate / 10, rate * 10, 7_068_712, 79_684);
        vm.prank(owner);
        pm.setLaunchGasLimit(MAX_LAUNCH_GAS);
        pm.deposit{value: uint256(1 ether) / 3000}(); // ~$1 at the EXAMPLE fixture rate; no keeper
        vm.fee(0);
        trade = BootstrapBuy(market.routerAddress());
        policy = new Policy(address(0), address(pm));
    }

    function _install() internal view override returns (bytes memory) {
        Policy.SessionConfig memory cfg;
        cfg.validUntil = uint48(block.timestamp + 1 days);
        cfg.permissions = policy.P_LAUNCH() | policy.P_ANON_LAUNCH() | policy.P_APPROVE();
        cfg.router = address(trade);
        cfg.launchpad = lp;
        cfg.anonLauncher = anon;
        cfg.quote0 = address(usdg);
        cfg.cap0 = type(uint128).max;
        cfg.quote1 = pair;
        cfg.cap1 = type(uint128).max;
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = MiniAccount.execute.selector;
        selectors[1] = MiniAccount.executeBatch.selector;
        bytes[] memory hooks = new bytes[](2);
        hooks[0] =
            abi.encodePacked(bytes25(abi.encodePacked(address(policy), ENTITY, uint8(1))), abi.encode(ENTITY, cfg));
        hooks[1] = abi.encodePacked(
            bytes25(abi.encodePacked(address(policy), ENTITY | policy.EXEC_HOOK_FLAG(), uint8(4))),
            abi.encode(ENTITY | policy.EXEC_HOOK_FLAG())
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

    function _filled(uint256 n) internal pure returns (string memory) {
        bytes memory v = new bytes(n);
        for (uint256 i; i < n; ++i) {
            v[i] = bytes1(uint8(97 + i % 26));
        }
        return string(v);
    }

    function _buyCalls(bool install) internal view override returns (bytes memory) {
        MiniAccount.Call[] memory calls = new MiniAccount.Call[](8);
        uint256 i;
        calls[i++] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(pm), type(uint256).max)));
        if (install) calls[i++] = MiniAccount.Call(smart, 0, _install());
        if (mode == 1 && install) {
            uint64 expiry = uint64(block.timestamp + 1 hours);
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xA77E57, LoginGate(gate).digest(smart, expiry));
            calls[i++] = MiniAccount.Call(
                gate, 0, abi.encodeCall(LoginGate.attest, (smart, expiry, abi.encodePacked(r, s, v)))
            );
        }
        address spender = kind == 0 ? lp : kind == 1 ? address(trade) : anon;
        if (kind == 2) {
            calls[i++] = MiniAccount.Call(
                address(usdg),
                0,
                abi.encodeCall(ERC20.approve, (anon, 0.5 ether + (quoteAsset == address(usdg) ? boost : 0)))
            );
        }
        if (boost > 0 && !(kind == 2 && quoteAsset == address(usdg))) {
            calls[i++] = MiniAccount.Call(
                kind == 1 ? address(usdg) : quoteAsset, 0, abi.encodeCall(ERC20.approve, (spender, boost))
            );
        }
        ILaunchpad.LaunchParams memory p = ILaunchpad.LaunchParams({
            name: _filled(31),
            ticker: _filled(10),
            imageURI: _filled(96),
            description: _filled(512),
            socialsURI: _filled(256),
            quote: quoteAsset,
            creatorTaxBps: 100,
            creatorBuyQuoteIn: kind == 1 ? 0 : boost,
            creatorBuyMinTokensOut: 0,
            deadline: block.timestamp + 60
        });
        bytes memory data;
        if (kind == 0) data = abi.encodeCall(Launchpad.launchWithMode, (p, mode));
        else if (kind == 1) data = abi.encodeCall(DiscipleRouter.launchWithUsdg, (p, mode, boost, minQuoteIn));
        else data = abi.encodeCall(AnonLauncher.launchAnon, (p, smart, smart, new bytes(64), bytes1(0), 0.5 ether));
        calls[i++] = MiniAccount.Call(spender, 0, data);
        assembly ("memory-safe") { mstore(calls, i) }
        return abi.encodeCall(MiniAccount.executeBatch, (calls));
    }

    function _pmPrefix() internal view override returns (bytes memory) {
        return abi.encodePacked(address(pm), uint128(PM_VERIF_GAS), uint128(79_684));
    }

    function _launchSignature(EpOp memory op) internal view returns (EpOp memory) {
        uint48 until = uint48(block.timestamp + 120);
        uint48 afterTs = uint48(block.timestamp - 10);
        uint256 ceiling = pm.tokenCost(MAX_LAUNCH_GAS * FEE, rate);
        op.paymasterAndData = abi.encodePacked(_pmPrefix(), until, afterTs, rate, ceiling, new bytes(65));
        PmOp memory packed = abi.decode(abi.encode(op), (PmOp));
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(pm.getLaunchOpHash(packed, until, afterTs, rate, ceiling));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, h);
        op.paymasterAndData = abi.encodePacked(_pmPrefix(), until, afterTs, rate, ceiling, r, s, v);
        return op;
    }

    function _base(bool bootstrap) internal view override returns (EpOp memory op) {
        op = super._base(bootstrap);
        op.gasFees = bytes32((FEE << 128) | FEE);
        op.accountGasLimits = bytes32((uint256(500_000) << 128) | uint256(14_000_000));
        return _launchSignature(op);
    }

    function _measure(string memory label, EpOp memory op) internal {
        vm.recordLogs();
        _send(op);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        uint256 gasBill;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(pm)
                    && logs[i].topics[0] == keccak256("UserOperationCharged(bytes32,address,uint256,uint256,uint256)")
            ) {
                (gasBill,,) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            }
            if (logs[i].emitter == address(ep) && logs[i].topics[0] == IEntryPoint.UserOperationEvent.selector) {
                (, bool ok, uint256 cost, uint256 used) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                assertTrue(ok, label);
                assertLe(used, MAX_LAUNCH_GAS / 2, "launch exceeds its measured calibration; remeasure and review cap");
                console2.log(label, used);
                console2.log("receiptActualWeiCost", cost);
                found = true;
                assertGe(gasBill, pm.tokenCost(cost, rate), "each operation's gas fully prepaid and settled");
                console2.log("settlementEstimatedExcessUSDGRaw", gasBill - pm.tokenCost(cost, rate));
            }
        }
        assertTrue(found);
        assertEq(smart.balance, 0);
        assertEq(pm.owedOf(smart), 0);
    }

    function _refreshQuote() internal {
        if (kind == 1 && boost > 0 && quoteAsset != address(usdg)) {
            (uint256 out,) = DiscipleRouter(address(trade)).quoteUsdgQuoteSwap(quoteAsset, true, boost);
            minQuoteIn = out * 995 / 1000;
        }
    }

    function _run(string memory label, uint8 k, uint8 m, bool b, bool twoHop) internal {
        kind = k;
        mode = m;
        boost = b ? 1000 ether : 0;
        quoteAsset = twoHop ? pair : address(usdg);
        // Legacy private/direct pair-denominated BOOST requires pair tokens; USDG-router paths require only USDG.
        if (k != 1 && twoHop && b) MockUSDG(pair).mint(smart, 10_000 ether);
        _refreshQuote();
        _measure(string.concat(label, ":bootstrap"), _bootstrap(userPk));
        _refreshQuote();
        EpOp memory op = _base(false);
        op.signature = abi.encodePacked(
            hex"ff00", _nativeSig(SESSION_PK, MessageHashUtils.toEthSignedMessageHash(ep.getUserOpHash(op)))
        );
        _measure(string.concat(label, ":warm"), op);
    }

    function test_runtimeLaunch_directTrenchNoBoostUsdg() public {
        _run("directTrenchNoBoostUsdg", 0, 0, false, false);
    }

    function test_runtimeLaunch_directTrenchBoostUsdg() public {
        _run("directTrenchBoostUsdg", 0, 0, true, false);
    }

    function test_runtimeLaunch_directTrenchBoostPair() public {
        _run("directTrenchBoostPair", 0, 0, true, true);
    }

    function test_runtimeLaunch_directEasyNoBoostUsdg() public {
        _run("directEasyNoBoostUsdg", 0, 1, false, false);
    }

    function test_runtimeLaunch_directEasyBoostUsdg() public {
        _run("directEasyBoostUsdg", 0, 1, true, false);
    }

    function test_runtimeLaunch_directEasyBoostPair() public {
        _run("directEasyBoostPair", 0, 1, true, true);
    }

    function test_runtimeLaunch_directHardNoBoostUsdg() public {
        _run("directHardNoBoostUsdg", 0, 2, false, false);
    }

    function test_runtimeLaunch_directHardBoostUsdg() public {
        _run("directHardBoostUsdg", 0, 2, true, false);
    }

    function test_runtimeLaunch_directHardBoostPair() public {
        _run("directHardBoostPair", 0, 2, true, true);
    }

    function test_runtimeLaunch_launchWithUsdgTrenchNoBoostUsdg() public {
        _run("launchWithUsdgTrenchNoBoostUsdg", 1, 0, false, false);
    }

    function test_runtimeLaunch_launchWithUsdgTrenchNoBoostTwoHop() public {
        _run("launchWithUsdgTrenchNoBoostTwoHop", 1, 0, false, true);
    }

    function test_runtimeLaunch_launchWithUsdgTrenchBoostUsdg() public {
        _run("launchWithUsdgTrenchBoostUsdg", 1, 0, true, false);
    }

    function test_runtimeLaunch_launchWithUsdgTrenchBoostTwoHop() public {
        _run("launchWithUsdgTrenchBoostTwoHop", 1, 0, true, true);
    }

    function test_runtimeLaunch_launchWithUsdgEasyNoBoostUsdg() public {
        _run("launchWithUsdgEasyNoBoostUsdg", 1, 1, false, false);
    }

    function test_runtimeLaunch_launchWithUsdgEasyNoBoostTwoHop() public {
        _run("launchWithUsdgEasyNoBoostTwoHop", 1, 1, false, true);
    }

    function test_runtimeLaunch_launchWithUsdgEasyBoostUsdg() public {
        _run("launchWithUsdgEasyBoostUsdg", 1, 1, true, false);
    }

    function test_runtimeLaunch_launchWithUsdgEasyBoostTwoHop() public {
        _run("launchWithUsdgEasyBoostTwoHop", 1, 1, true, true);
    }

    function test_runtimeLaunch_launchWithUsdgHardNoBoostUsdg() public {
        _run("launchWithUsdgHardNoBoostUsdg", 1, 2, false, false);
    }

    function test_runtimeLaunch_launchWithUsdgHardNoBoostTwoHop() public {
        _run("launchWithUsdgHardNoBoostTwoHop", 1, 2, false, true);
    }

    function test_runtimeLaunch_launchWithUsdgHardBoostUsdg() public {
        _run("launchWithUsdgHardBoostUsdg", 1, 2, true, false);
    }

    function test_runtimeLaunch_launchWithUsdgHardBoostTwoHop() public {
        _run("launchWithUsdgHardBoostTwoHop", 1, 2, true, true);
    }

    function test_runtimeLaunch_launchAnonNoBoostUsdg() public {
        _run("launchAnonNoBoostUsdg", 2, 0, false, false);
    }

    function test_runtimeLaunch_launchAnonNoBoostPair() public {
        _run("launchAnonNoBoostPair", 2, 0, false, true);
    }

    function test_runtimeLaunch_launchAnonBoostUsdg() public {
        _run("launchAnonBoostUsdg", 2, 0, true, false);
    }

    function test_runtimeLaunch_launchAnonBoostPair() public {
        _run("launchAnonBoostPair", 2, 0, true, true);
    }
}
