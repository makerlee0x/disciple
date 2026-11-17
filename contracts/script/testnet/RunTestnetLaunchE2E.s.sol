// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Interfaces match the testnet stack at deploy commit 035d149cc.
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

interface IE2EHarvest {
    function launch(IE2ELaunchpad.LaunchParams calldata params, uint8 creatorFeeDestination)
        external
        returns (IE2ELaunchpad.LaunchResult memory);
    function route(address token) external returns (uint256 quoteAmount, uint256 rocketTokenAmount, uint256 quoteBought);
    function creatorFeeDestinationOf(address token) external view returns (uint8);
}

interface IE2ERouter {
    function buyWithUsdg(address token, uint256 usdgIn, uint256 minTokensOut, uint256 deadline) external returns (uint256);
    function sellToUsdg(address token, uint256 tokensIn, uint256 minUsdgOut, uint256 deadline) external returns (uint256);
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

interface IE2EFeeRouter {
    function creatorAccrued(address token, address creator) external view returns (uint256);
}

/// @notice Robinhood TESTNET 46630 only. End-to-end check of every testnet launch-pair coin.
///         PHASE=launch: one Launchpad.launch per pair coin (plus test STRATEGY), and two CreatorFeeHarvest
///         launches (AI with fees locked into its pool, HOOKR with fees burned). Writes deployments/testnet-launch-e2e.json.
///         PHASE=trade (run at least 7 seconds later, after the snipe window): per coin, a USDG buy and a USDG sell
///         through DiscipleRouter, then the creator fee is read and claimed (or routed by CreatorFeeHarvest).
contract RunTestnetLaunchE2E is Script {
    address constant LAUNCHPAD = 0x7918167753b8eC0bE07FB9E8c3061BC3516bd608;
    address constant ROUTER = 0xb8F4356759F7Bc1351f2D36037AD69ed82b8D839;
    address constant HARVEST = 0x4e94a3e9900B435B7c91d0a7cd53A22C8A9f8A03;
    address constant FEE_ROUTER = 0x7Db57795Ee2611881890b53F15f94fBd598bCf26;
    address constant USDG = 0x9dC7A988a8707dC4AB7ac08fC2CB4D5bf906158D;
    address constant TEST_STRATEGY = 0xF5eB226F7f0890c36A06Cbd0Ff843292b7b1a88C;
    string constant OUT = "./deployments/testnet-launch-e2e.json";
    uint256 constant TAX_BPS = 500;
    uint256 constant BUY_USDG = 5e6;

    function _syms() internal pure returns (string[13] memory) {
        return ["STRATEGY", "AI", "SCHIFFY", "BONER", "MEME", "MOO", "PONS", "ORBIO", "HOOKR", "CASHCAT", "PRIORS", "PENGU", "HMM"];
    }

    function _quoteOf(string memory coins, string memory sym) internal pure returns (address) {
        if (keccak256(bytes(sym)) == keccak256("STRATEGY")) return TEST_STRATEGY;
        return vm.parseJsonAddress(coins, string.concat(".coins.", sym, ".address"));
    }

    function _params(string memory sym, string memory tag, address quote)
        internal
        view
        returns (IE2ELaunchpad.LaunchParams memory p)
    {
        p.name = string.concat("E2E ", sym, tag);
        p.ticker = string.concat("E", sym);
        p.imageURI = "ipfs://bafkreiaskl3bwqbplnhrdkuwaaxqbyhvn2jnyv3kqk4f6i6x6c4dlnwf2e";
        p.description = string.concat("Testnet check of a coin paired with ", sym, ".");
        p.quote = quote;
        p.creatorTaxBps = TAX_BPS;
        p.deadline = block.timestamp + 1 hours;
    }

    function run() external {
        require(block.chainid == 46630, "testnet 46630 only");
        bytes32 phase = keccak256(bytes(vm.envString("PHASE")));
        if (phase == keccak256("launch")) _launchAll();
        else if (phase == keccak256("trade")) _tradeAll();
        else revert("PHASE must be launch or trade");
    }

    function _launchAll() internal {
        string memory coins = vm.readFile("./deployments/testnet-launch-coins.json");
        string[13] memory syms = _syms();
        string memory out;
        vm.startBroadcast();
        for (uint256 i; i < 13; ++i) {
            address q = _quoteOf(coins, syms[i]);
            IE2ELaunchpad.LaunchResult memory r = IE2ELaunchpad(LAUNCHPAD).launch(_params(syms[i], "", q));
            out = vm.serializeAddress("e2e", syms[i], r.token);
            console2.log("launched", syms[i], r.token);
        }
        IE2ELaunchpad.LaunchResult memory a =
            IE2EHarvest(HARVEST).launch(_params("AI", " pool", _quoteOf(coins, "AI")), 1);
        out = vm.serializeAddress("e2e", "AI_pool", a.token);
        console2.log("launched AI_pool", a.token);
        IE2ELaunchpad.LaunchResult memory h =
            IE2EHarvest(HARVEST).launch(_params("HOOKR", " burn", _quoteOf(coins, "HOOKR")), 2);
        out = vm.serializeAddress("e2e", "HOOKR_burn", h.token);
        console2.log("launched HOOKR_burn", h.token);
        vm.stopBroadcast();
        vm.writeJson(out, OUT);
    }

    function _tradeAll() internal {
        string memory e2e = vm.readFile(OUT);
        string[13] memory syms = _syms();
        address me = msg.sender;
        vm.startBroadcast();
        IERC20(USDG).approve(ROUTER, type(uint256).max);
        for (uint256 i; i < 13; ++i) {
            _trade(syms[i], vm.parseJsonAddress(e2e, string.concat(".", syms[i])), me, false);
        }
        _trade("AI_pool", vm.parseJsonAddress(e2e, ".AI_pool"), me, true);
        _trade("HOOKR_burn", vm.parseJsonAddress(e2e, ".HOOKR_burn"), me, true);
        vm.stopBroadcast();
    }

    function _trade(string memory label, address token, address me, bool viaHarvest) internal {
        IE2ECurve curve = IE2ECurve(IE2ELaunchpad(LAUNCHPAD).curveOf(token));
        address q = curve.quote();
        IE2EVault vault = IE2EVault(curve.feeVault());
        uint256 got = IE2ERouter(ROUTER).buyWithUsdg(token, BUY_USDG, 1, block.timestamp + 1 hours);
        IERC20(token).approve(ROUTER, got / 2);
        uint256 back = IE2ERouter(ROUTER).sellToUsdg(token, got / 2, 1, block.timestamp + 1 hours);
        uint256 owed = curve.creatorTaxOwed();
        address creatorNow = IE2ELaunchpad(LAUNCHPAD).creatorOf(token);
        console2.log(label, "bought tokens / sold half for USDG:", got, back);
        console2.log(label, "creatorTaxOwed (quote) after trades:", owed);
        require(owed > 0 || vault.creatorAccrued(token, creatorNow) > 0, string.concat(label, ": no creator fee accrued"));
        if (viaHarvest) {
            (uint256 qa, uint256 ra, uint256 qb) = IE2EHarvest(HARVEST).route(token);
            console2.log(label, "harvest routed quote / rocket / bought:", qa, ra);
            console2.log(label, "harvest quoteBought:", qb);
            require(qa > 0, string.concat(label, ": harvest routed nothing"));
        } else {
            uint256 b0 = IERC20(q).balanceOf(me);
            uint256 c = vault.claimCreatorFees(token);
            uint256 b1 = IERC20(q).balanceOf(me);
            console2.log(label, "claimed creator fees (quote):", c, b1 - b0);
            require(c > 0 && b1 - b0 == c, string.concat(label, ": claim failed"));
        }
        require(IE2EFeeRouter(FEE_ROUTER).creatorAccrued(token, creatorNow) == 0 || !viaHarvest, "leftover");
    }
}
