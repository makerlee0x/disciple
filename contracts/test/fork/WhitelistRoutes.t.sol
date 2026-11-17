// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {DiscipleRouter} from "../../src/DiscipleRouter.sol";
import {QuotePricer} from "../../src/QuotePricer.sol";
import {QuoteProbe} from "../../src/QuoteProbe.sol";
import {IQuoteProbe} from "../../src/interfaces/IQuoteProbe.sol";
import {LockedLP} from "../../src/LockedLP.sol";
import {PoolDepth} from "../../src/libraries/PoolDepth.sol";

/// @notice Mainnet-fork check of all 12 launch-whitelist USDG routes. No broadcast.
///         Public Robinhood RPC, eth_call / forked simulation only.
contract WhitelistRoutesForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    string internal constant MAINNET_RPC = "https://rpc.mainnet.chain.robinhood.com";

    address internal constant PM = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant LONG_HOOK = 0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544;
    address internal constant SESSION_FEE_HOOK = 0xC15b155a3094934171A15625d1a80Aba267B6080;
    address internal constant GLD_USDG_HOOK = 0xB608a78761f179f7C56f15E7D13921B92F00a080;
    address internal constant PONS_USDG_HOOK = 0x08E52564Bad99E05a694b4809F397edcA417A080;
    address internal constant PRIORS_USDG_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;

    address internal constant STRATEGY = 0x168661C52E5922288dFb2b3f323b6Cf90eb21e18;
    address internal constant AI = 0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18;
    address internal constant SCHIFFY = 0x42aFA2124ca5a2B83898E46B2dA9a190995b1E18;
    address internal constant BONER = 0x98096d17e191B3dA1d5f99a6D7b3584351b11E18;
    address internal constant MEME = 0x385F4f8ae47651ce5F58F5265395a669f8281e18;
    address internal constant PONS = 0x39dBED3a2bd333467115dE45665cC57F813C4571;
    address internal constant ORBIO = 0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3;
    address internal constant HOOKR = 0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c;
    address internal constant CASHCAT = 0x020bfC650A365f8BB26819deAAbF3E21291018b4;
    address internal constant PRIORS = 0xeDBf91223639800BCd5756815CAf908Df3b890bE;
    address internal constant PENGU = 0x74BE72AFFAFbC8de30F0C11247814036314D625f;
    address internal constant DELTA = 0xe8ffd7e24187F72afB08d75B1bb13088A989a791;
    /// @dev Native ETH (v4 currency 0) and the deepest UNHOOKED ETH/USDG pool (0.05%, id 0x387bf619…, ~$5.1M per side,
    ///      read 2026-11-16 at block ~116.26M). Deeper ETH/USDG pools exist but are hooked and not vetted.
    address internal constant ETH = address(0);

    address internal constant MSTR = 0xec262a75e413fAfD0dF80480274532C79D42da09;
    address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address internal constant GLD = 0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e;
    address internal constant HIMS = 0xCceE82fE024c36fA15E1005edE3E9e4787e23D09;
    address internal constant AMC = 0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B;

    uint256 internal constant USDG_IN = 100 * 1e6;
    uint256 internal constant FLOOR = 10_000e18;
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
        pm = IPoolManager(PM);
        trader = makeAddr("trader");
        LockedLP lp = new LockedLP(address(this), address(this), address(0));
        // hook = address(0): UsdgRouteLib only rejects the DISCIPLE hook; these hops use other hooks.
        router = new DiscipleRouter(pm, lp, address(0));
        router.setUsdgRouting(USDG, address(1));
        pricer = new QuotePricer(address(this), pm, USDG);
        probe = new QuoteProbe(address(this), pm, USDG, address(pricer), PROBE_USDG);
    }

    function _pk(address c0, address c1, uint24 fee, int24 ts, address hooks) internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: fee,
            tickSpacing: ts,
            hooks: IHooks(hooks)
        });
    }

    function _one(PoolKey memory a) internal pure returns (PoolKey[] memory keys) {
        keys = new PoolKey[](1);
        keys[0] = a;
    }

    function _two(PoolKey memory a, PoolKey memory b) internal pure returns (PoolKey[] memory keys) {
        keys = new PoolKey[](2);
        keys[0] = a;
        keys[1] = b;
    }

    bytes32 internal constant ETH_USDG_ID = 0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982;

    function _routeOf(address quote) internal pure returns (PoolKey[] memory keys, address mid, bytes32 id0, bytes32 id1) {
        uint24 dyn = LPFeeLibrary.DYNAMIC_FEE_FLAG;
        if (quote == STRATEGY) {
            keys = _two(_pk(USDG, MSTR, 2500, 25, address(0)), _pk(STRATEGY, MSTR, dyn, 8, LONG_HOOK));
            mid = MSTR;
            id0 = 0x319bac87e616a89e241c10aeb8afd4892a852cdd8b373cd9765ecddc40b87cfe;
            id1 = 0xa6975f4720a95aa9cdfa9b010a065b0e941534c93f9fa708104c08f0ac029ca0;
        } else if (quote == AI) {
            keys = _two(_pk(USDG, NVDA, 3000, 60, address(0)), _pk(AI, NVDA, dyn, 8, LONG_HOOK));
            mid = NVDA;
            id0 = 0x3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1;
            id1 = 0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27;
        } else if (quote == SCHIFFY) {
            keys = _two(_pk(USDG, GLD, dyn, 10, GLD_USDG_HOOK), _pk(SCHIFFY, GLD, dyn, 8, LONG_HOOK));
            mid = GLD;
            id0 = 0xfe281bbfa9aa658c1aa9c2ad1b0c62c4286f96c7cb1074296b54e869935a7a3a;
            id1 = 0xc749412e31087a6e6f9210af575bc9100159fbc9f45da3ca8b26b31f3bf5777e;
        } else if (quote == BONER) {
            keys = _two(_pk(USDG, HIMS, 9000, 90, address(0)), _pk(BONER, HIMS, dyn, 8, LONG_HOOK));
            mid = HIMS;
            id0 = 0x68d4f28f1432e0ad714658853edb2e6b0b1ac4060355ff3d169fea656b1d1c52;
            id1 = 0x9c89b04303dfa76f3f6fb02c2b77be0e8a00ab8fa00d507119acd54ab3e8640d;
        } else if (quote == MEME) {
            keys = _two(_pk(AMC, USDG, 1000, 10, address(0)), _pk(AMC, MEME, dyn, 8, LONG_HOOK));
            mid = AMC;
            id0 = 0x7499938c352d5b5b8f0c648722aca5ee964ef9b85c3a3041f1ec379726291d9d;
            id1 = 0x27ccf0a6d1ee74840220715bcca7d3b01e0d33aa30d0259b47ae1585b3f4c071;
        } else if (quote == PENGU) {
            keys = _two(_pk(ETH, USDG, 500, 10, address(0)), _pk(ETH, PENGU, 10_000, 100, address(0)));
            id0 = ETH_USDG_ID;
            id1 = 0x38cbd4b134c801b6d534600ccf5c59ff06e5e5058f108ddef85aa66c15ffb086;
        } else if (quote == DELTA) {
            // single unhooked USDG/DELTA 1.99% (replaced HMM, maker 2026-11-17); thin: ~$39K TVL on Nov 17
            keys = _one(_pk(USDG, DELTA, 19_900, 199, address(0)));
            id0 = 0xebd2fbb46948c5b21ca32dcd0be5ae851fed99362cfcf198d060a63a8689cd66;
        } else if (quote == PONS) {
            keys = _one(_pk(PONS, USDG, dyn, 60, PONS_USDG_HOOK));
            id0 = 0x486435a1f76cd58193f854c6e6213cd05fd58d637865d02065ff558b387fa6ea;
        } else if (quote == ORBIO) {
            keys = _one(_pk(USDG, ORBIO, 8000, 80, address(0)));
            id0 = 0xea9f200e13055b82f175f44f592c4c13dd8c9d9320a66487d3c5cd90d68550ef;
        } else if (quote == HOOKR) {
            // HOOKR/ETH 0.25% (~$366k per side) is ~10x the old 1% USDG pool 0x0b362d89…
            keys = _two(_pk(ETH, USDG, 500, 10, address(0)), _pk(ETH, HOOKR, 2500, 25, address(0)));
            id0 = ETH_USDG_ID;
            id1 = 0x590dcb6a87828bf688b48089a62239b693378f1fb64d2286e6a399ed8c005fdf;
        } else if (quote == CASHCAT) {
            keys = _one(_pk(CASHCAT, USDG, 2690, 54, address(0)));
            id0 = 0xa92a3df27a00a276183ff7265fd8affa11df1fe8bb23ddfaf13f6c879a3f818b;
        } else if (quote == PRIORS) {
            keys = _one(_pk(USDG, PRIORS, 0, 200, PRIORS_USDG_HOOK));
            id0 = 0xff7b3bd2db34d9ed8160e6dedf1d448777abaa1fa6fc8a31144930a1a656fd92;
        } else {
            revert("unknown quote");
        }
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

    function _checkCoin(string memory sym, address quote) internal {
        console2.log("====", sym);
        (PoolKey[] memory keys, address mid, bytes32 id0, bytes32 id1) = _routeOf(quote);
        if (PoolId.unwrap(keys[0].toId()) != id0) {
            _fail(sym, "leg1 pool id mismatch");
            return;
        }
        if (keys.length == 2 && PoolId.unwrap(keys[1].toId()) != id1) {
            _fail(sym, "leg2 pool id mismatch");
            return;
        }
        (uint160 sp0,,,) = pm.getSlot0(keys[0].toId());
        if (sp0 == 0) {
            _fail(sym, "leg1 not initialized");
            return;
        }
        if (keys.length == 2) {
            (uint160 sp1,,,) = pm.getSlot0(keys[1].toId());
            if (sp1 == 0) {
                _fail(sym, "leg2 not initialized");
                return;
            }
        }

        router.setUsdgRoute(quote, keys);
        pricer.setAllowedQuote(quote, true);
        pricer.setPriceRoute(quote, keys);

        // Per-side virtual reserves (official floor uses USD; zeros here still catch an empty pool).
        (uint256 r00, uint256 r01) = PoolDepth.virtualReserves(pm, keys[0]);
        console2.log("leg1 virtual reserve0", r00);
        console2.log("leg1 virtual reserve1", r01);
        if (r00 == 0 || r01 == 0) {
            _fail(sym, "leg1 empty virtual reserves");
            return;
        }
        if (keys.length == 2) {
            (uint256 r10, uint256 r11) = PoolDepth.virtualReserves(pm, keys[1]);
            console2.log("leg2 virtual reserve0", r10);
            console2.log("leg2 virtual reserve1", r11);
            if (r10 == 0 || r11 == 0) {
                _fail(sym, "leg2 empty virtual reserves");
                return;
            }
        }

        try pricer.quotePriceUsd(quote) returns (uint256 px) {
            console2.log("quotePriceUsd wad", px);
            if (px == 0) {
                _fail(sym, "quotePriceUsd returned 0");
                return;
            }
        } catch {
            _fail(sym, "quotePriceUsd reverted (floor or no route)");
            return;
        }

        (IQuoteProbe.ProbeResult pres, string memory detail) = probe.probe(quote);
        console2.log("probe detail", detail);
        if (pres != IQuoteProbe.ProbeResult.Pass) {
            _fail(sym, string.concat("probe did not pass: ", detail));
            return;
        }

        _fundUsdg(trader, USDG_IN * 2);
        vm.prank(trader);
        IERC20(USDG).approve(address(router), type(uint256).max);

        try router.quoteUsdgQuoteSwap(quote, true, USDG_IN) returns (uint256 quoted, uint256) {
            console2.log("quoted wei", quoted);
            if (quoted == 0) {
                _fail(sym, "quoteUsdgQuoteSwap returned 0");
                return;
            }
            vm.prank(trader);
            vm.expectRevert(DiscipleRouter.Slippage.selector);
            router.swapUsdgToQuote(quote, USDG_IN, quoted + 1, trader, block.timestamp + 1 hours);

            uint256 t0 = IERC20(quote).balanceOf(trader);
            uint256 u0 = IERC20(USDG).balanceOf(trader);
            vm.prank(trader);
            uint256 g = gasleft();
            uint256 out = router.swapUsdgToQuote(quote, USDG_IN, quoted, trader, block.timestamp + 1 hours);
            uint256 gasFirst = g - gasleft();
            if (out != quoted) {
                _fail(sym, "executed output != quoted (min-out on real final)");
                return;
            }
            if (IERC20(quote).balanceOf(trader) - t0 != out) {
                _fail(sym, "trader did not receive quote out");
                return;
            }
            if (u0 - IERC20(USDG).balanceOf(trader) != USDG_IN) {
                _fail(sym, "USDG spent mismatch");
                return;
            }
            if (IERC20(USDG).balanceOf(address(router)) != 0 || IERC20(quote).balanceOf(address(router)) != 0) {
                _fail(sym, "router dust after buy");
                return;
            }
            if (address(router).balance != 0) {
                _fail(sym, "ETH dust after buy");
                return;
            }
            if (mid != address(0) && IERC20(mid).balanceOf(address(router)) != 0) {
                _fail(sym, "mid dust after buy");
                return;
            }
            console2.log("quote out wei", out);
            console2.log("router gas first", gasFirst);

            (uint256 quoted2,) = router.quoteUsdgQuoteSwap(quote, true, USDG_IN);
            vm.prank(trader);
            g = gasleft();
            uint256 out2 = router.swapUsdgToQuote(quote, USDG_IN, quoted2, trader, block.timestamp + 1 hours);
            uint256 gasWarm = g - gasleft();
            if (out2 != quoted2) {
                _fail(sym, "warm executed output != quoted");
                return;
            }
            console2.log("router gas warm", gasWarm);
            console2.log("PASS", sym);
        } catch {
            _fail(sym, "quoteUsdgQuoteSwap or swap reverted");
        }
    }

    function test_all_whitelist_routes_buy_floor_probe() public {
        _checkCoin("STRATEGY", STRATEGY);
        _checkCoin("AI", AI);
        _checkCoin("SCHIFFY", SCHIFFY);
        _checkCoin("BONER", BONER);
        _checkCoin("MEME", MEME);
        _checkCoin("PONS", PONS);
        _checkCoin("ORBIO", ORBIO);
        _checkCoin("HOOKR", HOOKR);
        _checkCoin("CASHCAT", CASHCAT);
        _checkCoin("PRIORS", PRIORS);
        _checkCoin("PENGU", PENGU);
        _checkCoin("DELTA", DELTA);
        console2.log("failure count", failures);
        assertEq(failures, 0, "one or more whitelist routes failed the floor, probe, or $100 buy; see logs, routes were not silently changed");
    }
}
