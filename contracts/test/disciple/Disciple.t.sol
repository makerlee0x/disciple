// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {Disciple} from "../../src/disciple/Disciple.sol";
import {ILzRead} from "../../src/bridge/interfaces/ILzRead.sol";
import {MockERC20, MockLzRead} from "../bridge/mocks/BridgeMocks.sol";

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
    MockLzRead lz;
    address lp = address(0xA11CE);

    function setUp() public {
        vm.roll(100);
        vm.warp(1_000_000);
        manager = IPoolManager(address(new PoolManager(address(this))));
        usd = new MockERC20("USD", "USD", 18);
        coin = new MockERC20("COIN", "COIN", 18);
        lz = new MockLzRead();
        pair = new MockPair();
        // source: coin is token0 of the pair; price 2 quote per coin
        pair.set(1_000_000e18, 2_000_000e18);
        bytes memory args = abi.encode(manager, address(usd), ILzRead(address(lz)));
        bytes32 salt = _mine(args);
        hook = new Disciple{salt: salt}(manager, address(usd), ILzRead(address(lz)));
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
            Disciple.CreateParams({coin: address(coin), fee: FEE, src: _src(0), coinIn: coinIn, quoteIn: quoteIn})
        );
    }

    function _createCross(uint256 coinIn, uint256 quoteIn, uint256 eth)
        internal
        returns (PoolKey memory key, PoolId id)
    {
        (key, id) = hook.createPool{value: eth}(
            Disciple.CreateParams({coin: address(coin), fee: FEE, src: _src(30101), coinIn: coinIn, quoteIn: quoteIn})
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
