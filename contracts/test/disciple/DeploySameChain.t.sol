// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {_noKey} from "./NoKey.sol";
import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {Disciple} from "../../src/disciple/Disciple.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {DeploySameChain} from "../../script/disciple/DeploySameChain.s.sol";
import {MockPair, MockV2Factory} from "./Disciple.t.sol";

/// @notice Runs the same-chain deploy script on a local PoolManager, then uses the hook: a same-chain pool works,
///         every cross-chain route and any ETH are refused.
contract DeploySameChainTest is Test {
    address internal constant ARACHNID = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    IPoolManager manager;
    MockERC20 usdg;
    MockERC20 coin;
    MockPair pair;
    MockV2Factory v2f;
    DeploySameChain script;

    function setUp() public {
        vm.roll(100);
        vm.warp(1_000_000);
        manager = IPoolManager(address(new PoolManager(address(this))));
        usdg = new MockERC20("USDG", "USDG", 6);
        coin = new MockERC20("COIN", "COIN", 18);
        pair = new MockPair();
        pair.set(1_000_000e18, 2_000_000e18); // coin is token0; 2 quote per coin
        pair.setTokens(address(coin), address(usdg));
        v2f = new MockV2Factory();
        v2f.add(address(pair));
        vm.setEnv("POOL_MANAGER", vm.toString(address(manager)));
        vm.setEnv("QUOTE", vm.toString(address(usdg)));
        vm.setEnv("V2_FACTORY", vm.toString(address(v2f)));
        vm.setEnv("V3_FACTORY", vm.toString(address(0)));
        script = new DeploySameChain();
    }

    function test_deploysViaArachnidProxy() public {
        assertGt(ARACHNID.code.length, 0, "test env has the proxy");
        Disciple hook = script.run();
        script.check(hook, script.config());
        _use(hook);
    }

    function test_deploysViaHelperWithoutProxy() public {
        vm.etch(ARACHNID, "");
        Disciple hook = script.run();
        script.check(hook, script.config());
        _use(hook);
    }

    function test_chainDefaults() public view {
        DeploySameChain.Config memory c = script.defaults(1);
        assertEq(c.pm, 0x000000000004444c5dc75cB358380D2e3dE08A90);
        assertEq(c.quote, 0xe343167631d89B6Ffc58B88d6b7fB0228795491D); // USDG
        assertEq(c.v2Factory, 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f);
        assertEq(c.v3Factory, 0x1F98431c8aD98523631AE4a59f267346ea31F984);
        c = script.defaults(4663);
        assertEq(c.pm, 0x8366a39CC670B4001A1121B8F6A443A643e40951);
        assertEq(c.quote, 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168); // USDG
        assertEq(c.v2Factory, address(0));
        c = script.defaults(31337);
        assertEq(c.pm, address(0));
    }

    function _use(Disciple hook) internal {
        usdg.mint(address(this), 1e24);
        coin.mint(address(this), 1e24);
        usdg.approve(address(hook), type(uint256).max);
        coin.approve(address(hook), type(uint256).max);

        Disciple.Source memory s;
        s.kind = 1;
        s.coinIs0 = true;
        s.v2Fee = 3000;
        s.target = address(pair);
        Disciple.CreateParams memory cp =
            Disciple.CreateParams({coin: address(coin), fee: 10_000, src: s, coinIn: 100e18, quoteIn: 200e18, srcKey: _noKey()});

        // cross chain is off on this deployment, every route
        // memory structs alias: build a separate one for the cross-chain probes
        Disciple.Source memory xs = Disciple.Source(s.kind, s.coinIs0, s.v2Fee, 30101, s.target, s.v4Id, s.decShift, true);
        Disciple.CreateParams memory x =
            Disciple.CreateParams({coin: address(coin), fee: 10_000, src: xs, coinIn: 100e18, quoteIn: 200e18, srcKey: _noKey()});
        vm.expectRevert(Disciple.BadParams.selector); // push pool, but no receiver on this deployment
        hook.createPool{value: 1 ether}(x);
        x.src.push = false;
        vm.expectRevert(Disciple.BadParams.selector); // a remote pool that is not push
        hook.createPool(x);
        // no ETH on a same-chain pool
        vm.deal(address(this), 1 ether);
        vm.expectRevert(Disciple.SameChain.selector);
        hook.createPool{value: 1}(cp);

        (PoolKey memory key, PoolId id) = hook.createPool(cp);
        assertTrue(hook.poolState(id).live);

        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 60);
        PoolSwapTest swapper = new PoolSwapTest(manager);
        usdg.approve(address(swapper), type(uint256).max);
        coin.approve(address(swapper), type(uint256).max);
        bool coinIs0 = Currency.unwrap(key.currency0) == address(coin);
        uint256 before = coin.balanceOf(address(this));
        swapper.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: !coinIs0,
                amountSpecified: -1e18,
                sqrtPriceLimitX96: !coinIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        assertGt(coin.balanceOf(address(this)), before, "buy filled");
    }
}
