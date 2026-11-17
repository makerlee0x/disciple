// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IE2ELaunchpad {
    struct LaunchParams {
        string name;
        string ticker;
        string imageURI;
        string description;
        string socialsURI;
        address quote;
        uint256 creatorTaxBps;
        uint256 creatorBuyQuoteIn;
        uint256 creatorBuyMinTokensOut;
        uint256 deadline;
    }

    struct LaunchResult {
        address token;
        address curve;
        uint256 creatorTokensBought;
    }

    function launch(LaunchParams calldata params) external returns (LaunchResult memory);
    function curveOf(address token) external view returns (address);
    function creatorOf(address token) external view returns (address);
}

interface IE2ERouter {
    function buyWithUsdg(address token, uint256 usdgIn, uint256 minTokensOut, uint256 deadline) external returns (uint256);
    function sellToUsdg(address token, uint256 tokensIn, uint256 minUsdgOut, uint256 deadline) external returns (uint256);
    function quoteBuyWithUsdg(address token, uint256 usdgIn) external returns (uint256 tokensOut, uint256 impactBps);
    function quoteSellToUsdg(address token, uint256 tokensIn) external returns (uint256 usdgOut, uint256 impactBps);
}

interface IE2ECurve {
    function quote() external view returns (address);
    function feeVault() external view returns (address);
    function creatorTaxOwed() external view returns (uint112);
    function graduated() external view returns (bool);
}

interface IE2EVault {
    function creatorAccrued(address token, address creator) external view returns (uint256);
    function claimCreatorFees(address token) external returns (uint256);
}

/// @notice Robinhood TESTNET 46630 only. End-to-end check of a launch paired with the DELTA stand-in.
///         PHASE=launch writes the new coin to deployments/testnet-launch-e2e.json under .DELTA.
///         PHASE=trade (run at least 7 seconds later, after the snipe window) buys with 100 USDG, sells half,
///         then claims the creator fee.
contract RunTestnetDeltaE2E is Script {
    address constant LAUNCHPAD = 0x7918167753b8eC0bE07FB9E8c3061BC3516bd608;
    address constant ROUTER = 0xb8F4356759F7Bc1351f2D36037AD69ed82b8D839;
    address constant USDG = 0x9dC7A988a8707dC4AB7ac08fC2CB4D5bf906158D;
    string constant COINS = "./deployments/testnet-launch-coins.json";
    string constant OUT = "./deployments/testnet-launch-e2e.json";
    uint256 constant TAX_BPS = 500;
    uint256 constant BUY_USDG = 100e6;

    function run() external {
        require(block.chainid == 46630, "testnet 46630 only");
        bytes32 phase = keccak256(bytes(vm.envString("PHASE")));
        if (phase == keccak256("launch")) _launch();
        else if (phase == keccak256("trade")) _trade();
        else revert("PHASE must be launch or trade");
    }

    function _launch() internal {
        address quote = vm.parseJsonAddress(vm.readFile(COINS), ".coins.DELTA.address");
        IE2ELaunchpad.LaunchParams memory p;
        p.name = "E2E DELTA";
        p.ticker = "EDELTA";
        p.imageURI = "ipfs://bafkreiaskl3bwqbplnhrdkuwaaxqbyhvn2jnyv3kqk4f6i6x6c4dlnwf2e";
        p.description = "Testnet check of a coin paired with DELTA.";
        p.quote = quote;
        p.creatorTaxBps = TAX_BPS;
        p.deadline = block.timestamp + 1 hours;
        vm.startBroadcast();
        IE2ELaunchpad.LaunchResult memory r = IE2ELaunchpad(LAUNCHPAD).launch(p);
        vm.stopBroadcast();
        console2.log("launched DELTA-paired coin", r.token);
        console2.log("curve", r.curve);
        vm.writeJson(vm.toString(r.token), OUT, ".DELTA");
    }

    function _trade() internal {
        address token = vm.parseJsonAddress(vm.readFile(OUT), ".DELTA");
        address me = msg.sender;
        IE2ECurve curve = IE2ECurve(IE2ELaunchpad(LAUNCHPAD).curveOf(token));
        address q = curve.quote();
        IE2EVault vault = IE2EVault(curve.feeVault());

        (uint256 qBuyOut, uint256 qBuyImp) = IE2ERouter(ROUTER).quoteBuyWithUsdg(token, BUY_USDG);
        console2.log("quote buy tokensOut / impactBps:", qBuyOut, qBuyImp);

        vm.startBroadcast();
        IERC20(USDG).approve(ROUTER, type(uint256).max);
        uint256 got = IE2ERouter(ROUTER).buyWithUsdg(token, BUY_USDG, 1, block.timestamp + 1 hours);
        uint256 sellIn = got / 2;
        vm.stopBroadcast();
        (uint256 qSellOut, uint256 qSellImp) = IE2ERouter(ROUTER).quoteSellToUsdg(token, sellIn);
        console2.log("quote sell usdgOut / impactBps:", qSellOut, qSellImp);
        vm.startBroadcast();
        IERC20(token).approve(ROUTER, sellIn);
        uint256 back = IE2ERouter(ROUTER).sellToUsdg(token, sellIn, 1, block.timestamp + 1 hours);
        uint256 owed = curve.creatorTaxOwed();
        address creatorNow = IE2ELaunchpad(LAUNCHPAD).creatorOf(token);
        uint256 accrued = vault.creatorAccrued(token, creatorNow);
        console2.log("bought tokens / sold half for USDG:", got, back);
        console2.log("creatorTaxOwed (quote) after trades:", owed);
        console2.log("creatorAccrued (quote) after trades:", accrued);
        require(owed > 0 || accrued > 0, "DELTA: no creator fee accrued");
        uint256 b0 = IERC20(q).balanceOf(me);
        uint256 c = vault.claimCreatorFees(token);
        uint256 b1 = IERC20(q).balanceOf(me);
        console2.log("claimed creator fees (quote):", c, b1 - b0);
        require(c > 0 && b1 - b0 == c, "DELTA: claim failed");
        vm.stopBroadcast();
    }

}
