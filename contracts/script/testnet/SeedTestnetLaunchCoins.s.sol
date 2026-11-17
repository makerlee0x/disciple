// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {DevToken} from "../Deploy.s.sol";

interface ITnPricer {
    function owner() external view returns (address);
    function usdg() external view returns (address);
    function setAllowedQuote(address quote, bool allowed) external;
    function setPriceRoute(address quote, PoolKey[] calldata keys) external;
}

interface ITnRouter {
    function owner() external view returns (address);
    function usdg() external view returns (address);
    function setUsdgRoute(address quote, PoolKey[] calldata keys) external;
}

/// @notice Robinhood TESTNET 46630 only. Stand-ins for the launch-pair coins (+ HMM), made the same way as the
///         testnet STRATEGY: a `DevToken` from Deploy.s.sol and a pool seeded through PoolModifyLiquidityTest
///         (`_seedRefPool`). Route shapes follow mainnet (script/whitelist/WhitelistRoutes.sol); see
///         script/testnet/README.md for each difference. Simulates unless run with --broadcast.
/// @dev Writes deployments/testnet-launch-coins.json with every address and PoolKey.
contract SeedTestnetLaunchCoins is Script {
    using PoolIdLibrary for PoolKey;

    address constant PM = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant USDG = 0x9dC7A988a8707dC4AB7ac08fC2CB4D5bf906158D; // testnet USDG (DevToken, 6 dec)
    address constant PRICER = 0x5dD0F529C215C610f9498f4DaE0d7f36B49fd573;
    address constant ROUTER = 0xb8F4356759F7Bc1351f2D36037AD69ed82b8D839;
    address constant ETH = address(0);

    uint256 constant ERC20_POOL_USD = 250_000; // full range, per side (Deploy.s.sol's REF_POOL_USD pattern)
    uint256 constant ETH_POOL_USD = 20_000; // concentrated, per side (virtual), so little real ETH is needed
    uint256 constant ETH_USD = 1814e18;

    IPoolManager pm = IPoolManager(PM);
    PoolModifyLiquidityTest lp;
    address me;
    mapping(address => uint256) usdOf; // USD WAD per whole token
    string json = "out";

    struct Coin {
        string sym;
        string name;
        uint256 usd; // USD WAD per whole token (mainnet, Nov 16 2026)
        string mid; // "" = single hop on USDG, "ETH" = native ETH, else a stock stand-in symbol
        uint24 fee1;
        int24 ts1; // leg 1 (USDG/mid, or USDG/coin)
        uint24 fee2;
        int24 ts2; // leg 2 (mid/coin)
    }

    function _coins() internal pure returns (Coin[] memory c) {
        c = new Coin[](12);
        c[0] = Coin("AI", "AI (test)", 26_291e12, "NVDA", 3000, 60, 10_000, 8);
        c[1] = Coin("SCHIFFY", "SCHIFFY (test)", 1_529e12, "GLD", 3000, 10, 10_000, 8);
        c[2] = Coin("BONER", "BONER (test)", 2_906e12, "HIMS", 9000, 90, 10_000, 8);
        c[3] = Coin("MEME", "A Meme Coin (test)", 3_030e12, "AMC", 1000, 10, 10_000, 8);
        c[4] = Coin("MOO", "Memory cow Moo (test)", 676e12, "MU", 10_000, 200, 10_000, 8);
        c[5] = Coin("PONS", "Pons (test)", 121_100e12, "", 3000, 60, 0, 0);
        c[6] = Coin("ORBIO", "Orbio.so (test)", 19_650e12, "", 8000, 80, 0, 0);
        c[7] = Coin("HOOKR", "Hookr.fun (test)", 9_135e12, "ETH", 500, 10, 2500, 25);
        c[8] = Coin("CASHCAT", "Cash Cat (test)", 51_290e12, "", 2690, 54, 0, 0);
        c[9] = Coin("PRIORS", "Priors Agents (test)", 6_266e12, "", 0, 200, 0, 0);
        c[10] = Coin("PENGU", "Pudgy Penguins (test)", 4_914e12, "ETH", 500, 10, 10_000, 100);
        c[11] = Coin("HMM", "Thinking Cat (test)", 7_500e12, "", 34_267, 666, 0, 0);
    }

    function _key(address a, address b, uint24 fee, int24 ts) internal pure returns (PoolKey memory) {
        (address c0, address c1) = uint160(a) < uint160(b) ? (a, b) : (b, a);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, ts, IHooks(address(0)));
    }

    function _dec(address t) internal view returns (uint256) {
        return t == USDG ? 6 : 18;
    }

    /// @dev sqrtPriceX96 for c1 raw per c0 raw from USD prices.
    function _sqrtP(PoolKey memory k) internal view returns (uint160) {
        address c0 = Currency.unwrap(k.currency0);
        address c1 = Currency.unwrap(k.currency1);
        uint256 num = usdOf[c0] * 10 ** _dec(c1);
        uint256 den = usdOf[c1] * 10 ** _dec(c0);
        return uint160(Math.sqrt(Math.mulDiv(num, 1 << 192, den)));
    }

    /// @dev Liquidity whose virtual c0 side at `sqrtP` is worth `usd` dollars.
    function _liq(PoolKey memory k, uint160 sqrtP, uint256 usd) internal view returns (uint128) {
        address c0 = Currency.unwrap(k.currency0);
        return uint128(Math.mulDiv(usd * 10 ** _dec(c0) * 1e18, sqrtP, usdOf[c0] << 96));
    }

    function _floorTo(int24 t, int24 ts) internal pure returns (int24) {
        int24 q = t / ts;
        if (t < 0 && t % ts != 0) q -= 1;
        return q * ts;
    }

    /// @dev ERC-20 pair: full range, like Deploy.s.sol `_seedRefPool`.
    function _seedFull(PoolKey memory k) internal {
        uint160 sp = _sqrtP(k);
        pm.initialize(k, sp);
        lp.modifyLiquidity(
            k,
            IPoolManager.ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(k.tickSpacing),
                tickUpper: TickMath.maxUsableTick(k.tickSpacing),
                liquidityDelta: int256(uint256(_liq(k, sp, ERC20_POOL_USD))),
                salt: 0
            }),
            ""
        );
    }

    /// @dev Native-ETH pair (ETH is always currency0). One position from far below spot to just above it, so the
    ///      position is almost all currency1 (USDG or the mintable coin) and needs very little real ETH.
    ///      `upTicks` = how far spot sits below the top of the range (more = more ETH out for buys).
    function _seedEth(PoolKey memory k, int24 upTicks) internal returns (uint256 ethIn) {
        int24 target = TickMath.getTickAtSqrtPrice(_sqrtP(k));
        int24 upper = _floorTo(target, k.tickSpacing) + k.tickSpacing;
        while (upper - upTicks <= _floorTo(target, k.tickSpacing) - k.tickSpacing) upper += k.tickSpacing;
        int24 lower = upper - 400 * k.tickSpacing;
        uint160 sp = TickMath.getSqrtPriceAtTick(upper - upTicks);
        pm.initialize(k, sp);
        uint128 L = _liq(k, sp, ETH_POOL_USD);
        ethIn = SqrtPriceMath.getAmount0Delta(sp, TickMath.getSqrtPriceAtTick(upper), L, true) + 1e12;
        lp.modifyLiquidity{value: ethIn}(
            k,
            IPoolManager.ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: int256(uint256(L)), salt: 0}),
            ""
        );
    }

    function _one(PoolKey memory a) internal pure returns (PoolKey[] memory r) {
        r = new PoolKey[](1);
        r[0] = a;
    }

    function _two(PoolKey memory a, PoolKey memory b) internal pure returns (PoolKey[] memory r) {
        r = new PoolKey[](2);
        r[0] = a;
        r[1] = b;
    }

    function _wire(address quote, PoolKey[] memory keys) internal {
        ITnPricer(PRICER).setAllowedQuote(quote, true);
        ITnPricer(PRICER).setPriceRoute(quote, keys);
        ITnRouter(ROUTER).setUsdgRoute(quote, keys);
    }

    function _keyJson(string memory k, PoolKey memory key) internal returns (string memory) {
        string memory o = string.concat(json, k);
        vm.serializeAddress(o, "currency0", Currency.unwrap(key.currency0));
        vm.serializeAddress(o, "currency1", Currency.unwrap(key.currency1));
        vm.serializeUint(o, "fee", key.fee);
        vm.serializeInt(o, "tickSpacing", key.tickSpacing);
        vm.serializeAddress(o, "hooks", address(key.hooks));
        return vm.serializeBytes32(o, "poolId", PoolId.unwrap(key.toId()));
    }

    function run() external {
        require(block.chainid == 46630, "testnet 46630 only");
        require(ITnPricer(PRICER).usdg() == USDG && ITnRouter(ROUTER).usdg() == USDG, "usdg mismatch");
        me = msg.sender;
        require(ITnPricer(PRICER).owner() == me && ITnRouter(ROUTER).owner() == me, "sender is not the owner");
        usdOf[USDG] = 1e18;
        usdOf[ETH] = ETH_USD;

        string[5] memory mids = ["NVDA", "GLD", "HIMS", "AMC", "MU"];
        uint256[5] memory midUsd = [uint256(157_65e16), 354_09e16, 18_66e16, 3_23e16, 722_21e16];
        address[5] memory midAddr;
        uint256 ethUsed;

        vm.startBroadcast();
        lp = new PoolModifyLiquidityTest(pm);
        IERC20(USDG).approve(address(lp), type(uint256).max);
        DevToken(USDG).mint(me, 10_000_000e6);
        for (uint256 i; i < 5; ++i) {
            midAddr[i] = address(new DevToken(string.concat(mids[i], " (test)"), mids[i], 18, me, 1e27));
            usdOf[midAddr[i]] = midUsd[i];
            IERC20(midAddr[i]).approve(address(lp), type(uint256).max);
            _seedFull(_midLeg(i, midAddr[i]));
        }
        PoolKey memory usdgEth = _key(ETH, USDG, 500, 10);
        ethUsed += _seedEth(usdgEth, 20);

        Coin[] memory cs = _coins();
        string memory coinsOut;
        for (uint256 i; i < cs.length; ++i) {
            Coin memory c = cs[i];
            address t = address(new DevToken(c.name, c.sym, 18, me, 1e27));
            usdOf[t] = c.usd;
            IERC20(t).approve(address(lp), type(uint256).max);
            PoolKey[] memory keys;
            if (bytes(c.mid).length == 0) {
                PoolKey memory k = _key(USDG, t, c.fee1, c.ts1);
                _seedFull(k);
                keys = _one(k);
            } else if (keccak256(bytes(c.mid)) == keccak256("ETH")) {
                PoolKey memory k2 = _key(ETH, t, c.fee2, c.ts2);
                ethUsed += _seedEth(k2, 20);
                keys = _two(usdgEth, k2);
            } else {
                address m;
                for (uint256 j; j < 5; ++j) {
                    if (keccak256(bytes(mids[j])) == keccak256(bytes(c.mid))) m = midAddr[j];
                }
                PoolKey memory k2 = _key(m, t, c.fee2, c.ts2);
                _seedFull(k2);
                keys = _two(_midLegKey(c.mid, m, c.fee1, c.ts1), k2);
            }
            _wire(t, keys);
            string memory o = string.concat(json, c.sym);
            vm.serializeAddress(o, "address", t);
            vm.serializeString(o, "via", bytes(c.mid).length == 0 ? "USDG" : c.mid);
            vm.serializeString(o, "leg1", _keyJson(string.concat(c.sym, "l1"), keys[0]));
            string memory co = keys.length == 2
                ? vm.serializeString(o, "leg2", _keyJson(string.concat(c.sym, "l2"), keys[1]))
                : vm.serializeString(o, "leg2", "none");
            coinsOut = vm.serializeString("coins", c.sym, co);
            console2.log(c.sym, t, keys.length);
        }
        vm.stopBroadcast();

        string memory midsOut;
        for (uint256 i; i < 5; ++i) midsOut = vm.serializeAddress("mids", mids[i], midAddr[i]);
        vm.serializeAddress("root", "liquidityHelper", address(lp));
        vm.serializeString("root", "usdgEth", _keyJson("usdgEth", usdgEth));
        vm.serializeString("root", "mids", midsOut);
        vm.serializeUint("root", "ethSeeded", ethUsed);
        string memory root = vm.serializeString("root", "coins", coinsOut);
        if (vm.envOr("WRITE_OUT", false)) vm.writeJson(root, "./deployments/testnet-launch-coins.json");
        console2.log("ETH seeded into native-ETH pools (wei)", ethUsed);
    }

    // Leg-1 pools for the stock mids. Fee / tickSpacing per mainnet leg 1 (no hooks on testnet).
    uint24[5] midFee = [uint24(3000), 3000, 9000, 1000, 10_000];
    int24[5] midTs = [int24(60), 10, 90, 10, 200];

    function _midLeg(uint256 i, address m) internal view returns (PoolKey memory) {
        return _key(USDG, m, midFee[i], midTs[i]);
    }

    function _midLegKey(string memory, address m, uint24 fee, int24 ts) internal pure returns (PoolKey memory) {
        return _key(USDG, m, fee, ts);
    }
}
