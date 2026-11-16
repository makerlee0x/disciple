// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {DiscipleRouter} from "../../src/DiscipleRouter.sol";
import {QuotePricer} from "../../src/QuotePricer.sol";
import {QuoteProbe} from "../../src/QuoteProbe.sol";
import {IQuoteProbe} from "../../src/interfaces/IQuoteProbe.sol";
import {LockedLP} from "../../src/LockedLP.sol";
import {PoolDepth} from "../../src/libraries/PoolDepth.sol";
import {WhitelistRoutes} from "../../script/whitelist/WhitelistRoutes.sol";

/// @notice Mainnet-fork check of every launch-pair USDG route (12 launch pairs + the optional ETH/WETH pair) from
///         script/whitelist/WhitelistRoutes.sol, the same rows the wiring script sends. No broadcast.
///         Public Robinhood RPC, eth_call / forked simulation only. Buys $100 and $1,000 through each route.
contract WhitelistRoutesForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using stdJson for string;

    string internal constant MAINNET_RPC = "https://rpc.mainnet.chain.robinhood.com";
    address internal constant USDG = WhitelistRoutes.USDG;
    uint256 internal constant PROBE_USDG = 1e6; // $1 of 6-dec USDG

    IPoolManager internal pm;
    DiscipleRouter internal router;
    QuotePricer internal pricer;
    QuoteProbe internal probe;
    address internal trader;
    uint256 internal failures;

    function setUp() public {
        vm.createSelectFork(MAINNET_RPC);
        assertEq(block.chainid, 4663, "not robinhood mainnet");
        pm = IPoolManager(WhitelistRoutes.POOL_MANAGER);
        trader = makeAddr("trader");
        LockedLP lp = new LockedLP(address(this), address(this), address(0));
        // hook = address(0): UsdgRouteLib only rejects the DISCIPLE hook; these hops use other hooks.
        router = new DiscipleRouter(pm, lp, address(0));
        router.setUsdgRouting(USDG, address(1));
        pricer = new QuotePricer(address(this), pm, USDG);
        probe = new QuoteProbe(address(this), pm, USDG, address(pricer), PROBE_USDG);
    }

    function _fundUsdg(address to, uint256 amount) internal {
        (bool minted,) = USDG.call(abi.encodeWithSignature("mint(address,uint256)", to, amount));
        if (minted && IERC20(USDG).balanceOf(to) >= amount) return;
        deal(USDG, to, amount);
        require(IERC20(USDG).balanceOf(to) >= amount, "could not fund USDG on fork");
    }

    function _fail(string memory sym, string memory why) internal {
        failures += 1;
        console2.log("FAIL", sym, why);
    }

    function _buy(WhitelistRoutes.Route memory r, uint256 usdgIn) internal returns (bool) {
        address quote = r.quote;
        try router.quoteUsdgQuoteSwap(quote, true, usdgIn) returns (uint256 quoted, uint256 impactBps) {
            console2.log("usdg in", usdgIn);
            console2.log("quoted wei", quoted);
            console2.log("router max hop impact bps", impactBps);
            if (quoted == 0) {
                _fail(r.symbol, "quoteUsdgQuoteSwap returned 0");
                return false;
            }
            vm.prank(trader);
            vm.expectRevert(DiscipleRouter.Slippage.selector);
            router.swapUsdgToQuote(quote, usdgIn, quoted + 1, trader, block.timestamp + 1 hours);

            uint256 t0 = IERC20(quote).balanceOf(trader);
            uint256 u0 = IERC20(USDG).balanceOf(trader);
            vm.prank(trader);
            uint256 g = gasleft();
            uint256 out = router.swapUsdgToQuote(quote, usdgIn, quoted, trader, block.timestamp + 1 hours);
            console2.log("router gas", g - gasleft());
            if (out != quoted) {
                _fail(r.symbol, "executed output != quoted (min-out on real final)");
                return false;
            }
            if (IERC20(quote).balanceOf(trader) - t0 != out) {
                _fail(r.symbol, "trader did not receive quote out");
                return false;
            }
            if (u0 - IERC20(USDG).balanceOf(trader) != usdgIn) {
                _fail(r.symbol, "USDG spent mismatch");
                return false;
            }
            if (IERC20(USDG).balanceOf(address(router)) != 0 || IERC20(quote).balanceOf(address(router)) != 0) {
                _fail(r.symbol, "router dust after buy");
                return false;
            }
            if (r.keys.length == 2) {
                PoolKey memory k = r.keys[0];
                address mid = address(Currency.unwrap(k.currency0)) == USDG
                    ? Currency.unwrap(k.currency1)
                    : Currency.unwrap(k.currency0);
                uint256 dust = mid == address(0) ? address(router).balance : IERC20(mid).balanceOf(address(router));
                if (dust != 0) {
                    _fail(r.symbol, "mid dust after buy");
                    return false;
                }
            }
            return true;
        } catch {
            _fail(r.symbol, "quoteUsdgQuoteSwap or swap reverted");
            return false;
        }
    }

    function _checkRoute(WhitelistRoutes.Route memory r) internal {
        console2.log("====", r.symbol, r.listed ? "listed" : "optional (not listed)");
        for (uint256 i; i < r.keys.length; ++i) {
            if (PoolId.unwrap(r.keys[i].toId()) != r.poolIds[i]) {
                _fail(r.symbol, "pool id mismatch");
                return;
            }
            (uint160 sp,,,) = pm.getSlot0(r.keys[i].toId());
            if (sp == 0) {
                _fail(r.symbol, "pool not initialized");
                return;
            }
            (uint256 v0, uint256 v1) = PoolDepth.virtualReserves(pm, r.keys[i]);
            console2.log("leg", i + 1);
            console2.log("  liquidity", uint256(pm.getLiquidity(r.keys[i].toId())));
            console2.log("  virtual reserve0", v0);
            console2.log("  virtual reserve1", v1);
            if (v0 == 0 || v1 == 0) {
                _fail(r.symbol, "empty virtual reserves");
                return;
            }
        }

        // Same calls, same order, as script/whitelist/WireWhitelistRoutes.s.sol.
        if (r.listed) pricer.setAllowedQuote(r.quote, true);
        pricer.setPriceRoute(r.quote, r.keys);
        router.setUsdgRoute(r.quote, r.keys);

        if (r.listed) {
            try pricer.quotePriceUsd(r.quote) returns (uint256 px) {
                console2.log("quotePriceUsd wad", px);
                if (px == 0) {
                    _fail(r.symbol, "quotePriceUsd returned 0");
                    return;
                }
            } catch {
                _fail(r.symbol, "quotePriceUsd reverted (floor or no route)");
                return;
            }
            (IQuoteProbe.ProbeResult pres, string memory detail) = probe.probe(r.quote);
            console2.log("probe detail", detail);
            if (pres != IQuoteProbe.ProbeResult.Pass) {
                _fail(r.symbol, string.concat("probe did not pass: ", detail));
                return;
            }
        } else {
            // Optional pair stays off: not listed, so launches with it revert QuoteNotListed until the owner lists it.
            if (pricer.isAllowedQuote(r.quote)) _fail(r.symbol, "optional pair should not be listed");
        }

        _fundUsdg(trader, 2_000e6);
        vm.prank(trader);
        IERC20(USDG).approve(address(router), type(uint256).max);
        if (!_buy(r, 100e6)) return;
        if (!_buy(r, 1_000e6)) return;
        console2.log("PASS", r.symbol);
    }

    function test_all_whitelist_routes_buy_floor_probe() public {
        WhitelistRoutes.Route[] memory rs = WhitelistRoutes.all();
        for (uint256 i; i < rs.length; ++i) {
            _checkRoute(rs[i]);
        }
        console2.log("failure count", failures);
        assertEq(failures, 0, "one or more launch-pair routes failed the floor, probe, or buy; see logs");
    }

    /// @dev routes.json and the Solidity table must list the same pool ids in the same order.
    function test_routes_json_matches_library() public view {
        string memory j = vm.readFile(string.concat(vm.projectRoot(), "/script/whitelist/routes.json"));
        WhitelistRoutes.Route[] memory rs = WhitelistRoutes.all();
        uint256 nListed;
        uint256 nOptional;
        for (uint256 i; i < rs.length; ++i) {
            string memory base;
            if (rs[i].listed) {
                base = string.concat(".quotes[", vm.toString(nListed++), "]");
            } else {
                base = string.concat(".optionalQuotes[", vm.toString(nOptional++), "]");
            }
            assertEq(j.readAddress(string.concat(base, ".address")), rs[i].quote, rs[i].symbol);
            for (uint256 k; k < rs[i].poolIds.length; ++k) {
                bytes32 id = j.readBytes32(string.concat(base, ".keys[", vm.toString(k), "].poolId"));
                assertEq(id, rs[i].poolIds[k], rs[i].symbol);
            }
        }
    }
}
