// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase, MockUSDG} from "./IntegrationBase.sol";
import {QuotePricer} from "../../src/QuotePricer.sol";
import {IQuoteProbe} from "../../src/interfaces/IQuoteProbe.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {DynamicFeeTakingHook} from "./UsdgRoute.t.sol";

/// @dev Honeypot: sells/transfers to the PoolManager revert unless the sender is exempt (the seeder).
contract RouteHoneypot is MockUSDG {
    address public immutable pm;
    mapping(address => bool) public exempt;

    constructor(address pm_, address seeder) {
        pm = pm_;
        exempt[seeder] = true;
    }

    function _update(address from, address to, uint256 v) internal override {
        if (from != address(0) && to == pm && !exempt[from]) revert("honeypot: no sells");
        super._update(from, to, v);
    }
}

contract QuotePricerWhitelistTest is IntegrationBase {
    MockUSDG internal mid;
    MockUSDG internal stock;
    PoolKey internal usdgMidKey;
    PoolKey internal midStockKey;

    function setUp() public override {
        super.setUp();
        mid = new MockUSDG();
        stock = new MockUSDG();
        usdgMidKey = _initRefPool(address(mid), address(quote), uint160(1) << 96);
        midStockKey = _initRefPool(address(mid), address(stock), uint160(1) << 96);
    }

    function _route() internal view returns (PoolKey[] memory keys) {
        keys = new PoolKey[](2);
        keys[0] = usdgMidKey;
        keys[1] = midStockKey;
    }

    function test_unlisted_quote_still_requires_price_pool() public {
        vm.expectRevert(abi.encodeWithSelector(QuotePricer.NoPricePool.selector, address(stock)));
        pricer.quotePriceUsd(address(stock));
    }

    function test_listed_two_hop_live_spot_no_warmup_and_floor() public {
        vm.startPrank(owner);
        pricer.setAllowedQuote(address(stock), true);
        pricer.setPriceRoute(address(stock), _route());
        vm.stopPrank();
        // both 1:1 18-dec pools, 100k ether L ⇒ well above $10k/side; price of 1e18 raw stock is $1
        assertEq(pricer.quotePriceUsd(address(stock)), 1e18);
        assertEq(pricer.spotPriceUsd(address(strategy)), 1e18); // unlisted path unchanged
    }

    function test_listed_thin_pool_reverts_no_route_above_floor() public {
        MockUSDG thin = new MockUSDG();
        // tiny L, 1:1 ⇒ virtual reserves ~1 ether = $1, under the $10k floor
        PoolKey memory thinKey = _initThinPool(address(thin), address(quote), uint160(1) << 96, 1 ether);
        vm.startPrank(owner);
        pricer.setAllowedQuote(address(thin), true);
        PoolKey[] memory keys = new PoolKey[](1);
        keys[0] = thinKey;
        pricer.setPriceRoute(address(thin), keys);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(QuotePricer.NoRouteAboveFloor.selector, address(thin)));
        pricer.quotePriceUsd(address(thin));
    }

    function test_floor_ignores_fee_flag() public {
        uint160 flags = uint160(
            Hooks.AFTER_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        bytes memory ctorArgs = abi.encode(manager, uint24(7000));
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), flags, type(DynamicFeeTakingHook).creationCode, ctorArgs);
        DynamicFeeTakingHook feeHook = new DynamicFeeTakingHook{salt: salt}(manager, 7000);
        require(address(feeHook) == hookAddr, "hook addr");

        MockUSDG dyn = new MockUSDG();
        PoolKey memory dynKey = _initHookedDeep(address(dyn), address(quote), IHooks(address(feeHook)));
        vm.startPrank(owner);
        pricer.setAllowedQuote(address(dyn), true);
        PoolKey[] memory keys = new PoolKey[](1);
        keys[0] = dynKey;
        pricer.setPriceRoute(address(dyn), keys);
        vm.stopPrank();
        // same L as the hookless STRATEGY/USDG ref pool; fee is 0x800000, floor still passes
        assertEq(dynKey.fee, LPFeeLibrary.DYNAMIC_FEE_FLAG);
        assertEq(pricer.quotePriceUsd(address(dyn)), 1e18);
    }

    function test_allowAnyQuote_default_off() public {
        assertFalse(pricer.allowAnyQuote());
    }

    function test_probe_two_hop_rejects_honeypot_without_direct_usdg_pool() public {
        RouteHoneypot pot = new RouteHoneypot(address(manager), address(this));
        PoolKey memory midPot = _initRefPool(address(mid), address(pot), uint160(1) << 96);
        PoolKey[] memory keys = new PoolKey[](2);
        keys[0] = usdgMidKey;
        keys[1] = midPot;
        vm.startPrank(owner);
        pricer.setAllowedQuote(address(pot), true);
        pricer.setPriceRoute(address(pot), keys);
        vm.stopPrank();
        (IQuoteProbe.ProbeResult res, string memory why) = quoteProbe.probe(address(pot));
        assertEq(uint8(res), uint8(IQuoteProbe.ProbeResult.RejectHoneypot), why);
    }

    function test_probe_two_hop_passes_honest_quote_without_direct_usdg_pool() public {
        vm.startPrank(owner);
        pricer.setAllowedQuote(address(stock), true);
        pricer.setPriceRoute(address(stock), _route());
        vm.stopPrank();
        (IQuoteProbe.ProbeResult res,) = quoteProbe.probe(address(stock));
        assertEq(uint8(res), uint8(IQuoteProbe.ProbeResult.Pass));
    }

    function _initThinPool(address a, address b, uint160 sqrtP, int256 liq)
        internal
        returns (PoolKey memory key)
    {
        (address c0, address c1) = uint160(a) < uint160(b) ? (a, b) : (b, a);
        key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        manager.initialize(key, sqrtP);
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(manager);
        MockUSDG(a).mint(address(this), 1e30);
        MockUSDG(b).mint(address(this), 1e30);
        IERC20(a).approve(address(lp), type(uint256).max);
        IERC20(b).approve(address(lp), type(uint256).max);
        lp.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({tickLower: -887220, tickUpper: 887220, liquidityDelta: liq, salt: 0}),
            ""
        );
    }

    function _initHookedDeep(address a, address b, IHooks hooks) internal returns (PoolKey memory key) {
        (address c0, address c1) = uint160(a) < uint160(b) ? (a, b) : (b, a);
        key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 8,
            hooks: hooks
        });
        manager.initialize(key, uint160(1) << 96);
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(manager);
        MockUSDG(a).mint(address(this), 1e30);
        MockUSDG(b).mint(address(this), 1e30);
        IERC20(a).approve(address(lp), type(uint256).max);
        IERC20(b).approve(address(lp), type(uint256).max);
        lp.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: -887256, tickUpper: 887256, liquidityDelta: 100_000 ether, salt: 0
            }),
            ""
        );
    }
}
