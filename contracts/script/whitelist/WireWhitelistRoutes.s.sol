// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {WhitelistRoutes} from "./WhitelistRoutes.sol";

interface IWireRouter {
    function owner() external view returns (address);
    function usdg() external view returns (address);
    function setUsdgRoute(address quote, PoolKey[] calldata keys) external;
}

interface IWirePricer {
    function owner() external view returns (address);
    function usdg() external view returns (address);
    function setAllowedQuote(address quote, bool allowed) external;
    function setPriceRoute(address quote, PoolKey[] calldata keys) external;
}

/// @notice Owner wiring of the launch-pair routes (README step 4). Dry-run by default:
///   ROUTER=0x.. PRICER=0x.. forge script script/whitelist/WireWhitelistRoutes.s.sol --rpc-url <mainnet> --sender <owner>
/// Adding --broadcast sends real owner txs and needs lee's explicit yes. Mainnet (4663) only: the PoolKeys are
/// Robinhood mainnet pools. Per pair, in README order: pricer.setAllowedQuote(quote, true) (listed pairs only),
/// pricer.setPriceRoute, router.setUsdgRoute. The optional ETH (WETH) pair gets its routes but stays unlisted.
contract WireWhitelistRoutes is Script {
    function run() external {
        require(block.chainid == WhitelistRoutes.CHAIN_ID, "routes are Robinhood mainnet 4663 pools");
        IWireRouter router = IWireRouter(vm.envAddress("ROUTER"));
        IWirePricer pricer = IWirePricer(vm.envAddress("PRICER"));
        require(router.usdg() == WhitelistRoutes.USDG && pricer.usdg() == WhitelistRoutes.USDG, "usdg mismatch");
        console2.log("router owner", router.owner());
        console2.log("pricer owner", pricer.owner());

        WhitelistRoutes.Route[] memory rs = WhitelistRoutes.all();
        vm.startBroadcast();
        for (uint256 i; i < rs.length; ++i) {
            WhitelistRoutes.Route memory r = rs[i];
            if (r.listed) pricer.setAllowedQuote(r.quote, true);
            pricer.setPriceRoute(r.quote, r.keys);
            router.setUsdgRoute(r.quote, r.keys);
            console2.log(r.listed ? "wired + listed" : "wired, NOT listed (off)", r.symbol, r.quote);
        }
        vm.stopBroadcast();
    }
}
