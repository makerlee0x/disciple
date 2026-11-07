// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {_noKey} from "./NoKey.sol";
import {Test, Vm} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
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
import {DiscipleHook} from "../../src/hook/DiscipleHook.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {DisciplePushSender} from "../../src/hook/routes/DisciplePushSender.sol";
import {DisciplePushReceiver} from "../../src/hook/routes/DisciplePushReceiver.sol";
import {IDisciplePriceTarget} from "../../src/hook/routes/DiscipleSourceReader.sol";
import {
    ILayerZeroEndpointV2Lite,
    MessagingParams,
    MessagingFee,
    MessagingReceipt,
    Origin,
    LibConfig,
    SetConfigParam
} from "../../src/hook/routes/ILayerZeroEndpointV2Lite.sol";
import {DisciplePoolTank, IWETH9, IDiscipleTank} from "../../src/hook/DisciplePoolTank.sol";

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
        DisciplePushReceiver(receiver)
            .lzReceive(
                Origin(srcEid, bytes32(uint256(uint160(from))), uint64(nonce)),
                bytes32(nonce),
                message,
                address(this),
                ""
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
    DiscipleHook hook;
    PoolSwapTest swapper;
    MockERC20 usd;
    MockERC20 coin;
    MockPair pair;
    MockV2Factory v2f;
    MockEndpoint home; // LayerZero endpoint on the home chain (Robinhood here)
    MockEndpoint local; // LayerZero endpoint on the pool's chain (Ethereum here)
    DisciplePushSender pushSender;
    DisciplePushReceiver receiver;
    uint32 internal constant HOME_EID = 30416; // Robinhood
    uint32 internal constant HYPE_EID = 30367; // HyperEVM: gas is HYPE, so no refund
    address lp = address(0xA11CE);
    MockPair refPair;

    receive() external payable {}

    function setUp() public {
        vm.roll(100);
        vm.warp(1_000_000);
        manager = IPoolManager(address(new PoolManager(address(this))));
        usd = new MockERC20("USD", "USD", 18);
        coin = new MockERC20("COIN", "COIN", 18);
        pair = new MockPair();
        home = new MockEndpoint(HOME_EID);
        local = new MockEndpoint(30101);
        pushSender = new DisciplePushSender(home, new LibConfig[](0), 125_000);
        receiver = _receiver(address(pushSender));
        // source: coin is token0 of the pair; price 2 quote per coin
        pair.set(1_000_000e18, 2_000_000e18);
        pair.setTokens(address(coin), address(usd));
        v2f = new MockV2Factory();
        v2f.add(address(pair));
        // tip-jar reference: a WETH/USD pool at 3000 USD per ETH (WETH is token0)
        refPair = new MockPair();
        refPair.set(1_000e18, 3_000_000e18);
        DiscipleHook.Config memory cfg =
            DiscipleHook.Config(10_000, address(usd), 1, address(refPair), bytes32(0), true);
        bytes memory args = abi.encode(manager, address(receiver), address(v2f), address(0), address(0), cfg);
        bytes32 salt = _mine(args);
        hook = new DiscipleHook{salt: salt}(manager, address(receiver), address(v2f), address(0), address(0), cfg);
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
        bytes32 initHash = keccak256(abi.encodePacked(type(DiscipleHook).creationCode, args));
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
        r = new DisciplePushReceiver(local, eids, senders, eth, new LibConfig[](0), 100_000);
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

    function _src(uint32 eid) internal view returns (DiscipleHook.Source memory s) {
        s.kind = 1; // v2
        s.coinIs0 = true;
        s.remoteEid = eid;
        s.target = address(pair);
        s.push = eid != 0;
    }

    function _createSame(uint256 coinIn, uint256 quoteIn) internal returns (PoolKey memory key, PoolId id) {
        (key, id) = hook.createPool(
            DiscipleHook.CreateParams({
                coin: address(coin),
                quote: address(usd),
                fee: FEE,
                src: _src(0),
                coinIn: coinIn,
                quoteIn: quoteIn,
                srcKey: _noKey(),
                srcKey2: _noKey()
            })
        );
    }

    function _createCross(uint256 coinIn, uint256 quoteIn, uint256 eth)
        internal
        returns (PoolKey memory key, PoolId id)
    {
        (key, id) = hook.createPool{value: eth}(
            DiscipleHook.CreateParams({
                coin: address(coin),
                quote: address(usd),
                fee: FEE,
                src: _src(30101),
                coinIn: coinIn,
                quoteIn: quoteIn,
                srcKey: _noKey(),
                srcKey2: _noKey()
            })
        );
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
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 1);
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
        DiscipleHook.PoolView memory v = hook.poolState(id);
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
        // price 2 plus the fee: fewer than 10 coins, but not absurdly few
        assertLt(got, 10e18, "buy pays at least the anchor");
        assertGt(got, 9e18, "buy within ~10% of the anchor");
        DiscipleHook.PoolView memory v = hook.poolState(id);
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

    // -----------------------------------------------------------------------------------------
    // price step (replaces the lag premium)
    // -----------------------------------------------------------------------------------------

    function _px(uint256 quoteReserve) internal pure returns (uint256) {
        return Math.mulDiv(quoteReserve, Q128, 1_000_000e18);
    }

    /// A 10% real move: each reading moves the centre at most the step (max(fee 0.3%, minStep 1%) = 1%).
    function test_stepCapsEachReading() public {
        (, PoolId id) = _createSame(1000e18, 2000e18);
        uint256 a = hook.poolState(id).anchorX128;
        pair.set(1_000_000e18, 2_200_000e18);
        _nextBlock();
        hook.sample(id); // latches the old sample, records the moved one
        assertEq(hook.poolState(id).anchorX128, a, "the first reading of a move only records it");
        for (uint256 i = 0; i < 5; i++) {
            _nextBlock();
            hook.sample(id);
            uint256 n = hook.poolState(id).anchorX128;
            assertEq(n, Math.mulDiv(a, 1_010_000, 1_000_000), "one 1% step per reading");
            a = n;
        }
        for (uint256 i = 0; i < 6; i++) {
            _nextBlock();
            hook.sample(id);
        }
        assertEq(hook.poolState(id).anchorX128, _px(2_200_000e18), "caught up after ~10 readings");
    }

    function test_stepDownAndSmallMoveInOneReading() public {
        (, PoolId id) = _createSame(1000e18, 2000e18);
        pair.set(1_000_000e18, 2_010_000e18); // +0.5%: inside one step
        _nextBlock();
        hook.sample(id);
        _nextBlock();
        hook.sample(id);
        assertEq(hook.poolState(id).anchorX128, _px(2_010_000e18), "a small move lands in one reading");
        uint256 a = hook.poolState(id).anchorX128;
        pair.set(1_000_000e18, 1_800_000e18); // -10%
        _nextBlock();
        hook.sample(id);
        _nextBlock();
        hook.sample(id);
        assertEq(hook.poolState(id).anchorX128, Math.mulDiv(a, 990_000, 1_000_000, Math.Rounding.Ceil), "down 1%");
    }

    /// With a pool fee above minStep the step is the fee.
    function test_stepIsPoolFeeWhenLarger() public {
        DiscipleHook.CreateParams memory cp = DiscipleHook.CreateParams({
            coin: address(coin),
            quote: address(usd),
            fee: 30_000,
            src: _src(0),
            coinIn: 1000e18,
            quoteIn: 2000e18,
            srcKey: _noKey(),
            srcKey2: _noKey()
        });
        (, PoolId id) = hook.createPool(cp);
        uint256 a = hook.poolState(id).anchorX128;
        pair.set(1_000_000e18, 2_200_000e18);
        _nextBlock();
        hook.sample(id);
        _nextBlock();
        hook.sample(id);
        assertEq(hook.poolState(id).anchorX128, Math.mulDiv(a, 1_030_000, 1_000_000), "3% step at a 3% fee");
    }

    /// Quiet pool: no premium, so after any idle time both sides quote the centre plus the fee only.
    function test_quietPoolQuotesFeeOnlyBothSides() public {
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        vm.roll(vm.getBlockNumber() + 1); // same second as creation: there is no opening premium either
        hook.sample(id);
        uint256 a = hook.poolState(id).anchorX128;
        uint256 buyOut = _coinsOut(key, true, 2e18);
        uint256 sellOut = _coinsOut(key, false, 1e18);
        uint256 buyPx = Math.mulDiv(2e18, Q128, buyOut);
        uint256 sellPx = Math.mulDiv(sellOut, Q128, 1e18);
        assertLe(buyPx, Math.mulDiv(a, 1_005_000, 1_000_000), "buy within fee + 0.2% of the centre");
        assertGe(sellPx, Math.mulDiv(a, 995_000, 1_000_000), "sell within fee + 0.2% of the centre");
        assertGt(buyPx, a, "buy above the centre");
        assertLt(sellPx, a, "sell below the centre");
        // idle 30 minutes: same quotes
        vm.warp(vm.getBlockTimestamp() + 30 minutes);
        _nextBlock();
        assertEq(_coinsOut(key, true, 2e18), buyOut, "idle time changes nothing");
    }

    function test_sampleDoesNotSettle() public {
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        _nextBlock();
        _swap(key, true, -int256(20e18));
        uint256 settled = hook.poolState(id).ageOrBlock;
        _nextBlock();
        hook.sample(id);
        assertEq(hook.poolState(id).ageOrBlock, settled, "sample() leaves the books open");
        assertEq(hook.poolState(id).sampleAt, uint64(vm.getBlockTimestamp()));
    }

    function _sell(PoolKey memory key, uint256 amt) internal returns (uint256 got) {
        uint256 u0 = usd.balanceOf(address(this));
        _swap(key, false, -int256(amt));
        got = usd.balanceOf(address(this)) - u0;
    }

    /// Sample-then-trade (review of #243): block A pumps the leader, touches the pool so it records the fake
    /// sample, unwinds; block B pumps again and sells into the faked centre. The step caps the fake reading's
    /// effect on the centre at 1%, so the attacker's edge over an honest seller stays under it at any pump size.
    function test_sampleThenTradeCappedByStep() public {
        uint112[3] memory q = [uint112(2_040_000e18), 2_100_000e18, 2_200_000e18];
        for (uint256 i; i < 3; i++) {
            uint256 snap0 = vm.snapshotState();
            (PoolKey memory key,) = _createSame(1000e18, 2000e18);
            _nextBlock();
            _swap(key, true, -int256(1e12));
            _nextBlock();
            uint256 snap = vm.snapshotState();
            _swap(key, true, -int256(1e12));
            _nextBlock();
            uint256 honest = _sell(key, 50e18);
            vm.revertToState(snap);
            pair.set(1_000_000e18, q[i]);
            _swap(key, true, -int256(1e12));
            pair.set(1_000_000e18, 2_000_000e18);
            _nextBlock();
            pair.set(1_000_000e18, q[i]);
            uint256 attacked = _sell(key, 50e18);
            pair.set(1_000_000e18, 2_000_000e18);
            uint256 gainBps = attacked > honest ? (attacked - honest) * 10_000 / honest : 0;
            emit log_named_uint("pump bps", (uint256(q[i]) - 2_000_000e18) * 10_000 / 2_000_000e18);
            emit log_named_uint("  attacker gain bps", gainBps);
            assertLe(gainBps, 100, "edge capped by the 1% step");
            vm.revertToState(snap0);
        }
    }

    // -----------------------------------------------------------------------------------------
    // tip jar
    // -----------------------------------------------------------------------------------------

    /// Round trips in fresh blocks, so each interval settles with earnings.
    function _churn(PoolKey memory key, uint256 n) internal {
        for (uint256 i = 0; i < n; i++) {
            _nextBlock();
            uint256 c0 = coin.balanceOf(address(this));
            _swap(key, true, -int256(100e18));
            _nextBlock();
            _swap(key, false, -int256(coin.balanceOf(address(this)) - c0 + 0));
        }
        _nextBlock();
        _swap(key, true, -int256(1e12)); // settle the last interval
    }

    function _jarValue(PoolId id) internal view returns (uint256) {
        DiscipleHook.PoolView memory v = hook.poolState(id);
        return Math.mulDiv(v.jarX, v.anchorX128, Q128) + v.jarY;
    }

    /// cap = 320 tips x 150k gas x basefee x 1.2, in USD at 3000 per ETH.
    function _cap() internal view returns (uint256) {
        return 320 * 150_000 * block.basefee * 12 / 10 * 3000;
    }

    function test_jarFillsFromSkimAndStopsAtCap() public {
        vm.fee(0.01 gwei);
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        assertEq(_jarValue(id), 0);
        _churn(key, 3);
        uint256 j = _jarValue(id);
        assertGt(j, 0, "the skim fills the jar");
        assertLe(j, _cap(), "never above the cap");
        DiscipleHook.PoolView memory v = hook.poolState(id);
        assertEq(_claims(address(coin)), v.coinReserve + v.jarX, "jar coin is held as claims beside the book");
        assertEq(_claims(address(usd)), v.quoteReserve + v.jarY, "jar quote is held as claims beside the book");
        _churn(key, 40);
        assertApproxEqRel(_jarValue(id), _cap(), 0.02e18, "full");
        assertLe(_jarValue(id), _cap() + 1e6, "and stops there");
    }

    function test_noBasefeeNoSkim() public {
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        _churn(key, 3);
        assertEq(_jarValue(id), 0, "a zero basefee values the cap at zero");
    }

    function test_tipPaidOnlyWhenBehindAndOncePerBlock() public {
        vm.fee(0.01 gwei);
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        _churn(key, 40);
        uint256 j0 = _jarValue(id);
        address bot = address(0xB07);
        // centre on the leader: no tip
        _nextBlock();
        vm.prank(bot);
        hook.sample(id);
        assertEq(usd.balanceOf(bot) + coin.balanceOf(bot), 0, "nothing paid while caught up");
        // leader +5%: due
        pair.set(1_000_000e18, 2_100_000e18);
        _nextBlock();
        vm.prank(bot);
        hook.sample(id);
        uint256 t1 = usd.balanceOf(bot);
        assertGt(t1, 0, "tip paid while 1% or more behind");
        assertLe(t1, j0 / 32, "at most 1/32 of the jar");
        // roughly (measured gas + overhead) x basefee x 1.2 at 3000 USD per ETH: well under a cent here
        assertLt(t1, 0.02e18, "about gas + 20%");
        vm.prank(bot);
        hook.sample(id); // same block again
        assertEq(usd.balanceOf(bot), t1, "one tip per block");
        // keep sampling until caught up; then tips stop
        for (uint256 i = 0; i < 8; i++) {
            _nextBlock();
            vm.prank(bot);
            hook.sample(id);
        }
        uint256 t2 = usd.balanceOf(bot);
        _nextBlock();
        vm.prank(bot);
        hook.sample(id);
        assertEq(usd.balanceOf(bot), t2, "caught up: no more tips");
    }

    function test_gasTippedSample() public {
        vm.fee(0.01 gwei);
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        _churn(key, 40);
        pair.set(1_000_000e18, 2_100_000e18);
        _nextBlock();
        uint256 g = gasleft();
        hook.sample(id);
        emit log_named_uint("sample(), tipped, v2 source (excl. 21k intrinsic)", g - gasleft());
        _nextBlock();
        pair.set(1_000_000e18, 2_000_000e18);
        g = gasleft();
        hook.sample(id);
        emit log_named_uint("sample(), next block, leader back near the centre", g - gasleft());
    }

    function test_jarRunsDryWithoutReverting() public {
        vm.fee(0.01 gwei);
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        _churn(key, 1);
        address bot = address(0xB07);
        uint256 lastX = type(uint256).max;
        uint256 lastY = type(uint256).max;
        // alternate the leader by 5% each block so every sample is due; each tip takes at most 1/32 of the jar
        for (uint256 i = 0; i < 1500; i++) {
            pair.set(1_000_000e18, i % 2 == 0 ? 2_100_000e18 : 2_000_000e18);
            _nextBlock();
            vm.prank(bot);
            hook.sample(id);
            DiscipleHook.PoolView memory v = hook.poolState(id);
            assertLe(v.jarX, lastX, "the jar only drains without trades");
            assertLe(v.jarY, lastY, "the jar only drains without trades");
            (lastX, lastY) = (v.jarX, v.jarY);
        }
        assertLt(_jarValue(id), 1e15, "nearly dry");
        pair.set(1_000_000e18, 2_200_000e18);
        _nextBlock();
        hook.sample(id); // still works, pays what is left
    }

    function test_seedWithdrawalLeavesTheJar() public {
        vm.fee(0.01 gwei);
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        vm.prank(lp);
        hook.deposit(id, 100e18, 1000e18);
        _churn(key, 10);
        DiscipleHook.PoolView memory v = hook.poolState(id);
        uint256 jx = v.jarX;
        uint256 jy = v.jarY;
        assertGt(jx + jy, 0);
        (address owner, uint256 principal,,,) = hook.lotState(id, 1);
        assertEq(owner, address(this));
        _nextBlock();
        hook.withdraw(id, 1, principal, 0); // creator pulls the seed lot
        v = hook.poolState(id);
        assertEq(v.jarX, jx, "jar coin untouched");
        assertEq(v.jarY, jy, "jar quote untouched");
        assertEq(_claims(address(usd)), v.quoteReserve + v.jarY + _escrowY(id), "claims = book + jar (+ escrow)");
        // the jar still pays with the seed gone
        pair.set(1_000_000e18, 2_100_000e18);
        _nextBlock();
        vm.prank(address(0xB07));
        hook.sample(id);
        assertGt(usd.balanceOf(address(0xB07)), 0, "tips continue from the pool's jar");
    }

    function _escrowY(PoolId) internal pure returns (uint256) {
        return 0; // not graduated in these tests: nothing is escrowed
    }

    /// A pool whose tokens cannot be valued in ETH (neither is WETH nor the reference token) pays from its tank.
    function test_unvaluedPoolTipsFromTank() public {
        vm.fee(0.01 gwei);
        MockERC20 c2 = usd2();
        MockPair p2 = new MockPair();
        p2.set(1_000_000e18, 2_000_000e18);
        p2.setTokens(address(c2), address(coin));
        v2f.add(address(p2));
        DiscipleHook.Source memory s;
        s.kind = 1;
        s.coinIs0 = true;
        s.target = address(p2);
        (PoolKey memory key, PoolId id) = hook.createPool(
            DiscipleHook.CreateParams({
                coin: address(c2),
                quote: address(coin),
                fee: FEE,
                src: s,
                coinIn: 1000e18,
                quoteIn: 2000e18,
                srcKey: _noKey(),
                srcKey2: _noKey()
            })
        );
        key;
        hook.fundTank{value: 0.01 ether}(id);
        p2.set(1_000_000e18, 2_100_000e18);
        _nextBlock();
        address bot = address(0xB07);
        vm.prank(bot);
        hook.sample(id);
        assertGt(bot.balance, 0, "paid in ETH from the tank");
        assertLe(bot.balance, 0.002 ether);
        assertEq(hook.poolState(id).jarX + hook.poolState(id).jarY, 0, "no jar for an unvalued pool");
    }

    // -----------------------------------------------------------------------------------------
    // quote
    // -----------------------------------------------------------------------------------------

    function _quote(PoolId id, bool zeroForOne, int256 amt) internal returns (uint256 i, uint256 o) {
        (bool ok, bytes memory r) = address(hook).call(abi.encodeCall(DiscipleHook.quote, (id, zeroForOne, amt)));
        assertFalse(ok, "quote always reverts");
        assertEq(bytes4(r), DiscipleHook.Quote.selector, "with the result");
        assembly {
            i := mload(add(r, 36))
            o := mload(add(r, 68))
        }
    }

    function _check(PoolKey memory key, PoolId id, bool buy, int256 amt) internal {
        bool coinIs0 = Currency.unwrap(key.currency0) == address(coin);
        bool z = buy ? !coinIs0 : coinIs0;
        (uint256 qi, uint256 qo) = _quote(id, z, amt);
        MockERC20 inT = buy ? usd : coin;
        MockERC20 outT = buy ? coin : usd;
        uint256 i0 = inT.balanceOf(address(this));
        uint256 o0 = outT.balanceOf(address(this));
        _swap(key, buy, amt);
        assertEq(i0 - inT.balanceOf(address(this)), qi, "quoted input = paid");
        assertEq(outT.balanceOf(address(this)) - o0, qo, "quoted output = received");
    }

    function test_quoteMatchesSwap() public {
        vm.fee(0.01 gwei);
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        _churn(key, 3);
        pair.set(1_000_000e18, 2_060_000e18); // a real move, so the quote has to include the latch
        _nextBlock();
        _nextBlock();
        _check(key, id, true, -20e18); // first touch of the block: latch + settle
        _check(key, id, false, -5e18); // same block
        _check(key, id, true, 3e18); // exact out
        _nextBlock();
        _check(key, id, false, 4e18);
        uint256 a = hook.poolState(id).anchorX128;
        _quote(id, true, -1e18);
        assertEq(hook.poolState(id).anchorX128, a, "a quote changes nothing");
    }

    // -----------------------------------------------------------------------------------------
    // standard hook events
    // -----------------------------------------------------------------------------------------

    event HookSwap(
        bytes32 indexed id,
        address indexed sender,
        int128 amount0,
        int128 amount1,
        uint128 hookLPfeeAmount0,
        uint128 hookLPfeeAmount1
    );
    event HookModifyLiquidity(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1);

    function test_hookSwapAndModifyLiquidityEvents() public {
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        bool coinIs0 = Currency.unwrap(key.currency0) == address(coin);
        _nextBlock();
        uint256 out = _coinsOut(key, true, 20e18);
        // buy: quote in, coin out; fee = 0.3% of the input
        (int128 a0, int128 a1) =
            coinIs0 ? (-int128(uint128(out)), int128(20e18)) : (int128(20e18), -int128(uint128(out)));
        (uint128 f0, uint128 f1) = coinIs0 ? (uint128(0), uint128(0.06e18)) : (uint128(0.06e18), uint128(0));
        vm.expectEmit(true, true, false, true, address(hook));
        emit HookSwap(PoolId.unwrap(id), address(swapper), a0, a1, f0, f1);
        _swap(key, true, -int256(20e18));

        _nextBlock();
        vm.prank(lp);
        vm.recordLogs();
        hook.deposit(id, 10e18, 1000e18);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == HookModifyLiquidity.selector) {
                (int128 m0, int128 m1) = abi.decode(logs[i].data, (int128, int128));
                assertGt(m0, 0);
                assertGt(m1, 0);
                assertEq(logs[i].topics[2], bytes32(uint256(uint160(lp))));
                seen = true;
            }
        }
        assertTrue(seen, "HookModifyLiquidity on deposit");
    }

    function test_sampleRejectsCrossChainAndUnknown() public {
        (, PoolId id) = _createCross(1000e18, 2000e18, 0);
        vm.expectRevert(DiscipleHook.BadParams.selector);
        hook.sample(id);
        vm.expectRevert(DiscipleHook.UnknownPool.selector);
        hook.sample(PoolId.wrap(bytes32(uint256(1))));
    }

    function _coinsOut(PoolKey memory key, bool buy, uint256 amountIn) internal returns (uint256 out) {
        uint256 snap = vm.snapshotState();
        uint256 ts = vm.getBlockTimestamp();
        uint256 bn = vm.getBlockNumber();
        MockERC20 token = buy ? coin : usd;
        uint256 b0 = token.balanceOf(address(this));
        _swap(key, buy, -int256(amountIn));
        out = token.balanceOf(address(this)) - b0;
        vm.revertToState(snap);
        vm.warp(ts);
        vm.roll(bn);
    }

    function _cp(DiscipleHook.Source memory s, PoolKey memory k)
        internal
        view
        returns (DiscipleHook.CreateParams memory)
    {
        return DiscipleHook.CreateParams({
            coin: address(coin),
            quote: address(usd),
            fee: FEE,
            src: s,
            coinIn: 1000e18,
            quoteIn: 3000e18,
            srcKey: k,
            srcKey2: _noKey()
        });
    }

    function test_sameChainSourceMustBeTheRealPairPool() public {
        DiscipleHook.Source memory s = _src(0);
        // a look-alike pair the factory does not know: refused
        MockPair fake = new MockPair();
        fake.set(1e18, 1e18);
        fake.setTokens(address(coin), address(usd));
        s.target = address(fake);
        vm.expectRevert(DiscipleHook.BadParams.selector);
        hook.createPool(_cp(s, _noKey()));
        // a real pair of other tokens: refused
        MockERC20 other = new MockERC20("O", "O", 18);
        MockPair op = new MockPair();
        op.set(1e18, 1e18);
        op.setTokens(address(other), address(usd));
        v2f.add(address(op));
        s.target = address(op);
        vm.expectRevert(DiscipleHook.BadParams.selector);
        hook.createPool(_cp(s, _noKey()));
        // the right pair, wrong orientation: refused
        s.target = address(pair);
        s.coinIs0 = false;
        vm.expectRevert(DiscipleHook.BadParams.selector);
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
        DiscipleHook.Source memory s;
        s.kind = 3;
        s.coinIs0 = coinIs0;
        s.target = address(manager);
        s.v4Id = PoolId.unwrap(src.toId());
        // a key that does not hash to the id: refused
        PoolKey memory wrong = PoolKey(src.currency0, src.currency1, 500, 60, IHooks(address(0)));
        vm.expectRevert(DiscipleHook.BadParams.selector);
        hook.createPool(_cp(s, wrong));
        // the real key works
        (PoolKey memory key, PoolId id) = hook.createPool(_cp(s, src));
        assertTrue(hook.poolState(id).live);
        // one of this hook's own pools as a source: refused
        s.v4Id = PoolId.unwrap(id);
        vm.expectRevert(DiscipleHook.BadParams.selector);
        hook.createPool(_cp(s, key));
    }

    function test_severalPoolsPerCoin() public {
        (PoolKey memory k1, PoolId id1) = _createSame(1000e18, 2000e18);
        vm.prank(lp);
        (PoolKey memory k2, PoolId id2) = hook.createPool(_cp(_src(0), _noKey()));
        assertEq(k1.tickSpacing, 1);
        assertEq(k2.tickSpacing, 2);
        assertTrue(PoolId.unwrap(id1) != PoolId.unwrap(id2));
        (address a0, address a1) =
            address(coin) < address(usd) ? (address(coin), address(usd)) : (address(usd), address(coin));
        assertEq(hook.poolsOf(a0, a1), 2);
        assertTrue(hook.poolState(id2).live);
        _nextBlock();
        _swap(k2, true, -1e18);
    }

    /// @dev A v2 pair of (t0, t1) with reserves (r0, r1), known to the factory.
    function _pairOf(address t0, address t1, uint112 r0, uint112 r1) internal returns (MockPair q) {
        q = new MockPair();
        q.setTokens(t0, t1);
        q.set(r0, r1);
        v2f.add(address(q));
    }

    function _twoHop(address leg1, bool coinIs0, address leg2, bool xIs0)
        internal
        pure
        returns (DiscipleHook.Source memory s)
    {
        s.kind = 1;
        s.coinIs0 = coinIs0;
        s.target = leg1;
        s.kind2 = 1;
        s.xIs0 = xIs0;
        s.target2 = leg2;
    }

    /// @dev "USDG pool beside an ETH main pool": COIN/WETH x WETH/USD.
    function test_twoHopPricesThroughASharedToken() public {
        MockERC20 w = new MockERC20("WETH", "WETH", 18);
        MockPair a = _pairOf(address(coin), address(w), 1_000_000e18, 500e18); // 0.0005 WETH per coin
        MockPair b = _pairOf(address(w), address(usd), 10_000e18, 30_000_000e18); // 3000 USD per WETH
        DiscipleHook.Source memory s = _twoHop(address(a), true, address(b), true);
        (PoolKey memory key, PoolId id) = hook.createPool(_cp(s, _noKey()));
        DiscipleHook.PoolView memory v = hook.poolState(id);
        assertEq(v.quote, address(usd));
        assertApproxEqRel(v.anchorX128, Q128 * 3 / 2, 1e12, "1.5 USD per coin = 0.0005 x 3000");
        // the fill never beats the two-hop route's ask (both legs' 0.3% fees)
        _nextBlock();
        vm.warp(block.timestamp + 60);
        uint256 c0 = coin.balanceOf(address(this));
        _swap(key, true, -int256(30e18));
        uint256 got = coin.balanceOf(address(this)) - c0;
        uint256 routeAsk = Math.mulDiv(Q128 * 3 / 2, 1e12, 997_000 * 997_000);
        assertLe(got, Math.mulDiv(30e18, Q128, routeAsk) * 10_001 / 10_000, "not better than the two-hop ask");
        // the TVL counts leg 1 converted to USD: 2 x 500 WETH x 3000
        assertApproxEqRel(hook.poolState(id).srcTvl, 3_000_000e18, 1e12);
    }

    /// @dev A cross pair like STRATEGY/AI: COIN/X and QUOTE/X share X.
    function test_twoHopCrossPair() public {
        MockERC20 x = new MockERC20("X", "X", 6);
        MockPair a = _pairOf(address(coin), address(x), 1_000_000e18, 4_000_000e6); // 4 X per coin
        MockPair b = _pairOf(address(usd), address(x), 1_000_000e18, 2_000_000e6); // 2 X per quote
        // leg 2 is X -> quote, and X is token1 of b
        DiscipleHook.Source memory s = _twoHop(address(a), true, address(b), false);
        (, PoolId id) = hook.createPool(_cp(s, _noKey()));
        assertApproxEqRel(hook.poolState(id).anchorX128, Q128 * 2, 1e12, "2 quote per coin");
    }

    function test_twoHopLegsMustShareTheToken() public {
        MockERC20 w = new MockERC20("WETH", "WETH", 18);
        MockERC20 z = new MockERC20("Z", "Z", 18);
        MockPair a = _pairOf(address(coin), address(w), 1e24, 1e21);
        MockPair b = _pairOf(address(z), address(usd), 1e24, 1e24); // Z, not WETH
        vm.expectRevert(DiscipleHook.BadParams.selector);
        hook.createPool(_cp(_twoHop(address(a), true, address(b), true), _noKey()));
        // leg 2 ends in the wrong quote
        MockPair c = _pairOf(address(w), address(z), 1e24, 1e24);
        vm.expectRevert(DiscipleHook.BadParams.selector);
        hook.createPool(_cp(_twoHop(address(a), true, address(c), true), _noKey()));
        // a remote pool cannot be two-hop
        DiscipleHook.Source memory s = _twoHop(address(a), true, address(b), true);
        s.remoteEid = HOME_EID;
        s.push = true;
        vm.expectRevert(DiscipleHook.BadParams.selector);
        hook.createPool{value: 0.01 ether}(_cp(s, _noKey()));
    }

    /// @dev Native ETH in a v4 source counts as the hook's WETH.
    function test_nativeEthSourceCountsAsWeth() public {
        MockERC20 w = new MockERC20("WETH", "WETH", 18);
        bytes memory args = abi.encode(
            manager,
            address(0),
            address(v2f),
            address(0),
            address(w),
            DiscipleHook.Config(10_000, address(0), 0, address(0), bytes32(0), false)
        );
        DiscipleHook h = new DiscipleHook{salt: _mine(args)}(
            manager,
            address(0),
            address(v2f),
            address(0),
            address(w),
            DiscipleHook.Config(10_000, address(0), 0, address(0), bytes32(0), false)
        );
        PoolKey memory src =
            PoolKey(Currency.wrap(address(0)), Currency.wrap(address(coin)), 3000, 60, IHooks(address(0)));
        manager.initialize(src, TickMath.getSqrtPriceAtTick(-6900)); // ~2 ETH per coin... coin is currency1
        DiscipleHook.Source memory s;
        s.kind = 3;
        s.coinIs0 = false;
        s.target = address(manager);
        s.v4Id = PoolId.unwrap(src.toId());
        w.mint(address(this), 1e24);
        w.approve(address(h), type(uint256).max);
        coin.approve(address(h), type(uint256).max);
        DiscipleHook.CreateParams memory cp = DiscipleHook.CreateParams({
            coin: address(coin),
            quote: address(w),
            fee: FEE,
            src: s,
            coinIn: 100e18,
            quoteIn: 1000e18,
            srcKey: src,
            srcKey2: _noKey()
        });
        (, PoolId id) = h.createPool(cp);
        assertTrue(h.poolState(id).live);
        // the main hook has no WETH set, so native is not the quote there
        vm.expectRevert(DiscipleHook.BadParams.selector);
        hook.createPool(cp);
    }

    /// @dev Pools of one pair share one counter whichever side is the coin, so a reversed pool cannot block it.
    function test_reversedPairDoesNotBlock() public {
        DiscipleHook.Source memory s = _src(0);
        s.coinIs0 = false; // usd as the coin: it is token1 of the pair
        DiscipleHook.CreateParams memory cp = DiscipleHook.CreateParams({
            coin: address(usd),
            quote: address(coin),
            fee: FEE,
            src: s,
            coinIn: 3000e18,
            quoteIn: 1000e18,
            srcKey: _noKey(),
            srcKey2: _noKey()
        });
        (PoolKey memory k1,) = hook.createPool(cp);
        (PoolKey memory k2,) = _createSame(1000e18, 2000e18);
        assertEq(k1.tickSpacing, 1);
        assertEq(k2.tickSpacing, 2);
    }

    function test_sameChainBuyNeverBelowLiveSourceAsk() public {
        (PoolKey memory key,) = _createSame(1000e18, 2000e18);
        _nextBlock();
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
        DiscipleHook.PoolView memory v = hook.poolState(id);
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

    function _pushSrc(uint32 eid) internal view returns (DiscipleHook.Source memory s) {
        s = _src(0);
        s.remoteEid = eid;
        s.push = true;
    }

    function _createPush(uint32 eid, uint256 eth) internal returns (PoolKey memory key, PoolId id) {
        (key, id) = hook.createPool{value: eth}(
            DiscipleHook.CreateParams({
                coin: address(coin),
                quote: address(usd),
                fee: FEE,
                src: _pushSrc(eid),
                coinIn: 1000e18,
                quoteIn: 3000e18,
                srcKey: _noKey(),
                srcKey2: _noKey()
            })
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
        _lzPush(id, address(0xC0FFEE), 40, HOME_EID);
        DiscipleHook.PoolView memory v = hook.poolState(id);
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
        uint256 cost = carried + (receiver.msgGas() + receiver.POOL_GAS()) * 5 gwei;
        if (cost > 0.002 ether) cost = 0.002 ether; // the hook's per-refund cap (MAX_PUSH_REFUND)
        assertEq(address(k).balance, 1 ether - home.FEE() + cost * 12 / 10, "refund = cost * 1.2");
    }

    function test_lzPushRejectsForgedPeerAndWrongChain() public {
        (, PoolId id) = _createPush(HOME_EID, 0.05 ether);
        _lzPush(id, address(0xC0FFEE), 40, HOME_EID);
        uint256 a = hook.poolState(id).anchorX128;

        // only the receiver may call the hook on the push route; only the endpoint may call the receiver
        vm.expectRevert(DiscipleHook.OnlyBridge.selector);
        hook.onBridgePrice(
            id, HOME_EID, 1, address(pair), bytes32(0), 1e18, 9e18, uint64(block.timestamp), address(this), 0
        );
        Origin memory o = Origin(HOME_EID, bytes32(uint256(uint160(address(pushSender)))), 1);
        bytes memory last = home.lastMessage();
        vm.expectRevert(DisciplePushReceiver.OnlyEndpoint.selector);
        receiver.lzReceive(o, bytes32(0), last, address(0), "");

        // a sender that is not the registered peer for that chain
        pair.set(1_000_000e18, 2_500_000e18);
        DisciplePushSender rogue = new DisciplePushSender(home, new LibConfig[](0), 125_000);
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
        // a delivery that carries ETH is refused (nothing could pass it on)
        vm.deal(address(local), 1 ether);
        vm.prank(address(local));
        vm.expectRevert(DisciplePushReceiver.NoValue.selector);
        receiver.lzReceive{value: 1}(o, bytes32(0), last, address(0), "");
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
        assertTrue(hook.poolState(id).local);
        _lzPush(id, address(0xC0FFEE), 21 minutes, HOME_EID);
        assertTrue(hook.poolState(id).local, "too old to end local mode");
        _lzPush(id, address(0xC0FFEE), 3 minutes, HOME_EID);
        assertFalse(hook.poolState(id).local, "recovered over LayerZero push");
    }

    /// @dev Ported from the removed lzRead test: local mode blocks deposits, allows withdrawals, and a fresh push
    ///      ends it, re-centres, and reopens deposits.
    function test_lzPushLocalModeDepositsWaitWithdrawalsWork() public {
        (PoolKey memory key, PoolId id) = _createPush(HOME_EID, 0.001 ether);
        _lzPush(id, address(0xC0FFEE), 40, HOME_EID);
        vm.warp(block.timestamp + 2 hours + 1);
        _swap(key, true, -int256(10e18));
        assertTrue(hook.poolState(id).local, "local mode");
        vm.prank(lp);
        vm.expectRevert(DiscipleHook.PendingTrades.selector);
        hook.deposit(id, 10e18, 10e18);
        hook.withdraw(id, 1, 1e18, 0); // the creator's lot exits mid-interval
        pair.set(1_000_000e18, 2_100_000e18);
        _lzPush(id, address(0xC0FFEE), 30, HOME_EID);
        DiscipleHook.PoolView memory v = hook.poolState(id);
        assertFalse(v.local, "recovered");
        assertEq(v.anchorX128, Q128 * 21 / 10);
        vm.prank(lp);
        hook.deposit(id, 10e18, 30e18);
    }

    function test_createPushNeedsReceiverAndChain() public {
        DiscipleHook.Source memory s = _pushSrc(0);
        vm.expectRevert(DiscipleHook.BadParams.selector);
        hook.createPool(
            DiscipleHook.CreateParams({
                coin: address(coin),
                quote: address(usd),
                fee: FEE,
                src: s,
                coinIn: 1e18,
                quoteIn: 3e18,
                srcKey: _noKey(),
                srcKey2: _noKey()
            })
        );
        s = _pushSrc(HOME_EID);
        s.push = false; // a remote pool must be a push pool (lzRead and the rollup bridge are gone)
        vm.expectRevert(DiscipleHook.BadParams.selector);
        hook.createPool(
            DiscipleHook.CreateParams({
                coin: address(coin),
                quote: address(usd),
                fee: FEE,
                src: s,
                coinIn: 1e18,
                quoteIn: 3e18,
                srcKey: _noKey(),
                srcKey2: _noKey()
            })
        );
    }

    function test_lzPushBatchesSourcesAndSplitsCost() public {
        // two sources, three pools: two pools on `pair`, one on `pair2`, all in one message
        MockPair pair2 = new MockPair();
        pair2.set(1_000_000e18, 5_000_000e18);
        (PoolKey memory k1, PoolId p1) = _createPush(HOME_EID, 0.05 ether);
        MockERC20 c2 = usd2();
        DiscipleHook.Source memory s = _pushSrc(HOME_EID);
        (PoolKey memory k2, PoolId p2) = hook.createPool{value: 0.05 ether}(
            DiscipleHook.CreateParams({
                coin: address(c2),
                quote: address(usd),
                fee: 10_000,
                src: s,
                coinIn: 1000e18,
                quoteIn: 3000e18,
                srcKey: _noKey(),
                srcKey2: _noKey()
            })
        );
        MockERC20 c3 = usd2();
        s.target = address(pair2);
        (PoolKey memory k3, PoolId p3) = hook.createPool{value: 0.05 ether}(
            DiscipleHook.CreateParams({
                coin: address(c3),
                quote: address(usd),
                fee: FEE,
                src: s,
                coinIn: 1000e18,
                quoteIn: 3000e18,
                srcKey: _noKey(),
                srcKey2: _noKey()
            })
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

        // an idle hour: the heartbeat is accepted but refunds nothing (no trades since the last price)
        vm.warp(vm.getBlockTimestamp() + 59 minutes + 30);
        uint256 tIdle = hook.poolState(p1).tank;
        vm.prank(address(k));
        pushSender.push{value: lzFee}(30101, to, r, 300_000);
        vm.warp(vm.getBlockTimestamp() + 30);
        local.deliver(address(receiver), HOME_EID, address(pushSender), home.lastMessage());
        assertEq(hook.poolState(p1).ageOrBlock, 30, "idle heartbeat accepted");
        assertEq(hook.poolState(p1).tank, tIdle, "idle heartbeat not refunded");

        // all three trade, then a heartbeat: each pool refunds only its quarter of the message cost (4 listings)
        _swap(k1, true, -int256(1e18));
        _swap(k2, true, -int256(1e18));
        _swap(k3, true, -int256(1e18));
        vm.warp(vm.getBlockTimestamp() + 59 minutes + 30);
        uint256 b0 = address(k).balance;
        uint256 t1 = hook.poolState(p1).tank;
        vm.prank(address(k));
        pushSender.push{value: lzFee}(30101, to, r, 300_000);
        vm.warp(vm.getBlockTimestamp() + 30);
        uint256 carried = _msgCost(home.lastMessage());
        local.deliver(address(receiver), HOME_EID, address(pushSender), home.lastMessage());
        uint256 each = (carried / 4 + (receiver.msgGas() / 4 + receiver.POOL_GAS()) * 1 gwei) * 12 / 10;
        assertEq(t1 - hook.poolState(p1).tank, each, "p1 pays one share (its wrong-source listing is ignored)");
        assertEq(address(k).balance, b0 - home.FEE() + 3 * each, "three accepted listings refunded");
        emit log_named_uint("home cost carried for 2 sources / 4 listings (wei at 1 gwei)", carried);
    }

    function test_lzPushDuplicatesTooManyAndTakeover() public {
        (PoolKey memory key, PoolId id) = _createPush(HOME_EID, 0.05 ether);
        _lzPush(id, address(0xC0FFEE), 40, HOME_EID);
        bytes32 to = bytes32(uint256(uint160(address(receiver))));

        // more than MAX_POOLS listings: refused at the sender, nothing sent
        DisciplePushSender.Req[] memory big = _req(address(pair), id);
        big[0].pools = new PoolId[](65);
        vm.expectRevert(DisciplePushSender.TooMany.selector);
        pushSender.push{value: 1 ether}(30101, to, big, 200_000);

        // a pool listed twice: the first listing is accepted and refunded, the duplicate is refused (not newer)
        // and refunds nothing, so the keeper recovers half the message cost
        _swap(key, true, -int256(1e18)); // traded, so the heartbeat is refundable
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
        uint256 each = (carried / 2 + (receiver.msgGas() / 2 + receiver.POOL_GAS()) * 1 gwei) * 12 / 10;
        assertEq(t0 - hook.poolState(id).tank, each, "one listing refunded");
        assertEq(address(k).balance, 1 ether - lzFee + each, "the sending keeper is paid, not the deliverer");
        assertEq(address(0xD311).balance, 0);
    }

    function test_lzReceiverAddOnlyOwner() public {
        (, PoolId id) = _createPush(HOME_EID, 0.05 ether);
        _lzPush(id, address(0xC0FFEE), 40, HOME_EID);
        uint256 a = hook.poolState(id).anchorX128;
        DisciplePushSender other = new DisciplePushSender(home, new LibConfig[](0), 125_000);

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
            DiscipleHook.CreateParams({
                coin: address(usd2()),
                quote: address(usd),
                fee: FEE,
                src: _pushSrc(30184),
                coinIn: 1000e18,
                quoteIn: 3000e18,
                srcKey: _noKey(),
                srcKey2: _noKey()
            })
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
        coin2.approve(address(swapper), type(uint256).max);
        return coin2;
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
