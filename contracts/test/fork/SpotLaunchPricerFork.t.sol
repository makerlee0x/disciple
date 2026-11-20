// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {SpotLaunchPricer} from "../../src/addons/SpotLaunchPricer.sol";

interface IOldPricer {
    function launchPriceUsd(address quote) external view returns (uint256);
    function spotPriceUsd(address quote) external view returns (uint256);
}

/// @notice Robinhood mainnet (4663) fork, maker 2026-11-20 ("just call it right when someone presses launch"): point the
///         LIVE Launchpad at SpotLaunchPricer, let the TWAP go stale (no keeper), and launch a STRATEGY coin anyway.
///         SPOT_PRICER_FORK=1 forge test --match-path test/fork/SpotLaunchPricerFork.t.sol -vv   (public RH RPC)
contract SpotLaunchPricerForkTest is Test {
    string internal constant MAINNET_RPC = "https://rpc.mainnet.chain.robinhood.com";
    Launchpad internal constant LP = Launchpad(0xe43F360DC65C9Ba1B7a835BDaa10Fb31f6DC52E5);
    address internal constant OLD_PRICER = 0x95b6FeCef5E94254A4e676ADc6af91fDd70e0f27;
    address internal constant STRATEGY = 0x168661C52E5922288dFb2b3f323b6Cf90eb21e18;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    SpotLaunchPricer internal spot;

    function setUp() public {
        vm.skip(!vm.envOr("SPOT_PRICER_FORK", false));
        vm.createSelectFork(MAINNET_RPC);
        spot = new SpotLaunchPricer(OLD_PRICER);
        vm.prank(LP.owner());
        LP.setPricer(address(spot));
        vm.warp(block.timestamp + 3 hours); // nobody pokes: the TWAP pricer is stale now
    }

    function test_staleTwapRefusesButSpotLaunches() public {
        vm.expectRevert();
        IOldPricer(OLD_PRICER).launchPriceUsd(STRATEGY); // StalePrice: what every launch would hit without a keeper
        uint256 p = spot.launchPriceUsd(STRATEGY);
        assertEq(p, IOldPricer(OLD_PRICER).spotPriceUsd(STRATEGY));
        assertGt(p, 0);
        assertEq(spot.launchPriceUsd(USDG), 1e30); // USDG (6 dec) = $1

        ILaunchpad.LaunchParams memory lp = ILaunchpad.LaunchParams({
            name: "spot test", ticker: "SPOTT", imageURI: "ipfs://x", description: "", socialsURI: "",
            quote: STRATEGY, creatorTaxBps: 0, creatorBuyQuoteIn: 0, creatorBuyMinTokensOut: 0, deadline: block.timestamp + 600
        });
        ILaunchpad.LaunchResult memory r = LP.launch(lp);
        assertTrue(r.token != address(0));
    }

    function test_unlistedQuoteStillRefused() public {
        address junk = makeAddr("junk");
        vm.expectRevert(abi.encodeWithSelector(SpotLaunchPricer.QuoteNotListed.selector, junk));
        spot.launchPriceUsd(junk);
    }

    function test_undo() public {
        vm.prank(LP.owner());
        LP.setPricer(OLD_PRICER);
        assertEq(address(LP.pricer()), OLD_PRICER);
    }
}
