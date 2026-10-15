// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {QuotePricer} from "../src/QuotePricer.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Constants} from "../src/libraries/Constants.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {AntiSnipe} from "../src/AntiSnipe.sol";
import {ReferralRegistry} from "../src/ReferralRegistry.sol";
import {LockedLP} from "../src/LockedLP.sol";
import {Migration} from "../src/Migration.sol";
import {ILaunchpad} from "../src/interfaces/ILaunchpad.sol";
import {Token} from "../src/Token.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {V4Deploy} from "./helpers/V4Deploy.sol";

contract MockQuote is ERC20 {
    constructor() ERC20("USD Mock", "USDG") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }
}

/// @notice Smoke: permissionless factory launch wires token + curve (§5 / #23).
contract LaunchpadTest is Test {
    address internal treasury = makeAddr("treasury");
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");

    MockQuote internal quote;
    ReferralRegistry internal referrals;
    LockedLP internal lockedLP;
    FeeRouter internal feeRouter;
    AntiSnipe internal antiSnipe;
    Migration internal migration;
    Launchpad internal launchpad;

    function setUp() public {
        quote = new MockQuote();
        referrals = new ReferralRegistry(owner);
        lockedLP = new LockedLP(owner, treasury);
        feeRouter = new FeeRouter(owner, treasury, address(referrals));

        V4Deploy.Stack memory stack = V4Deploy.deploy(owner, lockedLP, feeRouter);
        migration = stack.migration;
        vm.startPrank(owner);
        lockedLP.setMigration(address(migration));
        lockedLP.setPoolManager(address(stack.manager));
        vm.stopPrank();

        uint64 n = uint64(vm.getNonce(address(this)));
        address launchpadAddr = vm.computeCreateAddress(address(this), n + 1);
        antiSnipe = new AntiSnipe(launchpadAddr);
        launchpad = new Launchpad(owner, address(feeRouter), address(antiSnipe), address(migration));
        require(address(launchpad) == launchpadAddr, "predict");
        QuotePricer pricer_ = new QuotePricer(owner, IPoolManager(address(0)), address(quote));
        vm.prank(owner);
        launchpad.setPricer(address(pricer_));

        vm.startPrank(owner);
        feeRouter.setLaunchpad(address(launchpad));
        feeRouter.setLockedLP(address(lockedLP));
        feeRouter.setAuthorized(address(stack.hook), true);
        vm.stopPrank();

        quote.mint(alice, 1_000_000 ether);
    }

    function test_launch_permissionless() public {
        vm.startPrank(alice);
        ILaunchpad.LaunchParams memory p = ILaunchpad.LaunchParams({
            name: "Disciple Test",
            ticker: "DTEST",
            imageURI: "ipfs://image",
            description: "hello",
            socialsURI: "",
            quote: address(quote),
            creatorTaxBps: 0,
            creatorBuyQuoteIn: 0,
            creatorBuyMinTokensOut: 0,
            deadline: block.timestamp + 1 hours
        });
        ILaunchpad.LaunchResult memory r = launchpad.launch(p);
        vm.stopPrank();

        assertTrue(launchpad.isLaunched(r.token));
        assertEq(launchpad.curveOf(r.token), r.curve);
        assertEq(Token(r.token).totalSupply(), Constants.TOTAL_SUPPLY);
        assertEq(Token(r.token).decimals(), 18);
        assertEq(Token(r.token).balanceOf(r.curve), Constants.TOTAL_SUPPLY);
        assertEq(Token(r.token).creator(), alice);
        assertEq(AntiSnipe(address(antiSnipe)).launchTimestamp(r.token), block.timestamp);
        assertFalse(BondingCurve(r.curve).graduated());
    }

    function test_launch_rejectsMissingMetadata() public {
        vm.prank(alice);
        ILaunchpad.LaunchParams memory p = ILaunchpad.LaunchParams({
            name: "",
            ticker: "X",
            imageURI: "ipfs://x",
            description: "",
            socialsURI: "",
            quote: address(quote),
            creatorTaxBps: 0,
            creatorBuyQuoteIn: 0,
            creatorBuyMinTokensOut: 0,
            deadline: block.timestamp + 1
        });
        vm.expectRevert(Launchpad.InvalidMetadata.selector);
        launchpad.launch(p);
    }

    function test_launch_rejectsTaxAbove7pct() public {
        vm.prank(alice);
        ILaunchpad.LaunchParams memory p = ILaunchpad.LaunchParams({
            name: "N",
            ticker: "T",
            imageURI: "ipfs://i",
            description: "",
            socialsURI: "",
            quote: address(quote),
            creatorTaxBps: 701,
            creatorBuyQuoteIn: 0,
            creatorBuyMinTokensOut: 0,
            deadline: block.timestamp + 1
        });
        vm.expectRevert(Launchpad.TaxTooHigh.selector);
        launchpad.launch(p);
    }

    function test_lockedLP_removeDisabled() public {
        vm.expectRevert(LockedLP.RemoveLiquidityDisabled.selector);
        lockedLP.removeLiquidity(address(0), 1);
    }
}
