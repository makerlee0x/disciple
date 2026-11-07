// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {DiscipleHook} from "../../src/hook/DiscipleHook.sol";

/// @title Same-chain-only DiscipleHook on Robinhood Chain (internal mainnet test, maker 2026-11-05)
/// @notice The hook is deployed with NO push receiver, so it takes same-chain pools only and is not tied to any
///   cross-chain sender. Cross-chain pools go on a later hook deployed with the final receiver.
///   hook():  deploys the hook via the CREATE2 deployer.
///   pool():  HOOK=<hook> COIN_IN=<raw STRATEGY> QUOTE_IN=<raw USDG> FEE=<pips, default 5000 = 0.5%>
///            creates STRATEGY/USDG priced through STRATEGY/MSTR (v4) and MSTR/USDG (v4 0.25%).
///   both():  hook() then pool() in one run (for a dry run on a fork).
contract DeploySameChainRH is Script {
    using PoolIdLibrary for PoolKey;

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    IPoolManager internal constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant STRATEGY = 0x168661C52E5922288dFb2b3f323b6Cf90eb21e18;
    address internal constant MSTR = 0xec262a75e413fAfD0dF80480274532C79D42da09;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant LEG1_HOOK = 0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544;

    function hook() public returns (DiscipleHook h) {
        require(block.chainid == 4663, "run on Robinhood Chain");
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
        );
        DiscipleHook.Config memory cfg = _cfg();
        bytes memory args = abi.encode(PM, address(0), address(0), address(0), WETH, cfg);
        (address want, bytes32 salt) = HookMiner.find(CREATE2_DEPLOYER, flags, type(DiscipleHook).creationCode, args);
        vm.startBroadcast();
        h = new DiscipleHook{salt: salt}(PM, address(0), address(0), address(0), WETH, cfg);
        vm.stopBroadcast();
        require(address(h) == want, "hook address");
        require(address(h).code.length <= 24_576, "over EIP-170");
        console2.log("DiscipleHook (Robinhood, same chain only)", address(h));
    }

    /// @dev The Uniswap v4 ETH/USDG pool on Robinhood (maker, 2026-11-07). ETH (native or WETH) sorts below USDG,
    ///      so it is currency0.
    bytes32 internal constant REF_ETH_USDG = 0xa791e5169faf703c0b63fd9552c33ec1128a773a00f5dc33a640da62a022cd35;

    /// @dev Robinhood: 1% minimum anchor step. The tip jar values gas in USDG through the ETH/USDG reference pool
    ///      (REF_V4ID overrides it; REF_KIND=0 turns it off, tips then fall back to the ETH tank).
    function _cfg() internal view returns (DiscipleHook.Config memory c) {
        c.minStep = 10_000;
        c.refToken = USDG;
        c.refKind = uint8(vm.envOr("REF_KIND", uint256(3)));
        c.refTarget = address(PM);
        c.refV4Id = vm.envOr("REF_V4ID", REF_ETH_USDG);
        c.refWethIs0 = true;
        if (c.refKind == 3) {
            // sanity: the reference reads as 100 to 100,000 USDG per ETH (USDG has 6 decimals, ETH 18)
            (uint160 sp,,,) = StateLibrary.getSlot0(PM, PoolId.wrap(c.refV4Id));
            uint256 usdPerEth = Math.mulDiv(Math.mulDiv(uint256(sp), uint256(sp), 1 << 96), 1e12, 1 << 96);
            require(usdPerEth >= 100 && usdPerEth <= 100_000, "reference pool price");
            console2.log("reference USDG per ETH", usdPerEth);
        }
    }

    function pool() public {
        _pool(DiscipleHook(payable(vm.envAddress("HOOK"))));
    }

    function both() external {
        _pool(hook());
    }

    function _pool(DiscipleHook h) internal {
        require(block.chainid == 4663, "run on Robinhood Chain");
        uint256 coinIn = vm.envUint("COIN_IN");
        uint256 quoteIn = vm.envUint("QUOTE_IN");
        uint24 fee = uint24(vm.envOr("FEE", uint256(5000)));
        DiscipleHook.Source memory s;
        s.kind = 3; // v4
        s.coinIs0 = true; // STRATEGY is currency0 of STRATEGY/MSTR
        s.target = address(PM);
        s.v4Id = 0xa6975f4720a95aa9cdfa9b010a065b0e941534c93f9fa708104c08f0ac029ca0;
        s.kind2 = 3; // v4
        s.xIs0 = false; // MSTR is currency1 of USDG/MSTR
        s.target2 = address(PM);
        s.v4Id2 = 0x319bac87e616a89e241c10aeb8afd4892a852cdd8b373cd9765ecddc40b87cfe;
        PoolKey memory k1 = PoolKey(Currency.wrap(STRATEGY), Currency.wrap(MSTR), 0x800000, 8, IHooks(LEG1_HOOK));
        PoolKey memory k2 = PoolKey(Currency.wrap(USDG), Currency.wrap(MSTR), 2500, 25, IHooks(address(0)));
        require(PoolId.unwrap(k1.toId()) == s.v4Id && PoolId.unwrap(k2.toId()) == s.v4Id2, "source keys");
        vm.startBroadcast();
        IERC20(STRATEGY).approve(address(h), coinIn);
        IERC20(USDG).approve(address(h), quoteIn);
        (, PoolId id) = h.createPool(
            DiscipleHook.CreateParams({
                coin: STRATEGY, quote: USDG, fee: fee, src: s, coinIn: coinIn, quoteIn: quoteIn, srcKey: k1, srcKey2: k2
            })
        );
        vm.stopBroadcast();
        DiscipleHook.PoolView memory v = h.poolState(id);
        console2.log("Disciple pool id");
        console2.logBytes32(PoolId.unwrap(id));
        console2.log("STRATEGY reserve", v.coinReserve);
        console2.log("USDG reserve", v.quoteReserve);
        console2.log("source TVL (USDG raw)", v.srcTvl);
    }
}
