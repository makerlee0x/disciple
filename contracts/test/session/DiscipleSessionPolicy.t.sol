// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {DiscipleSessionPolicy as P} from "../../src/session/DiscipleSessionPolicy.sol";
import {PackedUserOperation} from "../../src/session/IERC6900.sol";
import {ReferralRegistry} from "../../src/ReferralRegistry.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {AnonLauncher} from "../../src/addons/AnonLauncher.sol";

contract MockAnon {
    address public feeToken;

    constructor(address f) {
        feeToken = f;
    }

    function launchFee() external pure returns (uint256) {
        return 0;
    }

    fallback() external {}
}

contract TKN is ERC20 {
    constructor(string memory n) ERC20(n, n) {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

contract MockRouter {
    TKN public quote;

    constructor(TKN q) {
        quote = q;
    }

    function buyExactIn(address token, uint256 quoteIn, uint256, address recipient, uint256) external returns (uint256) {
        quote.transferFrom(msg.sender, address(this), quoteIn);
        TKN(token).mint(recipient, quoteIn);
        return quoteIn;
    }

    function sellExactIn(address token, uint256 tokensIn, uint256, address recipient, uint256) external returns (uint256) {
        TKN(token).transferFrom(msg.sender, address(this), tokensIn);
        quote.mint(recipient, tokensIn);
        return tokensIn;
    }

    uint256 public quoteBps = 10_000; // quote = amountIn * quoteBps / 1e4 (mock 1:1 pool)

    function setQuoteBps(uint256 b) external {
        quoteBps = b;
    }

    function quoteExactIn(address, bool, uint256 amountIn) external view returns (uint256, uint256, uint256) {
        return (amountIn * quoteBps / 10_000, 0, 0);
    }

    function sweep(address to) external {} // not allowlisted
}

contract MockCurve {
    address public token;
    TKN public quote;

    constructor(address t, TKN q) {
        token = t;
        quote = q;
    }

    struct BuyQuote {
        uint256 tokensOut;
        uint256 fee;
    }

    function quoteBuy(uint256 q) external pure returns (BuyQuote memory) {
        return BuyQuote(q, 0);
    }

    function quoteSell(uint256 t) external pure returns (BuyQuote memory) {
        return BuyQuote(t, 0);
    }

    function quoteBuyFor(address, uint256 q) external pure returns (BuyQuote memory) {
        return BuyQuote(q, 0);
    }

    function quoteSellFor(address, uint256 t) external pure returns (BuyQuote memory) {
        return BuyQuote(t, 0);
    }

    function buy(uint256 q, uint256, uint256, address recipient) external returns (uint256) {
        quote.transferFrom(msg.sender, address(this), q);
        TKN(token).mint(recipient, q);
        return q;
    }

    function buy(uint256 q, uint256, uint256) external returns (uint256) {
        quote.transferFrom(msg.sender, address(this), q);
        TKN(token).mint(msg.sender, q);
        return q;
    }
}

contract MockLaunchpad {
    mapping(address => address) public curveOf;
    address public defaultQuote;

    function setDefaultQuote(address q) external {
        defaultQuote = q;
    }

    function set(address t, address c) external {
        curveOf[t] = c;
    }
}

contract MockTWM {
    TKN quote;
    mapping(uint256 => address) public ownerOf;
    uint256 n;

    constructor(TKN q) {
        quote = q;
    }

    function placeTramp(address, int24, int24, uint256 amt, uint128, uint256) external returns (uint256 id, uint128) {
        quote.transferFrom(msg.sender, address(this), amt);
        id = ++n;
        ownerOf[id] = msg.sender;
        return (id, 1);
    }

    function cancel(uint256 id) external returns (uint256, uint256) {
        require(ownerOf[id] == msg.sender, "owner");
        delete ownerOf[id];
        return (0, 0);
    }
}

/// @dev Minimal stand-in for MAv2 SemiModularAccount's hook dispatch for one session validation:
///      owner = full control (no hooks); session key = validation hook + validation-associated execution hook.
contract MockMAv2 {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    address public owner;
    address public sessionKey;
    P public policy;
    uint32 public entity;

    constructor(address o) {
        owner = o;
    }

    receive() external payable {}

    function installSession(P p, uint32 e, address key, P.SessionConfig memory cfg) external {
        require(msg.sender == owner, "owner");
        policy = p;
        entity = e;
        sessionKey = key;
        p.onInstall(abi.encode(e, cfg));
        p.onInstall(abi.encode(e | p.EXEC_HOOK_FLAG()));
    }

    function uninstallSession() external {
        require(msg.sender == owner, "owner");
        policy.onUninstall(abi.encode(entity));
        policy.onUninstall(abi.encode(entity | policy.EXEC_HOOK_FLAG()));
        sessionKey = address(0);
    }

    /// @dev Mirrors MAv2 ModularAccountBase.executeUserOp: validation-associated pre-exec hooks receive the
    ///      FULL `msg.data` (executeUserOp selector + abi(PackedUserOperation, bytes32)), sender = EntryPoint,
    ///      then the account self-calls `userOp.callData[4:]` (self-calls skip validation hooks).
    address public constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    function executeUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash) external {
        require(msg.sender == ENTRY_POINT, "ep");
        policy.preUserOpValidationHook(entity, userOp, userOpHash); // EntryPoint validation phase (simplified)
        policy.preExecutionHook(entity | policy.EXEC_HOOK_FLAG(), msg.sender, 0, msg.data);
        (bool ok, bytes memory r) = address(this).call(userOp.callData[4:]);
        if (!ok) assembly { revert(add(r, 32), mload(r)) }
    }

    function _auth() internal {
        if (msg.sender == owner || msg.sender == address(this)) return;
        require(msg.sender == sessionKey && sessionKey != address(0), "unauthorized");
        policy.preRuntimeValidationHook(entity, msg.sender, msg.value, msg.data, "");
        policy.preExecutionHook(entity | policy.EXEC_HOOK_FLAG(), msg.sender, msg.value, msg.data);
    }

    function execute(address t, uint256 v, bytes calldata d) external payable {
        _auth();
        (bool ok, bytes memory r) = t.call{value: v}(d);
        if (!ok) assembly { revert(add(r, 32), mload(r)) }
    }

    function executeBatch(Call[] calldata calls) external payable {
        _auth();
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory r) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) assembly { revert(add(r, 32), mload(r)) }
        }
    }

    function userOpHook(bytes calldata callData) external returns (uint256) {
        PackedUserOperation memory op;
        op.sender = address(this);
        op.callData = callData;
        return policy.preUserOpValidationHook(entity, op, bytes32(0));
    }
}

/// @dev AnonLauncher v2 (redeploy pack): launchAnon(..., uint256 maxFee). The AnonLauncher contract change lives on
///      feat/redeploy-pack; this branch pins the policy to the v2 selector.
bytes4 constant ANON_LAUNCH_V2 = bytes4(
    keccak256(
        "launchAnon((string,string,string,string,string,address,uint256,uint256,uint256,uint256),address,address,bytes,bytes1,uint256)"
    )
);

contract DiscipleSessionPolicyTest is Test {
    P policy;
    ReferralRegistry registry;
    TKN usdg;
    TKN rocket;
    TKN rocket2;
    MockRouter router;
    MockLaunchpad lp;
    MockCurve curve;
    MockCurve fakeCurve;
    MockTWM twm;
    MockMAv2 acct;
    address owner = makeAddr("owner");
    address key = makeAddr("sessionKey");
    address attacker = makeAddr("attacker");
    uint32 constant E = 8;
    uint128 constant CAP = 100e18;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new TKN("USDG");
        registry = new ReferralRegistry(address(this), address(usdg));
        policy = new P(address(registry), address(0));
        rocket = new TKN("RKT");
        rocket2 = new TKN("RKT2");
        router = new MockRouter(usdg);
        lp = new MockLaunchpad();
        curve = new MockCurve(address(rocket2), usdg);
        fakeCurve = new MockCurve(address(rocket2), usdg); // not registered
        lp.set(address(rocket2), address(curve));
        lp.set(address(rocket), address(new MockCurve(address(rocket), usdg))); // router-traded rocket's quote
        twm = new MockTWM(usdg);
        acct = new MockMAv2(owner);
        usdg.mint(address(acct), 1000e18);
        rocket.mint(address(acct), 1000e18);
        vm.deal(address(acct), 1 ether);
        vm.prank(owner);
        acct.installSession(policy, E, key, _cfg(uint48(block.timestamp + 24 hours)));
    }

    function _cfg(uint48 until) internal view returns (P.SessionConfig memory c) {
        c.validUntil = until;
        c.permissions = (1 << 10) - 1;
        c.router = address(router);
        c.launchpad = address(lp);
        c.anonLauncher = address(0xA11CE);
        c.trampWallManager = address(twm);
        c.quote0 = address(usdg);
        c.cap0 = CAP;
    }

    function _approve(address tok, address spender, uint256 a) internal pure returns (MockMAv2.Call memory) {
        return MockMAv2.Call(tok, 0, abi.encodeCall(ERC20.approve, (spender, a)));
    }

    function _buy(uint256 a, address recipient) internal view returns (MockMAv2.Call memory) {
        return MockMAv2.Call(
            address(router), 0, abi.encodeCall(MockRouter.buyExactIn, (address(rocket), a, a, recipient, block.timestamp))
        );
    }

    function _batch(MockMAv2.Call memory a, MockMAv2.Call memory b) internal {
        MockMAv2.Call[] memory cs = new MockMAv2.Call[](2);
        cs[0] = a;
        cs[1] = b;
        vm.prank(key);
        acct.executeBatch(cs);
    }

    function _expectBatchRevert(bytes memory err, MockMAv2.Call memory a, MockMAv2.Call memory b) internal {
        MockMAv2.Call[] memory cs = new MockMAv2.Call[](2);
        cs[0] = a;
        cs[1] = b;
        vm.prank(key);
        if (err.length == 0) vm.expectRevert();
        else vm.expectRevert(err);
        acct.executeBatch(cs);
    }

    // ───────── happy paths ─────────

    function test_routerBuyAndSell() public {
        _batch(_approve(address(usdg), address(router), 10e18), _buy(10e18, address(acct)));
        assertEq(rocket.balanceOf(address(acct)), 1010e18);
        _batch(
            _approve(address(rocket), address(router), 5e18),
            MockMAv2.Call(
                address(router),
                0,
                abi.encodeCall(MockRouter.sellExactIn, (address(rocket), 5e18, 5e18, address(acct), block.timestamp))
            )
        );
        assertEq(policy.sessionOf(address(acct), E).spent0, 10e18); // sells don't consume the quote cap
    }

    function test_registeredCurveBuy() public {
        _batch(
            _approve(address(usdg), address(curve), 3e18),
            MockMAv2.Call(
                address(curve), 0, abi.encodeWithSignature("buy(uint256,uint256,uint256,address)", 3e18, 3e18, 0, address(acct))
            )
        );
        assertEq(rocket2.balanceOf(address(acct)), 3e18);
    }

    function test_trampPlaceAndCancel() public {
        _batch(
            _approve(address(usdg), address(twm), 4e18),
            MockMAv2.Call(address(twm), 0, abi.encodeCall(MockTWM.placeTramp, (address(rocket), 0, 60, 4e18, 0, 0)))
        );
        assertEq(twm.ownerOf(1), address(acct));
        vm.prank(key);
        acct.execute(address(twm), 0, abi.encodeCall(MockTWM.cancel, (1)));
        assertEq(twm.ownerOf(1), address(0));
    }

    // ───────── target / selector restriction ─────────

    function test_rejectsNonDiscipleTarget() public {
        address evil = makeAddr("evil");
        vm.etch(evil, address(router).code);
        _expectBatchRevert("", _approve(address(usdg), evil, 1), _buy(1, address(acct)));
        vm.prank(key);
        vm.expectRevert(
            abi.encodeWithSelector(P.NotAllowed.selector, evil, MockRouter.buyExactIn.selector)
        );
        acct.execute(evil, 0, abi.encodeCall(MockRouter.buyExactIn, (address(rocket), 1, 0, address(acct), 0)));
    }

    function test_rejectsDisallowedSelectorOnAllowedTarget() public {
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(P.NotAllowed.selector, address(router), MockRouter.sweep.selector));
        acct.execute(address(router), 0, abi.encodeCall(MockRouter.sweep, (attacker)));
    }

    function test_rejectsUnregisteredCurve() public {
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(P.NotCurve.selector, address(fakeCurve)));
        acct.execute(
            address(fakeCurve), 0, abi.encodeWithSignature("buy(uint256,uint256,uint256)", 1, 1, 0)
        );
    }

    function test_permissionBitmaskRespected() public {
        P.SessionConfig memory c = _cfg(uint48(block.timestamp + 1 hours));
        c.permissions = policy.P_ROUTER_SELL() | policy.P_APPROVE(); // no buys
        vm.prank(owner);
        acct.installSession(policy, E, key, c);
        _expectBatchRevert(
            abi.encodeWithSelector(P.NotAllowed.selector, address(router), MockRouter.buyExactIn.selector),
            _approve(address(usdg), address(router), 1e18),
            _buy(1e18, address(acct))
        );
    }

    function test_rejectsAccountSelfCall() public {
        vm.prank(key);
        vm.expectRevert();
        acct.execute(address(acct), 0, abi.encodeCall(MockMAv2.uninstallSession, ()));
    }

    function test_cannotCallPolicyRevokeOrReconfigure() public {
        vm.prank(key);
        vm.expectRevert();
        acct.execute(address(policy), 0, abi.encodeCall(P.revoke, (E)));
    }

    // ───────── cannot move funds out ─────────

    function test_cannotTransferTokensOut() public {
        vm.startPrank(key);
        vm.expectRevert(abi.encodeWithSelector(P.NotAllowed.selector, address(usdg), ERC20.transfer.selector));
        acct.execute(address(usdg), 0, abi.encodeCall(ERC20.transfer, (attacker, 1)));
        vm.expectRevert(abi.encodeWithSelector(P.NotAllowed.selector, address(rocket), ERC20.transferFrom.selector));
        acct.execute(address(rocket), 0, abi.encodeCall(ERC20.transferFrom, (address(acct), attacker, 1)));
        vm.stopPrank();
    }

    function test_cannotApproveForeignSpender() public {
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(P.SpenderNotAllowed.selector, attacker));
        acct.execute(address(rocket), 0, abi.encodeCall(ERC20.approve, (attacker, type(uint256).max)));
    }

    function test_cannotBuyToForeignRecipient() public {
        _expectBatchRevert(
            abi.encodeWithSelector(P.RecipientNotAccount.selector),
            _approve(address(usdg), address(router), 1e18),
            _buy(1e18, attacker)
        );
    }

    function test_cannotCurveBuyToForeignRecipient() public {
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(P.RecipientNotAccount.selector));
        acct.execute(
            address(curve), 0, abi.encodeWithSignature("buy(uint256,uint256,uint256,address)", 1, 1, 0, attacker)
        );
    }

    function test_cannotSendEth() public {
        vm.prank(key);
        vm.expectRevert(P.EthValueNotAllowed.selector);
        acct.execute(attacker, 1 ether, "");
        assertEq(address(acct).balance, 1 ether);
    }

    // ───────── spend cap ─────────

    function test_capEnforcedAcrossCalls() public {
        _batch(_approve(address(usdg), address(router), 60e18), _buy(60e18, address(acct)));
        _expectBatchRevert(
            abi.encodeWithSelector(P.SpendCapExceeded.selector, address(usdg), 101e18, CAP),
            _approve(address(usdg), address(router), 41e18),
            _buy(41e18, address(acct))
        );
        _batch(_approve(address(usdg), address(router), 40e18), _buy(40e18, address(acct))); // exactly at cap
        assertEq(policy.sessionOf(address(acct), E).spent0, CAP);
    }

    /// @dev Audit #8: approvals are not counted; the cap counts quote actually spent.
    function test_capCountsActualSpendNotApprovals() public {
        _batch(_approve(address(usdg), address(router), 60e18), _approve(address(usdg), address(twm), 60e18));
        assertEq(policy.sessionOf(address(acct), E).spent0, 0);
        _expectBatchRevert(
            abi.encodeWithSelector(P.SpendCapExceeded.selector, address(usdg), 120e18, CAP),
            _buy(60e18, address(acct)),
            _buy(60e18, address(acct))
        );
    }

    /// @dev Audit #8 regression: a leftover / pre-existing allowance used to let buys skip the cap entirely.
    function test_audit8_leftoverAllowanceCannotBypassCap() public {
        vm.prank(owner); // owner grants a standing max allowance (no session hooks)
        acct.execute(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(router), type(uint256).max)));
        MockMAv2.Call[] memory cs = new MockMAv2.Call[](1);
        cs[0] = _buy(60e18, address(acct));
        vm.prank(key);
        acct.executeBatch(cs);
        assertEq(policy.sessionOf(address(acct), E).spent0, 60e18);
        cs[0] = _buy(41e18, address(acct));
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(P.SpendCapExceeded.selector, address(usdg), 101e18, CAP));
        acct.executeBatch(cs);
        // tramps also count
        cs[0] = MockMAv2.Call(address(twm), 0, abi.encodeCall(MockTWM.placeTramp, (address(rocket), 0, 60, 41e18, 0, 0)));
        vm.prank(owner);
        acct.execute(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(twm), type(uint256).max)));
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(P.SpendCapExceeded.selector, address(usdg), 101e18, CAP));
        acct.executeBatch(cs);
    }

    function testFuzz_spentNeverExceedsCap(uint96[5] memory amts) public {
        vm.prank(owner);
        acct.execute(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(router), type(uint256).max)));
        for (uint256 i; i < amts.length; ++i) {
            uint256 a = uint256(amts[i]) % 80e18 + 1;
            MockMAv2.Call[] memory cs = new MockMAv2.Call[](1);
            cs[0] = _buy(a, address(acct));
            vm.prank(key);
            try acct.executeBatch(cs) {} catch {}
            assertLe(policy.sessionOf(address(acct), E).spent0, CAP);
        }
    }

    /// @dev Audit #7: on-chain session lifetime ≤ 24h and slippage in [10, 5000] bps.
    function test_audit7_expiryAndSlippageBounds() public {
        P.SessionConfig memory c = _cfg(uint48(block.timestamp + 24 hours + 1));
        vm.prank(owner);
        vm.expectRevert(P.InvalidConfig.selector);
        acct.installSession(policy, E, key, c);
        c = _cfg(uint48(block.timestamp + 24 hours));
        c.maxSlippageBps = 9;
        vm.prank(owner);
        vm.expectRevert(P.InvalidConfig.selector);
        acct.installSession(policy, E, key, c);
        c.maxSlippageBps = 10;
        vm.prank(owner);
        acct.installSession(policy, E, key, c);
        // delayed start: 24h window counted from validAfter
        c.validAfter = uint48(block.timestamp + 1 hours);
        c.validUntil = uint48(block.timestamp + 25 hours);
        vm.prank(owner);
        acct.installSession(policy, E, key, c);
        assertEq(policy.MAX_SESSION_DURATION(), 24 hours);
    }

    // ───────── slippage (minOut vs on-chain quote) ─────────

    function test_defaultSlippageIs500() public view {
        assertEq(policy.sessionOf(address(acct), E).cfg.maxSlippageBps, 500);
    }

    function _routerBuy(uint256 a, uint256 minOut) internal view returns (MockMAv2.Call memory) {
        return MockMAv2.Call(
            address(router), 0, abi.encodeCall(MockRouter.buyExactIn, (address(rocket), a, minOut, address(acct), block.timestamp))
        );
    }

    function test_zeroMinOutRejected() public {
        _expectBatchRevert(
            abi.encodeWithSelector(P.ZeroMinOut.selector), _approve(address(usdg), address(router), 1e18), _routerBuy(1e18, 0)
        );
        vm.prank(key);
        vm.expectRevert(P.ZeroMinOut.selector);
        acct.execute(
            address(router), 0, abi.encodeCall(MockRouter.sellExactIn, (address(rocket), 1e18, 0, address(acct), 0))
        );
        vm.prank(key);
        vm.expectRevert(P.ZeroMinOut.selector);
        acct.execute(address(curve), 0, abi.encodeWithSignature("buy(uint256,uint256,uint256)", 1e18, 0, 0));
    }

    function test_minOutBelowQuoteMinusSlippageRejected() public {
        // quote 10e18, 5% → required 9.5e18
        _expectBatchRevert(
            abi.encodeWithSelector(P.MinOutTooLow.selector, 9.4e18, 9.5e18),
            _approve(address(usdg), address(router), 10e18),
            _routerBuy(10e18, 9.4e18)
        );
        _batch(_approve(address(usdg), address(router), 10e18), _routerBuy(10e18, 9.5e18)); // exactly at bound
    }

    function test_minOutUsesLiveQuote() public {
        router.setQuoteBps(5000); // pool now quotes half
        // minOut 4.75e18 = 0.95 * 5e18 passes the policy (router then enforces its own slippage on the real fill)
        _batch(_approve(address(usdg), address(router), 10e18), _routerBuy(10e18, 4.75e18));
        _expectBatchRevert(
            abi.encodeWithSelector(P.MinOutTooLow.selector, 4.7e18, 4.75e18),
            _approve(address(usdg), address(router), 10e18),
            _routerBuy(10e18, 4.7e18)
        );
    }

    function test_curveSlippageEnforced() public {
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(P.MinOutTooLow.selector, 1, 2.85e18));
        acct.execute(
            address(curve), 0, abi.encodeWithSignature("buy(uint256,uint256,uint256,address)", 3e18, 1, 0, address(acct))
        );
    }

    function test_perSessionSlippageAndBounds() public {
        P.SessionConfig memory c = _cfg(uint48(block.timestamp + 1 hours));
        c.maxSlippageBps = 100; // 1%
        vm.prank(owner);
        acct.installSession(policy, E, key, c);
        _expectBatchRevert(
            abi.encodeWithSelector(P.MinOutTooLow.selector, 9.8e18, 9.9e18),
            _approve(address(usdg), address(router), 10e18),
            _routerBuy(10e18, 9.8e18)
        );
        c.maxSlippageBps = 5001;
        vm.prank(owner);
        vm.expectRevert(P.InvalidConfig.selector);
        acct.installSession(policy, E, key, c);
    }

    function test_quoteFailureRejects() public {
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(P.QuoteFailed.selector, address(curve)));
        acct.execute(address(curve), 0, abi.encodeWithSignature("sell(uint256,uint256,uint256)", 0, 1, 0));
    }

    // ───────── expiry ─────────

    function test_expiryRuntime() public {
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(key);
        vm.expectRevert(P.SessionExpired.selector);
        acct.execute(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(router), 1)));
    }

    function test_userOpValidationDataCarriesExpiry() public {
        bytes memory cd = abi.encodeCall(MockMAv2.execute, (address(usdg), 0, abi.encodeCall(ERC20.approve, (address(router), 1))));
        uint256 vd = acct.userOpHook(cd);
        assertEq(uint48(vd >> 160), uint48(block.timestamp + 24 hours));
        assertEq(uint160(vd), 0); // no sig failure / aggregator
        // executeUserOp-prefixed callData is unwrapped
        assertEq(acct.userOpHook(abi.encodePacked(bytes4(0x8dd7712f), cd)), vd);
        // static checks run at validation time
        bytes memory bad = abi.encodeCall(MockMAv2.execute, (address(usdg), 0, abi.encodeCall(ERC20.transfer, (attacker, 1))));
        vm.expectRevert(abi.encodeWithSelector(P.NotAllowed.selector, address(usdg), ERC20.transfer.selector));
        acct.userOpHook(bad);
    }

    function test_rejectsBadInstallConfig() public {
        P.SessionConfig memory c = _cfg(uint48(block.timestamp));
        vm.prank(owner);
        vm.expectRevert(P.InvalidConfig.selector);
        acct.installSession(policy, 9, key, c);
    }

    // ───────── revocation ─────────

    function test_revokeByOwner() public {
        vm.prank(owner);
        acct.execute(address(policy), 0, abi.encodeCall(P.revoke, (E)));
        vm.prank(key);
        vm.expectRevert(P.SessionInactive.selector);
        acct.execute(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(router), 1)));
    }

    function test_uninstallClearsSession() public {
        vm.prank(owner);
        acct.uninstallSession();
        assertFalse(policy.sessionOf(address(acct), E).active);
        // a direct hook call for a stale entity also fails
        vm.prank(address(acct));
        vm.expectRevert(P.SessionInactive.selector);
        policy.preExecutionHook(E | (uint32(1) << 31), key, 0, abi.encodeCall(MockMAv2.execute, (address(usdg), 0, "")));
    }

    function test_sessionsIsolatedPerAccount() public {
        MockMAv2 other = new MockMAv2(attacker);
        vm.prank(address(other));
        vm.expectRevert(P.SessionInactive.selector);
        policy.preExecutionHook(E, key, 0, abi.encodeCall(MockMAv2.execute, (address(usdg), 0, "")));
    }

    function test_signatureValidationDisabled() public {
        vm.expectRevert(P.SignatureValidationNotAllowed.selector);
        policy.preSignatureValidationHook(E, key, bytes32(0), "");
    }

    // ───────── executeUserOp path (real MAv2 exec-hook data shape) ─────────

    function _uo(bytes memory inner) internal view returns (PackedUserOperation memory op) {
        op.sender = address(acct);
        op.callData = abi.encodePacked(bytes4(0x8dd7712f), inner);
    }

    function test_regression_executeUserOpPrefixedSessionOp() public {
        bytes memory inner = abi.encodeCall(MockMAv2.execute, (address(usdg), 0, abi.encodeCall(ERC20.approve, (address(router), 1))));
        vm.prank(acct.ENTRY_POINT());
        acct.executeUserOp(_uo(inner), keccak256("uo"));
        assertEq(usdg.allowance(address(acct), address(router)), 1);
    }

    function test_executeUserOpBatchAndRulesStillEnforced() public {
        MockMAv2.Call[] memory cs = new MockMAv2.Call[](1);
        cs[0] = MockMAv2.Call(address(usdg), 0, abi.encodeCall(ERC20.approve, (address(router), 2)));
        vm.prank(acct.ENTRY_POINT());
        acct.executeUserOp(_uo(abi.encodeCall(MockMAv2.executeBatch, (cs))), bytes32(0));
        assertEq(usdg.allowance(address(acct), address(router)), 2);
        // disallowed inner call still rejected by the exec hook (bypass validation hook to isolate it)
        PackedUserOperation memory op = _uo(abi.encodeCall(MockMAv2.execute, (address(usdg), 0, abi.encodeCall(ERC20.transfer, (attacker, 1)))));
        uint32 hE = E | policy.EXEC_HOOK_FLAG();
        address ep = acct.ENTRY_POINT();
        vm.prank(address(acct));
        vm.expectRevert(abi.encodeWithSelector(P.NotAllowed.selector, address(usdg), ERC20.transfer.selector));
        policy.preExecutionHook(hE, ep, 0, abi.encodeCall(MockMAv2.executeUserOp, (op, bytes32(0))));
    }

    function test_executeUserOpNonExecuteInnerRejected() public {
        PackedUserOperation memory op = _uo(abi.encodeCall(ERC20.approve, (address(router), 1)));
        bytes memory hookData = abi.encodeCall(MockMAv2.executeUserOp, (op, bytes32(0)));
        uint32 hE = E | policy.EXEC_HOOK_FLAG();
        address ep = acct.ENTRY_POINT();
        vm.startPrank(address(acct));
        vm.expectRevert(P.OnlyExecuteCalls.selector);
        policy.preExecutionHook(hE, ep, 0, hookData);
        // inner callData lacking the executeUserOp prefix is rejected too
        op.callData = abi.encodeCall(MockMAv2.execute, (address(usdg), 0, ""));
        hookData = abi.encodeCall(MockMAv2.executeUserOp, (op, bytes32(0)));
        vm.expectRevert(P.OnlyExecuteCalls.selector);
        policy.preExecutionHook(hE, ep, 0, hookData);
        // truncated / malformed
        vm.expectRevert(P.OnlyExecuteCalls.selector);
        policy.preExecutionHook(hE, ep, 0, abi.encodePacked(bytes4(0x8dd7712f), uint256(0x40)));
        vm.stopPrank();
    }

    // ── audit R-2: launchAnon stealthOwner pinned to the account (or the install-time stealth address) ──
    function _anonCall(address anon, address stealthOwner, address buyRecipient)
        internal
        view
        returns (bytes memory)
    {
        ILaunchpad.LaunchParams memory lpp;
        lpp.name = "A";
        lpp.ticker = "A";
        lpp.quote = address(usdg);
        lpp.deadline = block.timestamp + 1 hours;
        return abi.encodeWithSelector(
            ANON_LAUNCH_V2, lpp, stealthOwner, buyRecipient, bytes(""), bytes1(0), uint256(5e6)
        );
    }

    function test_anonLaunch_stealthOwnerPinned() public {
        MockAnon anon = new MockAnon(address(usdg));
        address stealth = makeAddr("myStealth");
        P.SessionConfig memory c = _cfg(uint48(block.timestamp + 24 hours));
        c.anonLauncher = address(anon);
        vm.prank(owner);
        acct.installSession(policy, E, key, c);
        // leaked key → attacker as stealth owner: rejected
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(P.StealthOwnerNotAllowed.selector, attacker));
        acct.execute(address(anon), 0, _anonCall(address(anon), attacker, address(acct)));
        // an unregistered stealth address: rejected too
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(P.StealthOwnerNotAllowed.selector, stealth));
        acct.execute(address(anon), 0, _anonCall(address(anon), stealth, address(acct)));
        // the account itself: ok
        vm.prank(key);
        acct.execute(address(anon), 0, _anonCall(address(anon), address(acct), address(acct)));
        // stealth address registered at install: ok
        c.stealthOwner = stealth;
        vm.prank(owner);
        acct.installSession(policy, E, key, c);
        vm.prank(key);
        acct.execute(address(anon), 0, _anonCall(address(anon), stealth, address(acct)));
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(P.StealthOwnerNotAllowed.selector, attacker));
        acct.execute(address(anon), 0, _anonCall(address(anon), attacker, address(acct)));
    }
}
