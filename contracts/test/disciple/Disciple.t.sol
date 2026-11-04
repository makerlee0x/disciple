// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {_noKey} from "./NoKey.sol";
import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {Disciple} from "../../src/disciple/Disciple.sol";
import {ILzRead} from "../../src/bridge/interfaces/ILzRead.sol";
import {MockERC20, MockLzRead} from "../bridge/mocks/BridgeMocks.sol";
import {DiscipleBridgeSender, IInbox} from "../../src/disciple/routes/DiscipleBridgeSender.sol";
import {DiscipleOpSender, IOptimismPortal} from "../../src/disciple/routes/DiscipleOpSender.sol";
import {DisciplePushSender} from "../../src/disciple/routes/DisciplePushSender.sol";
import {DisciplePushReceiver} from "../../src/disciple/routes/DisciplePushReceiver.sol";
import {IDisciplePriceTarget} from "../../src/disciple/routes/DiscipleSourceReader.sol";
import {
    ILayerZeroEndpointV2Lite,
    MessagingParams,
    MessagingFee,
    MessagingReceipt,
    Origin,
    LibConfig,
    SetConfigParam
} from "../../src/disciple/routes/ILayerZeroEndpointV2Lite.sol";
import {DisciplePoolTank, IWETH9, IDiscipleTank} from "../../src/disciple/DisciplePoolTank.sol";

/// @notice A v2 pair whose reserves the test sets.
contract MockPair {
    uint112 public r0;
    uint112 public r1;

    function set(uint112 a, uint112 b) external {
        r0 = a;
        r1 = b;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (r0, r1, 0);
    }

    address public token0;
    address public token1;

    function setTokens(address t0, address t1) external {
        (token0, token1) = (t0, t1);
    }
}

/// @notice A v2 factory that knows the pairs the test adds.
contract MockV2Factory {
    mapping(address => mapping(address => address)) public getPair;

    function add(address pair) external {
        address t0 = MockPair(pair).token0();
        address t1 = MockPair(pair).token1();
        (getPair[t0][t1], getPair[t1][t0]) = (pair, pair);
    }
}

/// @notice Records the retryable ticket instead of bridging it; the test delivers it as the aliased sender.
contract MockInbox is IInbox {
    address public lastTo;
    bytes public lastData;
    uint256 public lastValue;
    uint256 public n;

    function createRetryableTicket(address to, uint256, uint256, address, address, uint256, uint256, bytes calldata data)
        external
        payable
        returns (uint256)
    {
        (lastTo, lastData, lastValue) = (to, data, msg.value);
        return ++n;
    }

    function calculateRetryableSubmissionFee(uint256 len, uint256 baseFee) external view returns (uint256) {
        return (1400 + 6 * len) * (baseFee == 0 ? block.basefee : baseFee);
    }
}

contract MockWETH is MockERC20 {
    constructor() MockERC20("WETH", "WETH", 18) {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 a) external {
        _burn(msg.sender, a);
        payable(msg.sender).transfer(a);
    }
}

/// @notice Records an OP Stack deposit; the test delivers it as the aliased sender.
contract MockPortal is IOptimismPortal {
    address public lastTo;
    bytes public lastData;
    uint64 public lastGas;

    function depositTransaction(address to, uint256, uint64 gasLimit, bool, bytes calldata data) external payable {
        (lastTo, lastGas, lastData) = (to, gasLimit, data);
    }
}

/// @notice A LayerZero endpoint that charges a fixed fee, records the message, and lets the test deliver it.
contract MockEndpoint is ILayerZeroEndpointV2Lite {
    uint256 public constant FEE = 0.0003 ether;
    uint32 public immutable eid;
    bytes public lastMessage;
    uint32 public lastDst;
    bytes32 public lastReceiver;
    address public lastSender;
    uint256 public nonce;
    uint256 public configs;

    constructor(uint32 eid_) {
        eid = eid_;
    }

    function quote(MessagingParams calldata, address) external pure returns (MessagingFee memory) {
        return MessagingFee(FEE, 0);
    }

    function send(MessagingParams calldata p, address refundTo) external payable returns (MessagingReceipt memory r) {
        require(msg.value >= FEE, "fee");
        (lastDst, lastReceiver, lastMessage, lastSender) = (p.dstEid, p.receiver, p.message, msg.sender);
        nonce++;
        if (msg.value > FEE) payable(refundTo).transfer(msg.value - FEE);
        r = MessagingReceipt(keccak256(abi.encode(nonce)), uint64(nonce), MessagingFee(FEE, 0));
    }

    function setConfig(address, address, SetConfigParam[] calldata) external {
        configs++;
    }

    /// @dev What the executor does on the destination chain: endpoint.lzReceive -> receiver.lzReceive.
    function deliver(address receiver, uint32 srcEid, address from, bytes calldata message) external {
        DisciplePushReceiver(receiver).lzReceive(
            Origin(srcEid, bytes32(uint256(uint160(from))), uint64(nonce)), bytes32(nonce), message, address(this), ""
        );
    }
}

contract Keeper {
    receive() external payable {}
}

contract DiscipleTest is Test {
    using PoolIdLibrary for PoolKey;

    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );
    uint256 internal constant Q128 = 1 << 128;
    uint24 internal constant FEE = 3000; // 0.3%

    IPoolManager manager;
    Disciple hook;
    PoolSwapTest swapper;
    MockERC20 usd;
    MockERC20 coin;
    MockPair pair;
    MockV2Factory v2f;
    MockLzRead lz;
    MockInbox inbox;
    DiscipleBridgeSender sender;
    MockEndpoint home; // LayerZero endpoint on the home chain (Robinhood here)
    MockEndpoint local; // LayerZero endpoint on the pool's chain (Ethereum here)
    DisciplePushSender pushSender;
    DisciplePushReceiver receiver;
    uint32 internal constant HOME_EID = 30416; // Robinhood
    uint32 internal constant HYPE_EID = 30367; // HyperEVM: gas is HYPE, so no refund
    address lp = address(0xA11CE);

    receive() external payable {}

    function setUp() public {
        vm.roll(100);
        vm.warp(1_000_000);
        manager = IPoolManager(address(new PoolManager(address(this))));
        usd = new MockERC20("USD", "USD", 18);
        coin = new MockERC20("COIN", "COIN", 18);
        lz = new MockLzRead();
        pair = new MockPair();
        inbox = new MockInbox();
        sender = new DiscipleBridgeSender(inbox);
        home = new MockEndpoint(HOME_EID);
        local = new MockEndpoint(30101);
        pushSender = new DisciplePushSender(home, new LibConfig[](0));
        receiver = _receiver(address(pushSender));
        // source: coin is token0 of the pair; price 2 quote per coin
        pair.set(1_000_000e18, 2_000_000e18);
        pair.setTokens(address(coin), address(usd));
        v2f = new MockV2Factory();
        v2f.add(address(pair));
        bytes memory args =
            abi.encode(manager, address(usd), ILzRead(address(lz)), address(sender), address(receiver), address(v2f), address(0));
        bytes32 salt = _mine(args);
        hook = new Disciple{salt: salt}(
            manager, address(usd), ILzRead(address(lz)), address(sender), address(receiver), address(v2f), address(0)
        );
        receiver.bind(IDisciplePriceTarget(address(hook)));
        swapper = new PoolSwapTest(manager);
        _fund(address(this), 1e30);
        _fund(lp, 1e30);
        vm.deal(address(this), 100 ether);
    }

    // -----------------------------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------------------------

    function _mine(bytes memory args) internal view returns (bytes32) {
        bytes32 initHash = keccak256(abi.encodePacked(type(Disciple).creationCode, args));
        for (uint256 i = 0; i < 3_000_000; i++) {
            address a = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(i), initHash))))
            );
            if (uint160(a) & Hooks.ALL_HOOK_MASK == FLAGS) return bytes32(i);
        }
        revert("no salt");
    }

    function _receiver(address from) internal returns (DisciplePushReceiver r) {
        uint32[] memory eids = new uint32[](2);
        address[] memory senders = new address[](2);
        bool[] memory eth = new bool[](2);
        (eids[0], senders[0], eth[0]) = (HOME_EID, from, true);
        (eids[1], senders[1], eth[1]) = (HYPE_EID, from, false);
        r = new DisciplePushReceiver(local, eids, senders, eth, new LibConfig[](0));
    }

    function _fund(address who, uint256 amt) internal {
        usd.mint(who, amt);
        coin.mint(who, amt);
        vm.startPrank(who);
        usd.approve(address(hook), type(uint256).max);
        coin.approve(address(hook), type(uint256).max);
        usd.approve(address(swapper), type(uint256).max);
        coin.approve(address(swapper), type(uint256).max);
        vm.stopPrank();
    }

    function _src(uint32 eid) internal view returns (Disciple.Source memory s) {
        s.kind = 1; // v2
        s.coinIs0 = true;
        s.v2Fee = 3000;
        s.remoteEid = eid;
        s.target = address(pair);
        s.lens = eid == 0 ? address(0) : address(0x1E45);
    }

    function _createSame(uint256 coinIn, uint256 quoteIn) internal returns (PoolKey memory key, PoolId id) {
        (key, id) = hook.createPool(
            Disciple.CreateParams({coin: address(coin), fee: FEE, src: _src(0), coinIn: coinIn, quoteIn: quoteIn, srcKey: _noKey()})
        );
    }

    function _createCross(uint256 coinIn, uint256 quoteIn, uint256 eth)
        internal
        returns (PoolKey memory key, PoolId id)
    {
        (key, id) = hook.createPool{value: eth}(
            Disciple.CreateParams({coin: address(coin), fee: FEE, src: _src(30101), coinIn: coinIn, quoteIn: quoteIn, srcKey: _noKey()})
        );
    }

    /// @dev Deliver the pending read with the pair's reserves as the home chain would return them.
    function _deliver(uint112 r0, uint112 r1) internal {
        lz.fulfillBytes(lz.lastGuid(), abi.encode(uint256(r0), uint256(r1)));
    }

    function _swap(PoolKey memory key, bool buy, int256 amountSpecified) internal returns (BalanceDelta d) {
        bool coinIs0 = Currency.unwrap(key.currency0) == address(coin);
        bool zeroForOne = buy ? !coinIs0 : coinIs0;
        d = swapper.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _claims(address token) internal view returns (uint256) {
        return manager.balanceOf(address(hook), uint256(uint160(token)));
    }

    function _nextBlock() internal {
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 1);
    }

    // -----------------------------------------------------------------------------------------
    // same chain
    // -----------------------------------------------------------------------------------------

    function test_sameChainCreateTrimsSeedTo5050() public {
        uint256 c0 = coin.balanceOf(address(this));
        uint256 u0 = usd.balanceOf(address(this));
        (, PoolId id) = _createSame(1000e18, 5000e18); // too much quote: only 2000 is used
        assertEq(c0 - coin.balanceOf(address(this)), 1000e18, "coin taken");
        assertEq(u0 - usd.balanceOf(address(this)), 2000e18, "quote taken");
        Disciple.PoolView memory v = hook.poolState(id);
        assertTrue(v.live);
        assertEq(v.coinReserve, 1000e18);
        assertEq(v.quoteReserve, 2000e18);
        assertEq(_claims(address(coin)), 1000e18, "coin held as claims");
        assertEq(_claims(address(usd)), 2000e18, "quote held as claims");
    }

    function test_sameChainBuyAndSellExactIn() public {
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        _nextBlock();
        uint256 c0 = coin.balanceOf(address(this));
        _swap(key, true, -int256(20e18)); // spend 20 quote
        uint256 got = coin.balanceOf(address(this)) - c0;
        // price 2 plus fee and the opening 4% premium: fewer than 10 coins, but not absurdly few
        assertLt(got, 10e18, "buy pays at least the anchor");
        assertGt(got, 9e18, "buy within ~10% of the anchor");
        Disciple.PoolView memory v = hook.poolState(id);
        assertEq(v.quoteReserve, 2020e18);
        assertEq(v.coinReserve, 1000e18 - got);
        assertEq(_claims(address(coin)), v.coinReserve, "claims track the coin reserve");
        assertEq(_claims(address(usd)), v.quoteReserve, "claims track the quote reserve");

        _nextBlock();
        uint256 q0 = usd.balanceOf(address(this));
        _swap(key, false, -int256(5e18)); // sell 5 coins
        uint256 qGot = usd.balanceOf(address(this)) - q0;
        assertLt(qGot, 10e18, "sell receives at most the anchor");
        assertGt(qGot, 9e18, "sell within ~10% of the anchor");
    }

    function test_sameChainExactOut() public {
        (PoolKey memory key,) = _createSame(1000e18, 2000e18);
        _nextBlock();
        uint256 c0 = coin.balanceOf(address(this));
        uint256 u0 = usd.balanceOf(address(this));
        _swap(key, true, int256(3e18)); // receive exactly 3 coins
        assertEq(coin.balanceOf(address(this)) - c0, 3e18, "exact coin out");
        uint256 paid = u0 - usd.balanceOf(address(this));
        assertGt(paid, 6e18, "paid more than the anchor");
        assertLt(paid, 6.6e18, "paid under 10% over the anchor");

        uint256 q1 = usd.balanceOf(address(this));
        _swap(key, false, int256(4e18)); // receive exactly 4 quote
        assertEq(usd.balanceOf(address(this)) - q1, 4e18, "exact quote out");
    }

    function test_premiumFades() public {
        (PoolKey memory key,) = _createSame(1000e18, 2000e18);
        _nextBlock();
        uint256 c0 = coin.balanceOf(address(this));
        _swap(key, true, -int256(2e18));
        uint256 early = coin.balanceOf(address(this)) - c0;
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 60); // premium gone
        c0 = coin.balanceOf(address(this));
        _swap(key, true, -int256(2e18));
        uint256 late = coin.balanceOf(address(this)) - c0;
        assertGt(late, early, "same spend buys more after the premium fades");
    }

    function _cp(Disciple.Source memory s, PoolKey memory k) internal view returns (Disciple.CreateParams memory) {
        return Disciple.CreateParams({coin: address(coin), fee: FEE, src: s, coinIn: 1000e18, quoteIn: 3000e18, srcKey: k});
    }

    function test_sameChainSourceMustBeTheRealPairPool() public {
        Disciple.Source memory s = _src(0);
        // a look-alike pair the factory does not know: refused
        MockPair fake = new MockPair();
        fake.set(1e18, 1e18);
        fake.setTokens(address(coin), address(usd));
        s.target = address(fake);
        vm.expectRevert(Disciple.BadParams.selector);
        hook.createPool(_cp(s, _noKey()));
        // a real pair of other tokens: refused
        MockERC20 other = new MockERC20("O", "O", 18);
        MockPair op = new MockPair();
        op.set(1e18, 1e18);
        op.setTokens(address(other), address(usd));
        v2f.add(address(op));
        s.target = address(op);
        vm.expectRevert(Disciple.BadParams.selector);
        hook.createPool(_cp(s, _noKey()));
        // the right pair, wrong orientation: refused
        s.target = address(pair);
        s.coinIs0 = false;
        vm.expectRevert(Disciple.BadParams.selector);
        hook.createPool(_cp(s, _noKey()));
        // v3 is off on this deployment (no factory)
        s = _src(0);
        s.kind = 2;
        vm.expectRevert();
        hook.createPool(_cp(s, _noKey()));
    }

    function test_sameChainV4SourceKeyChecked() public {
        bool coinIs0 = address(coin) < address(usd);
        PoolKey memory src = PoolKey({
            currency0: Currency.wrap(coinIs0 ? address(coin) : address(usd)),
            currency1: Currency.wrap(coinIs0 ? address(usd) : address(coin)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        manager.initialize(src, TickMath.getSqrtPriceAtTick(coinIs0 ? int24(6900) : int24(-6900)));
        Disciple.Source memory s;
        s.kind = 3;
        s.coinIs0 = coinIs0;
        s.target = address(manager);
        s.v4Id = PoolId.unwrap(src.toId());
        // a key that does not hash to the id: refused
        PoolKey memory wrong = PoolKey(src.currency0, src.currency1, 500, 60, IHooks(address(0)));
        vm.expectRevert(Disciple.BadParams.selector);
        hook.createPool(_cp(s, wrong));
        // the real key works
        (PoolKey memory key, PoolId id) = hook.createPool(_cp(s, src));
        assertTrue(hook.poolState(id).live);
        // one of this hook's own pools as a source: refused
        s.v4Id = PoolId.unwrap(id);
        vm.expectRevert(Disciple.BadParams.selector);
        hook.createPool(_cp(s, key));
    }

    function test_severalPoolsPerCoin() public {
        (PoolKey memory k1, PoolId id1) = _createSame(1000e18, 2000e18);
        vm.prank(lp);
        (PoolKey memory k2, PoolId id2) = hook.createPool(_cp(_src(0), _noKey()));
        assertEq(k1.tickSpacing, 1);
        assertEq(k2.tickSpacing, 2);
        assertTrue(PoolId.unwrap(id1) != PoolId.unwrap(id2));
        assertEq(hook.poolsOf(address(coin)), 2);
        assertTrue(hook.poolState(id2).live);
        _nextBlock();
        _swap(k2, true, -1e18);
    }

    function test_sameChainBuyNeverBelowLiveSourceAsk() public {
        (PoolKey memory key,) = _createSame(1000e18, 2000e18);
        _nextBlock();
        vm.warp(block.timestamp + 60); // no premium
        // the source jumps 10% inside the block: our ask must follow the live source, not the latched anchor
        pair.set(1_000_000e18, 2_200_000e18);
        uint256 c0 = coin.balanceOf(address(this));
        _swap(key, true, -int256(22e18));
        uint256 got = coin.balanceOf(address(this)) - c0;
        assertLe(got, 10e18, "never cheaper than the live source");
    }

    function test_liquidityDisabledAndNoForeignInit() public {
        (PoolKey memory key,) = _createSame(1000e18, 2000e18);
        key.tickSpacing = 10; // a different pool on the same hook
        vm.expectRevert();
        manager.initialize(key, uint160(1 << 96));
    }

    function test_depositWithdrawRoundTrip() public {
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        _nextBlock();
        vm.prank(lp);
        (uint256 lot, uint256 shares) = hook.deposit(id, 100e18, 1000e18);
        assertEq(lot, 2);
        assertGt(shares, 0);
        Disciple.PoolView memory v = hook.poolState(id);
        assertEq(v.coinReserve, 1100e18);
        assertApproxEqAbs(v.quoteReserve, 2200e18, 1);
        assertEq(_claims(address(usd)), v.quoteReserve);

        _swap(key, true, -int256(50e18));
        _nextBlock();
        _swap(key, false, -int256(10e18));
        _nextBlock();

        uint256 c0 = coin.balanceOf(lp);
        uint256 u0 = usd.balanceOf(lp);
        vm.prank(lp);
        hook.withdraw(id, lot, shares, 0);
        uint256 cOut = coin.balanceOf(lp) - c0;
        uint256 uOut = usd.balanceOf(lp) - u0;
        // value back at price 2 is within 1% of the 400 put in (100 coin + 200 quote)
        uint256 valueBack = cOut * 2 + uOut;
        assertApproxEqRel(valueBack, 400e18, 0.01e18);

        vm.prank(address(0xBAD));
        vm.expectRevert();
        hook.withdraw(id, 1, 1e18, 0);
    }

    // -----------------------------------------------------------------------------------------
    // cross chain
    // -----------------------------------------------------------------------------------------

    function test_crossChainGoesLiveOnFirstPrice() public {
        (, PoolId id) = _createCross(1000e18, 3000e18, 0.011 ether);
        Disciple.PoolView memory v = hook.poolState(id);
        assertFalse(v.live);
        assertEq(v.tank, 0.01 ether);
        uint256 u0 = usd.balanceOf(address(this));
        _deliver(1_000_000e18, 2_000_000e18);
        v = hook.poolState(id);
        assertTrue(v.live);
        assertEq(v.coinReserve, 1000e18);
        assertEq(v.quoteReserve, 2000e18);
        assertEq(usd.balanceOf(address(this)) - u0, 1000e18, "excess quote refunded");
        assertEq(_claims(address(usd)), 2000e18);
    }

    function test_crossChainSwapAndKeeperRefund() public {
        (PoolKey memory key, PoolId id) = _createCross(1000e18, 2000e18, 0.051 ether);
        _deliver(1_000_000e18, 2_000_000e18);
        _swap(key, true, -int256(20e18));

        // a keeper sees the home price move 2% and refreshes: refunded the fee plus 20%
        Keeper k = new Keeper();
        vm.deal(address(k), 1 ether);
        vm.warp(block.timestamp + 300);
        assertTrue(hook.refreshDue(id, Q128 * 204 / 100));
        vm.prank(address(k));
        hook.updatePrice{value: 0.001 ether}(id);
        vm.warp(block.timestamp + 20);
        _deliver(1_000_000e18, 2_040_000e18);
        assertEq(address(k).balance, 1 ether - 0.001 ether + 0.0012 ether, "refund = fee * 1.2");
        assertEq(hook.poolState(id).anchorX128, Q128 * 204 / 100);

        // a pointless request (no move, not a heartbeat) is not refunded
        vm.warp(block.timestamp + 300);
        vm.prank(address(k));
        hook.updatePrice{value: 0.001 ether}(id);
        _deliver(1_000_000e18, 2_040_000e18);
        assertEq(address(k).balance, 1 ether - 0.002 ether + 0.0012 ether, "no refund without a move");
    }

    function test_crossChainHeartbeatSwapFiresRefreshFromTank() public {
        (PoolKey memory key, PoolId id) = _createCross(1000e18, 2000e18, 0.051 ether);
        _deliver(1_000_000e18, 2_000_000e18);
        uint256 n0 = lz.n();
        vm.warp(block.timestamp + 3600);
        _swap(key, true, -int256(2e18));
        assertEq(lz.n(), n0 + 1, "swap fired a refresh");
        assertEq(hook.poolState(id).tank, 0.049 ether, "paid from the tank");
        // a second swap does not fire again while the request is pending
        _swap(key, true, -int256(2e18));
        assertEq(lz.n(), n0 + 1);
    }

    function test_crossChainLocalModeAndRecovery() public {
        (PoolKey memory key, PoolId id) = _createCross(1000e18, 2000e18, 0.001 ether); // empty tank
        _deliver(1_000_000e18, 2_000_000e18);
        vm.warp(block.timestamp + 2 hours + 1);
        // pool keeps trading with no price: enters local mode
        _swap(key, true, -int256(10e18));
        Disciple.PoolView memory v = hook.poolState(id);
        assertTrue(v.local, "local mode");
        // deposits wait for the next fresh price
        vm.prank(lp);
        vm.expectRevert(Disciple.PendingTrades.selector);
        hook.deposit(id, 10e18, 10e18);
        // withdrawals still work mid-interval
        vm.prank(address(this));
        hook.withdraw(id, 1, 1e18, 0);

        // a stale delivery (observed long ago) cannot end local mode
        hook.updatePrice{value: 0.001 ether}(id);
        vm.warp(block.timestamp + 200);
        _deliver(1_000_000e18, 2_100_000e18);
        assertTrue(hook.poolState(id).local, "stale read rejected");

        // a fresh one does, and re-centres
        hook.updatePrice{value: 0.001 ether}(id);
        vm.warp(block.timestamp + 30);
        _deliver(1_000_000e18, 2_100_000e18);
        v = hook.poolState(id);
        assertFalse(v.local, "recovered");
        assertEq(v.anchorX128, Q128 * 21 / 10);
        vm.prank(lp);
        hook.deposit(id, 10e18, 30e18);
    }

    // -----------------------------------------------------------------------------------------
    // parent-chain push through the rollup bridge
    // -----------------------------------------------------------------------------------------

    function _bridgeSrc() internal view returns (Disciple.Source memory s) {
        s = _src(0);
        s.remoteEid = hook.BRIDGE_EID();
    }

    function _createBridge(uint256 eth) internal returns (PoolKey memory key, PoolId id) {
        (key, id) = hook.createPool{value: eth}(
            Disciple.CreateParams({coin: address(coin), fee: FEE, src: _bridgeSrc(), coinIn: 1000e18, quoteIn: 3000e18, srcKey: _noKey()})
        );
    }

    /// @dev A keeper pushes on the parent chain; the rollup delivers the ticket after `delay` seconds.
    function _push(PoolId id, address keeper, uint256 delay) internal returns (bool ok) {
        vm.deal(keeper, 1 ether);
        vm.prank(keeper);
        sender.push{value: 0.0005 ether}(address(hook), id, 1, address(pair), bytes32(0), 1, 1, 1);
        vm.warp(block.timestamp + delay);
        address to = inbox.lastTo();
        bytes memory data = inbox.lastData();
        vm.prank(address(uint160(address(sender)) + uint160(0x1111000000000000000000000000000000001111)));
        uint256 g = gasleft();
        (ok,) = to.call(data);
        emit log_named_uint("bridge delivery gas (onBridgePrice)", g - gasleft());
    }

    function test_bridgePushOpensPoolAndUpdates() public {
        (PoolKey memory key, PoolId id) = _createBridge(0.05 ether);
        assertFalse(hook.poolState(id).live);
        assertEq(hook.poolState(id).tank, 0.05 ether, "all ETH to the tank");
        assertTrue(_push(id, address(0xC0FFEE), 300));
        Disciple.PoolView memory v = hook.poolState(id);
        assertTrue(v.live, "first push opens the pool");
        assertEq(v.anchorX128, Q128 * 2);
        assertEq(v.ageOrBlock, 300, "age counts from the parent-chain observation");
        _swap(key, true, -int256(10e18));

        // price moves 3% on the parent chain: accepted, keeper refunded (cost * 1.2) on the rollup
        pair.set(1_000_000e18, 2_060_000e18);
        Keeper k = new Keeper();
        uint256 b0 = address(k).balance;
        vm.fee(1 gwei);
        assertTrue(_push(id, address(k), 120));
        assertEq(hook.poolState(id).anchorX128, Q128 * 206 / 100);
        // net cost only: the ticket prepayment's unused part is the rollup's refund, not the pool's
        uint256 cost = (1400 + 6 * 324) * 1 gwei + 130_000 * 1 gwei + 150_000 * 1 gwei;
        assertEq(address(k).balance, b0 + 1 ether - 0.0005 ether + cost * 12 / 10, "refund = net cost * 1.2");
    }

    function test_bridgeRejectsForgedOldAndMismatched() public {
        (, PoolId id) = _createBridge(0.05 ether);
        assertTrue(_push(id, address(0xC0FFEE), 60));

        // only the sender's alias may deliver
        vm.expectRevert(Disciple.OnlyBridge.selector);
        hook.onBridgePrice(id, 0, 1, address(pair), bytes32(0), 1e18, 9e18, uint64(block.timestamp), address(this), 0);
        vm.prank(address(sender)); // un-aliased is not the rollup's sender either
        vm.expectRevert(Disciple.OnlyBridge.selector);
        hook.onBridgePrice(id, 0, 1, address(pair), bytes32(0), 1e18, 9e18, uint64(block.timestamp), address(this), 0);

        // a re-redeemed (replayed) ticket carries an old observation: ignored
        address aliased = address(uint160(address(sender)) + uint160(0x1111000000000000000000000000000000001111));
        bytes memory oldTicket = inbox.lastData();
        pair.set(1_000_000e18, 2_500_000e18);
        assertTrue(_push(id, address(0xC0FFEE), 60));
        uint256 a = hook.poolState(id).anchorX128;
        vm.prank(aliased);
        (bool ok,) = address(hook).call(oldTicket);
        assertTrue(ok);
        assertEq(hook.poolState(id).anchorX128, a, "replay ignored");

        // a push that read a different source than the pool's is ignored
        MockPair other = new MockPair();
        other.set(1e18, 100e18);
        vm.prank(address(0xC0FFEE));
        sender.push{value: 0}(address(hook), id, 1, address(other), bytes32(0), 1, 1, 1);
        vm.warp(block.timestamp + 30);
        bytes memory wrong = inbox.lastData();
        vm.prank(aliased);
        (ok,) = address(hook).call(wrong);
        assertTrue(ok);
        assertEq(hook.poolState(id).anchorX128, a, "wrong source ignored");
    }

    function test_bridgeNoSwapTriggeredSendAndRecoveryWindow() public {
        (PoolKey memory key, PoolId id) = _createBridge(0.05 ether);
        assertTrue(_push(id, address(0xC0FFEE), 60));
        uint256 n0 = lz.n();
        vm.warp(block.timestamp + 2 hours + 1);
        _swap(key, true, -int256(5e18)); // stale: local mode, and no LayerZero send for a bridge pool
        assertEq(lz.n(), n0);
        assertTrue(hook.poolState(id).local);
        // a bridge delivery 15 minutes after observation still ends local mode (lzRead allows 2 minutes)
        assertTrue(_push(id, address(0xC0FFEE), 15 minutes));
        assertFalse(hook.poolState(id).local, "recovered over the bridge");
    }

    function test_poolTankFlushesWethIntoTank() public {
        (, PoolId id) = _createCross(1000e18, 2000e18, 0.001 ether);
        MockWETH weth = new MockWETH();
        DisciplePoolTank tank = new DisciplePoolTank(IWETH9(address(weth)), IDiscipleTank(address(hook)), id);
        weth.deposit{value: 0.3 ether}();
        weth.transfer(address(tank), 0.3 ether); // what a TJAR releaser does
        (bool ok,) = address(tank).call{value: 0.1 ether}("");
        assertTrue(ok);
        uint256 t0 = hook.poolState(id).tank;
        vm.prank(address(0xBEEF)); // anyone
        assertEq(tank.flush(), 0.4 ether);
        assertEq(hook.poolState(id).tank, t0 + 0.4 ether);
    }


    // -----------------------------------------------------------------------------------------
    // LayerZero push (Robinhood -> Ethereum, and any other LayerZero pair)
    // -----------------------------------------------------------------------------------------

    function _pushSrc(uint32 eid) internal view returns (Disciple.Source memory s) {
        s = _src(0);
        s.remoteEid = eid;
        s.push = true;
    }

    function _createPush(uint32 eid, uint256 eth) internal returns (PoolKey memory key, PoolId id) {
        (key, id) = hook.createPool{value: eth}(
            Disciple.CreateParams({coin: address(coin), fee: FEE, src: _pushSrc(eid), coinIn: 1000e18, quoteIn: 3000e18, srcKey: _noKey()})
        );
    }

    function _req(address target, PoolId id) internal pure returns (DisciplePushSender.Req[] memory r) {
        r = new DisciplePushSender.Req[](1);
        r[0].kind = 1;
        r[0].target = target;
        r[0].pools = new PoolId[](1);
        r[0].pools[0] = id;
    }

    function _msgCost(bytes memory m) internal pure returns (uint256 c) {
        (,, c) = abi.decode(m, (uint64, address, uint256));
    }

    /// @dev A keeper calls the sender on the home chain; LayerZero delivers it on the pool's chain after `delay`.
    function _lzPush(PoolId id, address keeper, uint256 delay, uint32 srcEid) internal {
        vm.deal(keeper, 1 ether);
        bytes32 to = bytes32(uint256(uint160(address(receiver))));
        uint256 fee = pushSender.quote(30101, to, _req(address(pair), id), 200_000);
        vm.prank(keeper);
        pushSender.push{value: fee}(30101, to, _req(address(pair), id), 200_000);
        vm.warp(block.timestamp + delay);
        local.deliver(address(receiver), srcEid, address(pushSender), home.lastMessage());
    }

    function test_lzPushOpensPoolUpdatesAndRefunds() public {
        (PoolKey memory key, PoolId id) = _createPush(HOME_EID, 0.05 ether);
        assertFalse(hook.poolState(id).live);
        assertEq(hook.poolState(id).tank, 0.05 ether, "all ETH to the tank, nothing sent");
        assertEq(lz.n(), 0);
        _lzPush(id, address(0xC0FFEE), 40, HOME_EID);
        Disciple.PoolView memory v = hook.poolState(id);
        assertTrue(v.live, "first pushed price opens the pool");
        assertEq(v.anchorX128, Q128 * 2);
        assertEq(v.ageOrBlock, 40);
        _swap(key, true, -int256(10e18));

        // 3% move at home: accepted, keeper paid (LayerZero fee + measured home gas + local delivery gas) * 1.2
        pair.set(1_000_000e18, 2_060_000e18);
        Keeper k = new Keeper();
        vm.fee(5 gwei);
        _lzPush(id, address(k), 60, HOME_EID);
        assertEq(hook.poolState(id).anchorX128, Q128 * 206 / 100);
        uint256 carried = _msgCost(home.lastMessage());
        assertGt(carried, home.FEE() + 50_000 * 5 gwei, "home gas is counted");
        assertLt(carried, home.FEE() + 250_000 * 5 gwei);
        uint256 cost = carried + 150_000 * 5 gwei;
        assertEq(address(k).balance, 1 ether - home.FEE() + cost * 12 / 10, "refund = cost * 1.2");
        // no lzRead path for a push pool
        vm.expectRevert(Disciple.SameChain.selector);
        hook.updatePrice{value: 0.01 ether}(id);
    }

    function test_lzPushRejectsForgedPeerAndWrongChain() public {
        (, PoolId id) = _createPush(HOME_EID, 0.05 ether);
        _lzPush(id, address(0xC0FFEE), 40, HOME_EID);
        uint256 a = hook.poolState(id).anchorX128;

        // only the receiver may call the hook on the push route; only the endpoint may call the receiver
        vm.expectRevert(Disciple.OnlyBridge.selector);
        hook.onBridgePrice(id, HOME_EID, 1, address(pair), bytes32(0), 1e18, 9e18, uint64(block.timestamp), address(this), 0);
        Origin memory o = Origin(HOME_EID, bytes32(uint256(uint160(address(pushSender)))), 1);
        bytes memory last = home.lastMessage();
        vm.expectRevert(DisciplePushReceiver.OnlyEndpoint.selector);
        receiver.lzReceive(o, bytes32(0), last, address(0), "");

        // a sender that is not the registered peer for that chain
        pair.set(1_000_000e18, 2_500_000e18);
        DisciplePushSender rogue = new DisciplePushSender(home, new LibConfig[](0));
        vm.deal(address(this), 1 ether);
        rogue.push{value: 1 ether}(30101, bytes32(0), _req(address(pair), id), 200_000);
        bytes memory m = home.lastMessage();
        vm.expectRevert(DisciplePushReceiver.UnknownPeer.selector);
        local.deliver(address(receiver), HOME_EID, address(rogue), m);
        // the right sender, but the chain is not the pool's home: ignored
        vm.warp(block.timestamp + 30);
        _lzPush(id, address(0xC0FFEE), 5, HYPE_EID);
        assertEq(hook.poolState(id).anchorX128, a, "wrong home chain ignored");
        bytes memory old = home.lastMessage(); // a valid observation, replayed later
        // a push of a different source is ignored
        MockPair other = new MockPair();
        other.set(1e18, 100e18);
        bytes32 to = bytes32(uint256(uint160(address(receiver))));
        pushSender.push{value: 0.01 ether}(30101, to, _req(address(other), id), 200_000);
        local.deliver(address(receiver), HOME_EID, address(pushSender), home.lastMessage());
        assertEq(hook.poolState(id).anchorX128, a, "wrong source ignored");
        // a replay of an older message is ignored
        vm.warp(block.timestamp + 5);
        _lzPush(id, address(0xC0FFEE), 5, HOME_EID);
        uint256 a2 = hook.poolState(id).anchorX128;
        assertGt(a2, a);
        pair.set(1_000_000e18, 2_000_000e18);
        local.deliver(address(receiver), HOME_EID, address(pushSender), old);
        assertEq(hook.poolState(id).anchorX128, a2, "replay ignored");
        // the hook is bound once
        vm.expectRevert(DisciplePushReceiver.AlreadyBound.selector);
        receiver.bind(IDisciplePriceTarget(address(this)));
    }

    function test_lzPushFromNonEthGasChainPaysNoRefund() public {
        (, PoolId id) = _createPush(HYPE_EID, 0.05 ether);
        _lzPush(id, address(0xC0FFEE), 40, HYPE_EID);
        assertTrue(hook.poolState(id).live);
        pair.set(1_000_000e18, 2_100_000e18);
        Keeper k = new Keeper();
        _lzPush(id, address(k), 40, HYPE_EID);
        assertEq(hook.poolState(id).anchorX128, Q128 * 21 / 10);
        assertEq(address(k).balance, 1 ether - home.FEE(), "HYPE cost is not refunded in ETH");
        assertEq(hook.poolState(id).tank, 0.05 ether);
    }

    function test_lzPushRecoveryWindowAndNoSwapSend() public {
        (PoolKey memory key, PoolId id) = _createPush(HOME_EID, 0.05 ether);
        _lzPush(id, address(0xC0FFEE), 40, HOME_EID);
        vm.warp(block.timestamp + 2 hours + 1);
        _swap(key, true, -int256(5e18));
        assertEq(lz.n(), 0, "a push pool never sends from the swap");
        assertTrue(hook.poolState(id).local);
        _lzPush(id, address(0xC0FFEE), 21 minutes, HOME_EID);
        assertTrue(hook.poolState(id).local, "too old to end local mode");
        _lzPush(id, address(0xC0FFEE), 3 minutes, HOME_EID);
        assertFalse(hook.poolState(id).local, "recovered over LayerZero push");
    }

    function test_createPushNeedsReceiverAndChain() public {
        Disciple.Source memory s = _pushSrc(0);
        vm.expectRevert(Disciple.BadParams.selector);
        hook.createPool(Disciple.CreateParams({coin: address(coin), fee: FEE, src: s, coinIn: 1e18, quoteIn: 3e18, srcKey: _noKey()}));
        s = _bridgeSrc();
        s.push = true;
        vm.expectRevert(Disciple.BadParams.selector);
        hook.createPool(Disciple.CreateParams({coin: address(coin), fee: FEE, src: s, coinIn: 1e18, quoteIn: 3e18, srcKey: _noKey()}));
    }



    function test_lzPushBatchesSourcesAndSplitsCost() public {
        // two sources, three pools: two pools on `pair`, one on `pair2`, all in one message
        MockPair pair2 = new MockPair();
        pair2.set(1_000_000e18, 5_000_000e18);
        (, PoolId p1) = _createPush(HOME_EID, 0.05 ether);
        MockERC20 c2 = usd2();
        Disciple.Source memory s = _pushSrc(HOME_EID);
        (, PoolId p2) = hook.createPool{value: 0.05 ether}(
            Disciple.CreateParams({coin: address(c2), fee: 10_000, src: s, coinIn: 1000e18, quoteIn: 3000e18, srcKey: _noKey()})
        );
        MockERC20 c3 = usd2();
        s.target = address(pair2);
        (, PoolId p3) = hook.createPool{value: 0.05 ether}(
            Disciple.CreateParams({coin: address(c3), fee: FEE, src: s, coinIn: 1000e18, quoteIn: 3000e18, srcKey: _noKey()})
        );
        DisciplePushSender.Req[] memory r = new DisciplePushSender.Req[](2);
        r[0].kind = 1;
        r[0].target = address(pair);
        r[0].pools = new PoolId[](2);
        (r[0].pools[0], r[0].pools[1]) = (p1, p2);
        r[1].kind = 1;
        r[1].target = address(pair2);
        r[1].pools = new PoolId[](2);
        (r[1].pools[0], r[1].pools[1]) = (p3, p1); // p1 listed under the wrong source: refused, others unaffected
        bytes32 to = bytes32(uint256(uint160(address(receiver))));
        vm.fee(1 gwei);
        Keeper k = new Keeper();
        vm.deal(address(k), 1 ether);
        uint256 lzFee = home.FEE();
        vm.prank(address(k));
        pushSender.push{value: lzFee}(30101, to, r, 300_000);
        vm.warp(vm.getBlockTimestamp() + 30);
        uint256 nMsgs = home.nonce();
        local.deliver(address(receiver), HOME_EID, address(pushSender), home.lastMessage());
        assertEq(home.nonce(), nMsgs);
        assertEq(hook.poolState(p1).anchorX128, Q128 * 2, "p1 priced from pair");
        assertEq(hook.poolState(p2).anchorX128, Q128 * 2, "p2 priced from pair, same message");
        assertEq(hook.poolState(p3).anchorX128, Q128 * 5, "p3 priced from pair2, same message");

        // a heartbeat for all three: each pool refunds only its quarter of the message cost (4 listings)
        vm.warp(vm.getBlockTimestamp() + 59 minutes + 30);
        uint256 b0 = address(k).balance;
        uint256 t1 = hook.poolState(p1).tank;
        vm.prank(address(k));
        pushSender.push{value: lzFee}(30101, to, r, 300_000);
        vm.warp(vm.getBlockTimestamp() + 30);
        uint256 carried = _msgCost(home.lastMessage());
        local.deliver(address(receiver), HOME_EID, address(pushSender), home.lastMessage());
        uint256 each = (carried / 4 + 150_000 * 1 gwei) * 12 / 10;
        assertEq(t1 - hook.poolState(p1).tank, each, "p1 pays one share (its wrong-source listing is ignored)");
        assertEq(address(k).balance, b0 - home.FEE() + 3 * each, "three accepted listings refunded");
        emit log_named_uint("home cost carried for 2 sources / 4 listings (wei at 1 gwei)", carried);
    }


    function test_lzPushDuplicatesTooManyAndTakeover() public {
        (, PoolId id) = _createPush(HOME_EID, 0.05 ether);
        _lzPush(id, address(0xC0FFEE), 40, HOME_EID);
        bytes32 to = bytes32(uint256(uint160(address(receiver))));

        // more than MAX_POOLS listings: refused at the sender, nothing sent
        DisciplePushSender.Req[] memory big = _req(address(pair), id);
        big[0].pools = new PoolId[](65);
        vm.expectRevert(DisciplePushSender.TooMany.selector);
        pushSender.push{value: 1 ether}(30101, to, big, 200_000);

        // a pool listed twice: the first listing is accepted and refunded, the duplicate is refused (not newer)
        // and refunds nothing, so the keeper recovers half the message cost
        DisciplePushSender.Req[] memory dup = _req(address(pair), id);
        dup[0].pools = new PoolId[](2);
        (dup[0].pools[0], dup[0].pools[1]) = (id, id);
        vm.warp(vm.getBlockTimestamp() + 59 minutes + 30);
        vm.fee(1 gwei);
        Keeper k = new Keeper();
        vm.deal(address(k), 1 ether);
        uint256 lzFee = home.FEE();
        vm.prank(address(k));
        pushSender.push{value: lzFee}(30101, to, dup, 200_000);
        uint256 carried = _msgCost(home.lastMessage());
        vm.warp(vm.getBlockTimestamp() + 30);
        uint256 t0 = hook.poolState(id).tank;
        bytes memory m = home.lastMessage();
        // takeover: someone other than the sending keeper delivers on the destination
        vm.prank(address(0xD311));
        local.deliver(address(receiver), HOME_EID, address(pushSender), m);
        uint256 each = (carried / 2 + 150_000 * 1 gwei) * 12 / 10;
        assertEq(t0 - hook.poolState(id).tank, each, "one listing refunded");
        assertEq(address(k).balance, 1 ether - lzFee + each, "the sending keeper is paid, not the deliverer");
        assertEq(address(0xD311).balance, 0);
    }

    function test_lzReceiverAddOnlyOwner() public {
        (, PoolId id) = _createPush(HOME_EID, 0.05 ether);
        _lzPush(id, address(0xC0FFEE), 40, HOME_EID);
        uint256 a = hook.poolState(id).anchorX128;
        DisciplePushSender other = new DisciplePushSender(home, new LibConfig[](0));

        // an existing peer can never be replaced
        vm.expectRevert(DisciplePushReceiver.PeerSet.selector);
        receiver.addPeer(HOME_EID, address(other), true, new LibConfig[](0));
        // only the owner adds
        vm.prank(address(0xBAD));
        vm.expectRevert(DisciplePushReceiver.OnlyOwner.selector);
        receiver.addPeer(30184, address(other), true, new LibConfig[](0));
        // config for a new chain may not touch another chain's pathway
        LibConfig[] memory cfg = new LibConfig[](1);
        cfg[0].lib = address(0x11B);
        cfg[0].params = new SetConfigParam[](1);
        cfg[0].params[0] = SetConfigParam(HOME_EID, 2, "");
        vm.expectRevert(DisciplePushReceiver.ForeignConfig.selector);
        receiver.addPeer(30184, address(other), true, cfg);

        // a new source chain (Base) switched on later, with its own config, no hook redeploy
        cfg[0].params[0] = SetConfigParam(30184, 2, "");
        uint256 c0 = local.configs();
        receiver.addPeer(30184, address(other), true, cfg);
        assertEq(local.configs(), c0 + 1);
        assertEq(receiver.peers(30184), bytes32(uint256(uint160(address(other)))));
        (, PoolId baseId) = hook.createPool{value: 0.01 ether}(
            Disciple.CreateParams({coin: address(usd2()), fee: FEE, src: _pushSrc(30184), coinIn: 1000e18, quoteIn: 3000e18, srcKey: _noKey()})
        );
        bytes32 to = bytes32(uint256(uint160(address(receiver))));
        other.push{value: 0.01 ether}(30101, to, _req(address(pair), baseId), 200_000);
        local.deliver(address(receiver), 30184, address(other), home.lastMessage());
        assertTrue(hook.poolState(baseId).live, "new chain prices its pool");
        // the new sender cannot price the Robinhood pool
        assertEq(hook.poolState(id).anchorX128, a);

        // renounce: nothing can be added any more
        receiver.setOwner(address(0));
        vm.expectRevert(DisciplePushReceiver.OnlyOwner.selector);
        receiver.addPeer(30110, address(other), true, new LibConfig[](0));
    }

    MockERC20 internal coin2;

    function usd2() internal returns (MockERC20) {
        coin2 = new MockERC20("COIN2", "COIN2", 18);
        coin2.mint(address(this), 1e30);
        coin2.approve(address(hook), type(uint256).max);
        return coin2;
    }

    // -----------------------------------------------------------------------------------------
    // OP Stack portal (Ethereum -> Base) reuses the bridge path with its own sender
    // -----------------------------------------------------------------------------------------

    function test_opPortalPushOpensPool() public {
        MockPortal portal = new MockPortal();
        DiscipleOpSender op = new DiscipleOpSender(portal);
        bytes memory args = abi.encode(manager, address(usd), ILzRead(address(0)), address(op), address(0), address(0), address(0));
        Disciple base = new Disciple{salt: _mine(args)}(manager, address(usd), ILzRead(address(0)), address(op), address(0), address(0), address(0));
        Disciple.Source memory s = _src(0);
        s.remoteEid = base.BRIDGE_EID();
        vm.startPrank(lp);
        usd.approve(address(base), type(uint256).max);
        coin.approve(address(base), type(uint256).max);
        (, PoolId id) = base.createPool(
            Disciple.CreateParams({coin: address(coin), fee: FEE, src: s, coinIn: 1000e18, quoteIn: 3000e18, srcKey: _noKey()})
        );
        vm.stopPrank();
        op.push(address(base), id, 1, address(pair), bytes32(0), 5_000_000);
        assertEq(portal.lastGas(), op.MAX_L2_GAS(), "L2 gas capped");
        assertEq(portal.lastTo(), address(base));
        vm.warp(block.timestamp + 90);
        bytes memory data = portal.lastData();
        vm.prank(address(op)); // the portal delivers from the alias, not the sender itself
        (bool ok,) = address(base).call(data);
        assertFalse(ok);
        vm.prank(address(uint160(address(op)) + uint160(0x1111000000000000000000000000000000001111)));
        (ok,) = address(base).call(data);
        assertTrue(ok);
        assertTrue(base.poolState(id).live);
        assertEq(base.poolState(id).anchorX128, Q128 * 2);
    }

    // -----------------------------------------------------------------------------------------
    // gas (normal solc numbers are the ones that count)
    // -----------------------------------------------------------------------------------------

    function test_gasReport() public {
        (PoolKey memory key, PoolId id) = _createSame(10_000e18, 20_000e18);
        // a line of 300 LPs
        for (uint256 i = 0; i < 300; i++) {
            address w = address(uint160(0x1000 + i));
            _fund(w, 1000e18);
            vm.prank(w);
            hook.deposit(id, 1e18, 2e18);
        }
        _nextBlock();
        uint256 g = gasleft();
        _swap(key, true, -int256(20e18));
        emit log_named_uint("swap, first in block (settles the interval), incl. test router", g - gasleft());
        g = gasleft();
        _swap(key, false, -int256(5e18));
        emit log_named_uint("swap, same block, incl. test router", g - gasleft());
        g = gasleft();
        _swap(key, true, int256(3e18));
        emit log_named_uint("swap exact-out, same block, incl. test router", g - gasleft());
        _nextBlock();
        g = gasleft();
        vm.prank(lp);
        (uint256 lot, uint256 sh) = hook.deposit(id, 100e18, 200e18);
        emit log_named_uint("deposit at 302 lots (incl. first-in-block settle)", g - gasleft());
        g = gasleft();
        vm.prank(lp);
        hook.deposit(id, 100e18, 200e18);
        emit log_named_uint("deposit at 303 lots, same block", g - gasleft());
        g = gasleft();
        vm.prank(lp);
        hook.withdraw(id, lot, sh / 2, 0);
        emit log_named_uint("withdraw, same block", g - gasleft());
        g = gasleft();
        vm.prank(address(uint160(0x1000)));
        hook.withdraw(id, 2, 1e18, 0);
        emit log_named_uint("withdraw, front of the line", g - gasleft());
        g = gasleft();
        vm.prank(lp);
        hook.claim(id, lot);
        emit log_named_uint("claim", g - gasleft());
    }
}
