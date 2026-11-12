// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {PaymasterBootstrapFixture, BootstrapBuy} from "./PaymasterBootstrap.t.sol";
import {MockUSDG, MiniAccount} from "./PaymasterTestBase.sol";
import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {AnonLauncher} from "../../src/addons/AnonLauncher.sol";
import {LoginGate} from "../../src/LoginGate.sol";
import {DiscipleRouter} from "../../src/DiscipleRouter.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {Token} from "../../src/Token.sol";
import {DisciplePaymaster} from "../../src/paymaster/DisciplePaymaster.sol";
import {DiscipleSessionPolicy as Policy} from "../../src/session/DiscipleSessionPolicy.sol";
import {PackedUserOperation as EpOp} from "../vendor/aa-v07/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "../vendor/aa-v07/interfaces/IEntryPoint.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

/// Production curve, migration, v4, hook and USDG router; composed with canonical MAv2 and real EntryPoint.
contract RuntimeMarket is IntegrationBase {
    BondingCurve public curve;
    Token public token;
    function prepare(address player) external {
        setUp();
        router.setUsdgRouting(address(quote), address(launchpad));
        router.setUsdgPool(address(strategy), strategyUsdgKey);
        (curve, token) = _launchWithQuote(address(strategy), 100, 0);
        quote.mint(player, 10_000 ether);
        _warpPastSnipe();
    }
    function launchpadAddress() external view returns (address) { return address(launchpad); }
    function strategyAddress() external view returns (address) { return address(strategy); }
    function prepareLaunches(address announcer) external returns (address anon, address gate) {
        gate = address(new LoginGate(owner, vm.addr(0xA77E57)));
        vm.prank(owner); launchpad.setLoginGate(gate);
        anon = address(new AnonLauncher(owner, address(launchpad), address(feeRouter), address(quote), treasury, announcer, 0.5 ether));
    }
    function usdgAddress() external view returns (address) { return address(quote); }
    function routerAddress() external view returns (address) { return address(router); }
    function approachGraduation() external {
        _warpPastSnipe();
        for (uint256 i; i < 100; ++i) {
            if (curve.quoteBuy(400 ether).graduates) return;
            address w = makeAddr(string(abi.encodePacked("runtimeGraduate", vm.toString(i))));
            MockUSDG q = MockUSDG(address(curve.quote()));
            q.mint(w, 50_000 ether);
            vm.startPrank(w);
            q.approve(address(curve), 400 ether);
            curve.buy(400 ether, 0, block.timestamp + 1);
            vm.stopPrank();
        }
        revert("did not approach graduation");
    }
}
contract PaymasterRuntimeTest is PaymasterBootstrapFixture {
    RuntimeMarket market;
    uint256 sessionNonce;
    function setUp() public override {
        super.setUp();
        market = new RuntimeMarket(); market.prepare(smart);
        usdg = MockUSDG(market.usdgAddress()); rate = 3000 ether; dec = 18;
        pm = new DisciplePaymaster(EP, address(usdg), owner, signer, treasury, rate / 10, rate * 10, 7_068_712, 79_684);
        pm.deposit{value: uint256(1 ether) / 3000}(); // ~$1 at the stated test oracle rate, no large-float assumption
        vm.fee(0);
        trade = BootstrapBuy(market.routerAddress()); bought = MockUSDG(address(market.token()));
        policy = new Policy(address(0), address(pm));
    }
    function _buyCalls(bool install) internal view override returns (bytes memory) {
        MiniAccount.Call[] memory calls = new MiniAccount.Call[](install ? 4 : 3);
        calls[0] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(pm), type(uint256).max)));
        uint256 i = 1;
        if (install) calls[i++] = MiniAccount.Call(smart, 0, _install());
        calls[i++] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(trade), 10 ether)));
        calls[i] = MiniAccount.Call(address(trade), 0, abi.encodeCall(DiscipleRouter.buyWithUsdg, (address(bought), 10 ether, 1, block.timestamp + 60)));
        return abi.encodeCall(MiniAccount.executeBatch, (calls));
    }
    // Observed Robinhood testnet eth_gasPrice 2026-11-05 5:11 PM CT: 10,000,000 wei (0.01 gwei).
    uint256 constant MEASURED_FEE = 10_000_000;
    function _pmPrefix() internal view override returns (bytes memory) {
        return abi.encodePacked(address(pm), uint128(PM_VERIF_GAS), uint128(79_684));
    }
    function _base(bool bootstrap) internal view override returns (EpOp memory op) {
        op = super._base(bootstrap);
        op.gasFees = bytes32((MEASURED_FEE << 128) | MEASURED_FEE);
        op.accountGasLimits = bytes32((uint256(500_000) << 128) | uint256(4_500_000));
        op = _signPm(op, uint48(block.timestamp + 120), uint48(block.timestamp - 10), rate,
            pm.tokenCost((500_000 + 4_500_000 + 100_000 + PM_VERIF_GAS + 79_684) * MEASURED_FEE, rate), signerPk);
    }
    function _tap(bool sell, uint256 amount) internal returns (EpOp memory op) {
        (uint256 quoted,) = DiscipleRouter(address(trade)).quoteUsdgRouteFor(smart, address(bought), !sell, amount);
        uint256 minOut = quoted * 995 / 1000;
        op = _base(false); op.nonce = (uint256(ENTITY) << 72) | sessionNonce;
        MiniAccount.Call[] memory calls = new MiniAccount.Call[](3);
        calls[0] = MiniAccount.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(pm), type(uint256).max)));
        calls[1] = MiniAccount.Call(sell ? address(bought) : address(usdg), 0, abi.encodeCall(ERC20.approve, (address(trade), amount)));
        calls[2] = MiniAccount.Call(address(trade), 0, sell
            ? abi.encodeCall(DiscipleRouter.sellToUsdg, (address(bought), amount, minOut, block.timestamp + 60))
            : abi.encodeCall(DiscipleRouter.buyWithUsdg, (address(bought), amount, minOut, block.timestamp + 60)));
        op.callData = abi.encodePacked(bytes4(0x8dd7712f), abi.encodeCall(MiniAccount.executeBatch, (calls)));
        op.signature = abi.encodePacked(hex"ff00", _nativeSig(SESSION_PK, MessageHashUtils.toEthSignedMessageHash(ep.getUserOpHash(op))));
    }
    function _measure(string memory label, EpOp memory op) internal {
        vm.recordLogs(); _send(op); Vm.Log[] memory logs = vm.getRecordedLogs(); bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(ep) && logs[i].topics[0] == IEntryPoint.UserOperationEvent.selector) {
                (, bool ok, uint256 cost, uint256 used) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                assertTrue(ok, label); console2.log(label, used); console2.log("receiptActualWeiCost", cost); found = true;
            }
        }
        assertTrue(found); assertEq(smart.balance, 0);
    }
    function test_runtimeGas_bootstrapBuy_sell_graduation_v4BuySell() public {
        _measure("bootstrapDeployInstallTwoHopBuy", _bootstrap(userPk));
        _measure("warmTwoHopCurveBuy", _tap(false, 10 ether)); sessionNonce++;
        _measure("warmTwoHopCurveSell", _tap(true, bought.balanceOf(smart) / 4)); sessionNonce++;
        market.approachGraduation();
        _measure("graduatingTwoHopBuy", _tap(false, 1000 ether)); sessionNonce++;
        assertTrue(market.curve().graduated());
        _measure("warmTwoHopV4Buy", _tap(false, 10 ether)); sessionNonce++;
        _measure("warmTwoHopV4Sell", _tap(true, bought.balanceOf(smart) / 4));
    }
}
