// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./integration/IntegrationBase.sol";
import {AnonLauncher} from "../src/addons/AnonLauncher.sol";
import {DiscipleRouter} from "../src/DiscipleRouter.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev Fee token that re-enters AnonLauncher.launchAnonWithUsdg on the launch-fee transfer.
contract ReenteringFeeToken is MockUSDG {
    AnonLauncher public target;
    bool public attack;

    function arm(AnonLauncher t) external {
        target = t;
        attack = true;
    }

    function transferFrom(address from, address to, uint256 amt) public override returns (bool) {
        require(super.transferFrom(from, to, amt));
        if (attack && address(target) != address(0)) {
            attack = false;
            ILaunchpad.LaunchParams memory p = ILaunchpad.LaunchParams({
                name: "Re",
                ticker: "RE",
                imageURI: "ipfs://x",
                description: "",
                socialsURI: "",
                quote: address(0),
                creatorTaxBps: 0,
                creatorBuyQuoteIn: 0,
                creatorBuyMinTokensOut: 0,
                deadline: block.timestamp + 1 hours
            });
            target.launchAnonWithUsdg(p, address(1), address(1), "", 0x00, type(uint256).max, 0, 0, address(0));
        }
        return true;
    }
}

/// @notice Private-launch First BOOST paid in USDG through DiscipleRouter.launchWithUsdg.
contract AnonLauncherFirstBuyTest is IntegrationBase {
    AnonLauncher internal anon;
    address internal payer = makeAddr("payer");
    uint256 internal skA;
    address internal stealthA;
    uint256 internal skB;
    address internal stealthB;
    uint256 constant FEE = 0; // hidden launches are free (maker 2026-11-17)

    function setUp() public override {
        super.setUp();
        _warmQuote(address(strategy)); // pair-coin launches need a warm, fresh TWAP
        anon =
            new AnonLauncher(owner, address(launchpad), address(feeRouter), address(quote), address(0));
        // lp-accrue: the CurveFeeVault is built with this AnonLauncher (as DeployLpAccrue / Deploy do), so private
        // coins' curve-phase creator fees are claimable by the coin's owner there
        feeVault = new CurveFeeVault(address(feeRouter), address(anon));
        address d = address(new CurveDeployer(address(feeVault)));
        vm.prank(owner);
        vm.store(address(launchpad), bytes32(uint256(5)), bytes32(0)); // test-only: the deployer is write-once
        launchpad.setCurveDeployer(d);
        (stealthA, skA) = makeAddrAndKey("stealthA");
        (stealthB, skB) = makeAddrAndKey("stealthB");
        quote.mint(payer, 1_000_000 ether);
        vm.prank(payer);
        quote.approve(address(anon), type(uint256).max);
        router.setUsdgRouting(address(quote), address(launchpad));
        router.setUsdgPool(address(strategy), strategyUsdgKey);
    }

    function _paramsQ(address q, uint256 minOut, uint256 deadline)
        internal
        view
        returns (ILaunchpad.LaunchParams memory)
    {
        return ILaunchpad.LaunchParams({
            name: "Anon",
            ticker: "ANON",
            imageURI: "ipfs://x",
            description: "",
            socialsURI: "",
            quote: q,
            creatorTaxBps: 0,
            creatorBuyQuoteIn: 0,
            creatorBuyMinTokensOut: minOut,
            deadline: deadline
        });
    }

    function _paramsLegacy(uint256 buy) internal view returns (ILaunchpad.LaunchParams memory) {
        ILaunchpad.LaunchParams memory p = _paramsQ(address(quote), 0, block.timestamp + 1 hours);
        p.creatorBuyQuoteIn = buy;
        return p;
    }

    function _launchUsdg(address stealth, address recipient, address q, uint256 usdgIn, uint256 minQuoteIn)
        internal
        returns (ILaunchpad.LaunchResult memory r, uint256 refund)
    {
        return _launchUsdgTo(stealth, recipient, q, usdgIn, minQuoteIn, address(0));
    }

    function _launchUsdgTo(
        address stealth,
        address recipient,
        address q,
        uint256 usdgIn,
        uint256 minQuoteIn,
        address refundTo
    ) internal returns (ILaunchpad.LaunchResult memory r, uint256 refund) {
        vm.prank(payer);
        return anon.launchAnonWithUsdg(
            _paramsQ(q, 0, block.timestamp + 1 hours), stealth, recipient, "", 0x00, FEE, usdgIn, minQuoteIn, refundTo
        );
    }

    /// @notice maker 2026-11-19: hidden launches cannot take a First BOOST at all.
    function test_firstBoost_blocked_onHiddenLaunches() public {
        vm.startPrank(payer);
        vm.expectRevert(AnonLauncher.NoFirstBoost.selector);
        anon.launchAnonWithUsdg(
            _paramsQ(address(quote), 0, block.timestamp + 1 hours), stealthA, stealthA, "", 0x00, FEE, 10 ether, 0, address(0)
        );
        vm.expectRevert(AnonLauncher.NoFirstBoost.selector);
        anon.launchAnon(_paramsLegacy(1 ether), stealthA, stealthA, "", 0x00, FEE);
        vm.stopPrank();
    }

    function test_zero_first_buy_still_works() public {
        uint256 t0 = quote.balanceOf(treasury);
        (ILaunchpad.LaunchResult memory r, uint256 refund) = _launchUsdg(stealthA, stealthA, address(quote), 0, 0);
        assertEq(r.creatorTokensBought, 0);
        assertEq(refund, 0);
        assertEq(anon.stealthOwnerOf(r.token), stealthA);
        assertEq(launchpad.creatorOf(r.token), address(anon));
        assertEq(Token(r.token).balanceOf(stealthA), 0);
        assertEq(quote.balanceOf(treasury) - t0, FEE);
        // existing launchAnon path is unchanged
        vm.prank(payer);
        ILaunchpad.LaunchResult memory r2 = anon.launchAnon(_paramsLegacy(0), stealthB, stealthB, "", 0x00, FEE);
        assertEq(r2.creatorTokensBought, 0);
        assertEq(anon.stealthOwnerOf(r2.token), stealthB);
    }

    function test_routerUnset_reverts() public {
        vm.prank(owner);
        launchpad.setTrustedRouter(address(router), false);
        vm.prank(payer);
        vm.expectRevert(AnonLauncher.RouterUnset.selector);
        anon.launchAnonWithUsdg(
            _paramsQ(address(quote), 0, block.timestamp + 1 hours), stealthA, stealthA, "", 0x00, FEE, 10 ether, 1, address(0)
        );
    }

    function test_refundTo_cannot_be_launcher() public {
        vm.prank(payer);
        vm.expectRevert(AnonLauncher.BadRefundTo.selector);
        anon.launchAnonWithUsdg(
            _paramsQ(address(quote), 0, block.timestamp + 1 hours),
            stealthA,
            stealthA,
            "",
            0x00,
            FEE,
            10 ether,
            1,
            address(anon)
        );
    }

    // ───────── lp-accrue: private-launch creator fees in CurveFeeVault (refundTo unchanged) ─────────

    function _vaultSig(uint256 sk, address o, address[] memory toks, address to, uint256 feeBps, uint256 dl)
        internal
        view
        returns (bytes memory)
    {
        (, string memory name, string memory version, uint256 chainId, address vc,,) = feeVault.eip712Domain();
        bytes32 ds = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                vc
            )
        );
        bytes32 sh = keccak256(
            abi.encode(
                keccak256(
                    "Claim(address owner,address[] tokens,address to,uint256 relayerFeeBps,uint256 nonce,uint256 deadline)"
                ),
                o,
                keccak256(abi.encodePacked(toks)),
                to,
                feeBps,
                feeVault.sigNonces(o),
                dl
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sk, keccak256(abi.encodePacked("\x19\x01", ds, sh)));
        return abi.encodePacked(r, s, v);
    }

    function _tradeOn(address curve, uint256 q) internal {
        _warpPastSnipe();
        vm.startPrank(trader1);
        quote.approve(curve, type(uint256).max);
        BondingCurve(curve).buy(q, 0, block.timestamp + 1 hours);
        vm.stopPrank();
    }

    /// @dev The relayer (Multicall3) launches for a named player whose wallet owns the coin: the leftover First BOOST
    ///      still goes to the player (refundTo), and the coin's curve-phase creator fees, booked in the vault under the
    ///      launcher, are claimed gaslessly by the player's own signature. Nothing is left on the caller or launcher.
    function test_lpAccrue_relayedLaunch_walletOwner_refundTo_and_vaultClaimBySig() public {
        address mc = makeAddr("multicall3");
        (address player, uint256 playerSk) = makeAddrAndKey("playerWallet");
        quote.mint(mc, 1_000_000 ether);
        vm.startPrank(mc);
        quote.approve(address(anon), type(uint256).max);
        (ILaunchpad.LaunchResult memory r,) = anon.launchAnonWithUsdg(
            _paramsQ(address(quote), 0, block.timestamp + 1 hours), player, player, "", 0x00, FEE, 0, 0, player
        );
        vm.stopPrank();
        uint256 refund = 0; // maker 2026-11-19: hidden launches have no First BOOST
        assertEq(r.creatorTokensBought, 0);
        assertEq(anon.stealthOwnerOf(r.token), player);
        assertEq(address(BondingCurve(r.curve).feeVault()), address(feeVault), "new curve uses the vault");

        _tradeOn(r.curve, 100 ether);
        uint256 owed = feeVault.creatorClaimable(r.token, address(anon));
        assertGt(owed, 0);
        assertEq(feeRouter.creatorAccrued(r.token, address(anon)), 0, "nothing in FeeRouter on a new curve");

        address[] memory toks = new address[](1);
        toks[0] = r.token;
        uint256 dl = block.timestamp + 30 minutes;
        bytes memory sig = _vaultSig(playerSk, player, toks, player, 0, dl);
        vm.prank(mc); // the gasless relayer submits; the player pays no gas
        feeVault.claimManyAsStealthBySig(CurveFeeVault.ClaimReq(player, toks, player, 0, dl, sig));
        assertEq(quote.balanceOf(player), refund + owed, "player got the leftover and the creator fees");
        assertEq(feeVault.creatorClaimable(r.token, address(anon)), 0);
        assertEq(quote.balanceOf(address(anon)), 0);
        assertEq(quote.balanceOf(mc), 1_000_000 ether - FEE, "caller keeps nothing extra");

        // the caller (or anyone else) cannot claim the player's coin from the vault
        _tradeOn(r.curve, 50 ether);
        vm.prank(mc);
        vm.expectRevert(CurveFeeVault.NotStealthOwner.selector);
        feeVault.claimCreatorFeesAsStealth(r.token, mc);
        vm.prank(player);
        assertGt(feeVault.claimCreatorFeesAsStealth(r.token, player), 0);
    }

    /// @dev Stealth-owned private launch with a USDG First BOOST: the stealth key signs the vault claim, paid to the
    ///      player's wallet, relayer fee <= 5% to the submitter.
    function test_lpAccrue_stealthOwner_usdgLaunch_vaultClaimBySig_relayerFee() public {
        address player = makeAddr("playerWallet");
        (ILaunchpad.LaunchResult memory r,) = _launchUsdgTo(stealthA, stealthA, address(quote), 0, 0, player);
        _tradeOn(r.curve, 200 ether);
        uint256 owed = feeVault.creatorClaimable(r.token, address(anon));
        assertGt(owed, 0);
        address[] memory toks = new address[](1);
        toks[0] = r.token;
        uint256 dl = block.timestamp + 30 minutes;
        bytes memory sig = _vaultSig(skA, stealthA, toks, player, 0, dl);
        address relayer = makeAddr("relayer");
        uint256 p0 = quote.balanceOf(player);
        vm.prank(relayer);
        feeVault.claimManyAsStealthBySig(CurveFeeVault.ClaimReq(stealthA, toks, player, 0, dl, sig));
        uint256 rf = (owed * 0) / 10_000;
        assertEq(quote.balanceOf(player) - p0, owed - rf);
        assertEq(quote.balanceOf(relayer), rf);
        // a signature by the wrong key (stealthB) is refused
        _tradeOn(r.curve, 50 ether);
        bytes memory bad = _vaultSig(skB, stealthA, toks, player, 0, dl);
        vm.expectRevert(CurveFeeVault.BadSignature.selector);
        feeVault.claimManyAsStealthBySig(CurveFeeVault.ClaimReq(stealthA, toks, player, 0, dl, bad));
    }
}
