// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Constants} from "./libraries/Constants.sol";
import {FeeMath} from "./libraries/FeeMath.sol";
import {CurveMath} from "./libraries/CurveMath.sol";
import {Token} from "./Token.sol";
import {BondingCurve} from "./BondingCurve.sol";
import {CurveDeployer} from "./CurveDeployer.sol";
import {ILaunchpad} from "./interfaces/ILaunchpad.sol";
import {AntiSnipe} from "./AntiSnipe.sol";
import {FeeRouter} from "./FeeRouter.sol";
import {IReferralRegistry} from "./interfaces/IReferralRegistry.sol";
import {IQuoteProbe} from "./interfaces/IQuoteProbe.sol";
import {IQuotePricer} from "./interfaces/IQuotePricer.sol";

/// @title Permissionless DISCIPLE launchpad / factory (§5 / LOCKED #23–#27)
/// @notice Anyone can launch. Metadata: image+name+ticker required; description/socials optional.
interface IRouterKill {
    function setRouterKilled(bool killed) external;
}

interface IPricerPoke {
    function poke(address quote) external;
}

contract Launchpad is ILaunchpad {
    using SafeERC20 for IERC20;

    address public immutable feeRouter;
    address public immutable antiSnipe;
    address public immutable migration;
    address public owner;

    /// @notice Default quote (STRATEGY on RH chain). Used when launch/launchCoin passes quote=address(0).
    address public defaultQuote;
    IQuoteProbe public quoteProbe;
    /// @notice Launch-time quote/USD oracle (USDG=$1; others via registered quote/USDG v4 pool).
    IQuotePricer public pricer;
    /// @notice BondingCurve factory (separate contract to keep Launchpad under the size limit).
    CurveDeployer public curveDeployer;

    mapping(address => bool) public override isLaunched;
    mapping(address => address) public override curveOf;
    mapping(address => LaunchMeta) public metaOf;

    struct LaunchMeta {
        string name;
        string ticker;
        string imageURI;
        string description;
        string socialsURI;
        address creator;
        uint256 creatorTaxBps;
        uint256 launchedAt;
    }

    uint256 public launchCount;

    /// @notice Creator same-tx buy cap in bps of supply (protocol owner only; never the coin creator).
    uint256 public creatorBuyMaxBps = Constants.CREATOR_BUY_MAX_BPS_DEFAULT;
    /// @notice Cap snapshotted per coin at launch (later changes only affect future coins).
    mapping(address => uint256) public creatorBuyMaxBpsOf;
    /// @notice Per-wallet bonding-curve holding cap for FUTURE launches, bps of supply (0 = no cap, max 10000).
    uint256 public walletCapBps = Constants.WALLET_CAP_BPS_DEFAULT;
    /// @notice walletCapBps snapshotted per coin at launch (immutable in the curve).
    mapping(address => uint256) public walletCapBpsOf;

    /// @notice Routers allowed to call curve.routerBuy / routerSell on behalf of a trader (owner-managed).
    mapping(address => bool) public isTrustedRouter;
    /// @notice Primary router, snapshotted into each NEW curve as an immutable (gas: no external call per router
    ///         trade). Set by setTrustedRouter(r, true); cleared when that router is untrusted. Existing curves keep
    ///         trusting their snapshot (documented; prepaid amounts are balance-checked by the curve).
    address public curveRouter;
    /// @notice PVE LoginGate (EIP-712 Privy-login attestations). Required to launch PVE coins; snapshotted per coin.
    address public loginGate;
    /// @notice Game mode per coin (Constants.MODE_*: 0 TRENCH WARFARE, 1 PVE, 2 PVP), immutable.
    mapping(address => uint8) public modeOf;

    error InvalidMetadata();
    error TaxTooHigh();
    error CreatorBuyTooLarge();
    error OnlyCreator();
    error OnlyOwner();
    error QuoteRejected(string detail);
    error DefaultQuoteUnset();
    error PricerUnset();
    error CurveDeployerUnset();
    error CreatorBuyMaxTooHigh();
    error WalletCapTooHigh();
    error BadMode();
    error LoginGateUnset();

    event Launched(
        address indexed token,
        address indexed curve,
        address indexed creator,
        address quote,
        string name,
        string ticker,
        uint256 creatorTaxBps
    );
    event MetadataUpdated(address indexed token, string imageURI, string description, string socialsURI);
    event CreatorTransferred(address indexed token, address indexed previousCreator, address indexed newCreator);
    event DefaultQuoteUpdated(address indexed quote);
    event QuoteProbeUpdated(address indexed probe);
    event PricerUpdated(address indexed pricer);
    event CreatorBuyMaxSet(uint256 bps);
    event WalletCapSet(uint256 bps);
    event TrustedRouterSet(address indexed router, bool trusted);
    event CurveRouterKilled(address indexed curve, bool killed);
    event LoginGateSet(address indexed gate);
    /// @notice Bonding-curve game mode chosen by the creator (0 TRENCH WARFARE, 1 PVE, 2 PVP).
    event LaunchMode(address indexed token, address indexed curve, uint8 mode);
    /// @notice Quote/USD price baked into the curve at launch (USD WAD per 1e18 raw quote units).
    event QuotePriced(address indexed token, address indexed quote, uint256 quotePriceUsd);
    /// @notice Emitted at launch for off-chain/indexer tier tracking (no on-chain tier hooks).
    event LaunchTierContext(
        address indexed token, uint256 startMcapUsd, uint256 graduationMcapUsd, uint256 totalSupply, uint8 decimals_
    );

    constructor(address owner_, address feeRouter_, address antiSnipe_, address migration_) {
        owner = owner_;
        feeRouter = feeRouter_;
        antiSnipe = antiSnipe_;
        migration = migration_;
    }

    /// @notice Owner/multisig sets STRATEGY (or replacement) as the default launch quote.
    function setDefaultQuote(address quote_) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (quote_ == address(0)) revert DefaultQuoteUnset();
        defaultQuote = quote_;
        emit DefaultQuoteUpdated(quote_);
    }

    function setCurveDeployer(address d) external {
        if (msg.sender != owner) revert OnlyOwner();
        curveDeployer = CurveDeployer(d);
    }

    /// @notice Protocol owner sets the creator-buy cap for FUTURE launches (ceiling 7%).
    function setCreatorBuyMaxBps(uint256 bps) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (bps > Constants.CREATOR_BUY_MAX_BPS_CEILING) revert CreatorBuyMaxTooHigh();
        creatorBuyMaxBps = bps;
        emit CreatorBuyMaxSet(bps);
    }

    /// @notice Protocol owner sets the per-wallet curve holding cap for FUTURE launches (0 = no cap).
    function setWalletCapBps(uint256 bps) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (bps > Constants.BPS_DENOM) revert WalletCapTooHigh();
        walletCapBps = bps;
        emit WalletCapSet(bps);
    }

    function setTrustedRouter(address r, bool ok) external {
        if (msg.sender != owner) revert OnlyOwner();
        isTrustedRouter[r] = ok;
        if (ok) curveRouter = r;
        else if (curveRouter == r) curveRouter = address(0);
        emit TrustedRouterSet(r, ok);
    }

    /// @notice Audit round 3 (ops) kill switch: existing curves snapshot their primary router as an immutable;
    ///         the owner (protocol multisig) can stop them accepting it (and resume). Curves via `curveOf[token]`.
    function setCurveRouterKilled(address[] calldata curves, bool killed) external {
        if (msg.sender != owner) revert OnlyOwner();
        for (uint256 i; i < curves.length; ++i) {
            IRouterKill(curves[i]).setRouterKilled(killed);
            emit CurveRouterKilled(curves[i], killed);
        }
    }

    function setLoginGate(address g) external {
        if (msg.sender != owner) revert OnlyOwner();
        loginGate = g;
        emit LoginGateSet(g);
    }

    /// @notice Claim PVE holder rewards (profit-tax pool) of `token`'s curve. Works after graduation.
    function claim(address token) external returns (uint256) {
        address c = curveOf[token];
        if (c == address(0)) revert InvalidMetadata();
        return BondingCurve(c).claimFor(msg.sender);
    }

    function setPricer(address pricer_) external {
        if (msg.sender != owner) revert OnlyOwner();
        pricer = IQuotePricer(pricer_);
        emit PricerUpdated(pricer_);
    }

    function setQuoteProbe(address probe_) external {
        if (msg.sender != owner) revert OnlyOwner();
        quoteProbe = IQuoteProbe(probe_);
        emit QuoteProbeUpdated(probe_);
    }

    /// @inheritdoc ILaunchpad
    function launchCoin(LaunchParams calldata params) external override returns (LaunchResult memory) {
        return _launch(params, Constants.MODE_TRENCH);
    }

    /// @inheritdoc ILaunchpad
    function launch(LaunchParams calldata params) external override returns (LaunchResult memory result) {
        return _launch(params, Constants.MODE_TRENCH);
    }

    /// @notice Launch with a bonding-curve game mode (0 TRENCH WARFARE, 1 PVE, 2 PVP). launch/launchCoin = TRENCH.
    function launchWithMode(LaunchParams calldata params, uint8 mode) external returns (LaunchResult memory) {
        return _launch(params, mode);
    }

    function _launch(LaunchParams calldata params, uint8 mode) internal returns (LaunchResult memory result) {
        if (mode > Constants.MODE_PVP) revert BadMode();
        address gate;
        if (mode == Constants.MODE_PVE) {
            gate = loginGate;
            if (gate == address(0)) revert LoginGateUnset();
        }
        if (bytes(params.name).length == 0 || bytes(params.ticker).length == 0 || bytes(params.imageURI).length == 0) {
            revert InvalidMetadata();
        }
        if (params.creatorTaxBps > Constants.CREATOR_TAX_MAX_BPS) revert TaxTooHigh();

        address quote = params.quote;
        if (quote == address(0)) {
            if (defaultQuote == address(0)) revert DefaultQuoteUnset();
            quote = defaultQuote;
        } else if (address(quoteProbe) != address(0)) {
            (IQuoteProbe.ProbeResult pr, string memory detail) = quoteProbe.probe(quote);
            if (pr == IQuoteProbe.ProbeResult.RejectHoneypot || pr == IQuoteProbe.ProbeResult.RejectFeeOnTransfer) {
                revert QuoteRejected(detail);
            }
        }

        Token t = new Token(
            params.name, params.ticker, msg.sender, address(this), address(this), mode == Constants.MODE_PVE
        );

        // USD price is derived on-chain (never caller-supplied); reverts if no USDG reference pool.
        if (address(pricer) == address(0)) revert PricerUnset();
        // SEC-03: keep the quote TWAP fresh; the poke is lagged, so a same-tx flash move has no effect.
        try IPricerPoke(address(pricer)).poke(quote) {} catch {}
        uint256 quotePriceUsd = pricer.quotePriceUsd(quote);
        if (address(curveDeployer) == address(0)) revert CurveDeployerUnset();
        uint256 wcap = walletCapBps;
        walletCapBpsOf[address(t)] = wcap;
        BondingCurve curve = BondingCurve(
            curveDeployer.deploy(
                address(t),
                quote,
                msg.sender,
                feeRouter,
                antiSnipe,
                migration,
                params.creatorTaxBps,
                CurveMath.makeParams(quotePriceUsd),
                wcap,
                mode,
                gate,
                curveRouter
            )
        );

        if (mode == Constants.MODE_PVE) t.setPveCurve(address(curve));
        IERC20(address(t)).safeTransfer(address(curve), Constants.TOTAL_SUPPLY);

        AntiSnipe(antiSnipe).registerLaunch(address(t));
        FeeRouter(feeRouter).setAuthorized(address(curve), true);
        FeeRouter(feeRouter).registerTokenLaunch(address(t), quote, msg.sender);

        isLaunched[address(t)] = true;
        curveOf[address(t)] = address(curve);
        metaOf[address(t)] = LaunchMeta({
            name: params.name,
            ticker: params.ticker,
            imageURI: params.imageURI,
            description: params.description,
            socialsURI: params.socialsURI,
            creator: msg.sender,
            creatorTaxBps: params.creatorTaxBps,
            launchedAt: block.timestamp
        });
        if (mode != Constants.MODE_TRENCH) modeOf[address(t)] = mode;
        emit LaunchMode(address(t), address(curve), mode);
        uint256 capBps = creatorBuyMaxBps;
        creatorBuyMaxBpsOf[address(t)] = capBps;
        unchecked {
            ++launchCount;
        }

        uint256 bought;
        if (params.creatorBuyQuoteIn > 0) {
            // Optional same-tx creator buy; max creatorBuyMaxBps of supply (default 0.77%, §5 / #27)
            IERC20(quote).safeTransferFrom(msg.sender, address(this), params.creatorBuyQuoteIn);
            IERC20(quote).forceApprove(address(curve), params.creatorBuyQuoteIn);
            bought = BondingCurve(curve)
                .buyFor(msg.sender, params.creatorBuyQuoteIn, params.creatorBuyMinTokensOut, params.deadline);
            if (bought > FeeMath.creatorBuyMax(capBps)) revert CreatorBuyTooLarge();
        }

        result = LaunchResult({token: address(t), curve: address(curve), creatorTokensBought: bought});
        emit Launched(address(t), address(curve), msg.sender, quote, params.name, params.ticker, params.creatorTaxBps);
        // Off-chain/indexer consumes this for verified tier ladder — no on-chain tier hooks.
        emit QuotePriced(address(t), quote, quotePriceUsd);
        emit LaunchTierContext(
            address(t), Constants.START_MCAP_USD, Constants.GRADUATION_MCAP_USD, Constants.TOTAL_SUPPLY, 18
        );
    }

    /// @notice Post-launch metadata update: image, description, socials — NOT name/ticker (§5 / #25).
    function updateMetadata(
        address token,
        string calldata imageURI,
        string calldata description,
        string calldata socialsURI
    ) external {
        LaunchMeta storage m = metaOf[token];
        if (msg.sender != m.creator) revert OnlyCreator();
        m.imageURI = imageURI;
        m.description = description;
        m.socialsURI = socialsURI;
        emit MetadataUpdated(token, imageURI, description, socialsURI);
    }

    /// @notice Transfer creator ownership pack (§5 / #26): metadata + fee claim + tax rights.
    /// @dev Accrued fees already booked to the previous creator stay with them (claim anytime).
    function transferCreator(address token, address newCreator) external {
        LaunchMeta storage m = metaOf[token];
        if (msg.sender != m.creator) revert OnlyCreator();
        require(newCreator != address(0), "zero");
        address prev = m.creator;
        m.creator = newCreator;
        emit CreatorTransferred(token, prev, newCreator);
    }

    /// @notice Preview the optional same-tx creator buy (tax 0) — use to set creatorBuyMinTokensOut.
    function quoteCreatorBuy(address quote, uint256 creatorBuyQuoteIn)
        external
        view
        returns (uint256 tokensOut, uint256 fee, uint256 snipeFee, uint256 quotePriceUsd, bool exceedsCap)
    {
        return quoteCreatorBuy(quote, creatorBuyQuoteIn, 0);
    }

    /// @notice Preview the same-tx creator buy at launch: anti-snipe is at its launch-time value
    ///         — EXEMPT from anti-snipe (snipeFee always 0); pays 1% protocol fee + creatorTaxBps.
    /// @param quote address(0) = defaultQuote
    /// @return tokensOut   tokens the creator would receive
    /// @return fee         protocol + creator tax (quote raw)
    /// @return snipeFee    always 0 (creator buy is anti-snipe exempt; kept for ABI stability)
    /// @return quotePriceUsd price the pricer would bake into the curve right now
    /// @return exceedsCap  true if tokensOut > creatorBuyMaxBps of supply (current setting) (launch would revert CreatorBuyTooLarge)
    function quoteCreatorBuy(address quote, uint256 creatorBuyQuoteIn, uint256 creatorTaxBps)
        public
        view
        returns (uint256 tokensOut, uint256 fee, uint256 snipeFee, uint256 quotePriceUsd, bool exceedsCap)
    {
        if (creatorTaxBps > Constants.CREATOR_TAX_MAX_BPS) revert TaxTooHigh();
        if (quote == address(0)) quote = defaultQuote;
        if (quote == address(0)) revert DefaultQuoteUnset();
        if (address(pricer) == address(0)) revert PricerUnset();
        quotePriceUsd = pricer.quotePriceUsd(quote);
        // Creator launch buy is anti-snipe exempt (LOCKED #27): snipeFee is always 0.
        uint256 afterSnipe = creatorBuyQuoteIn;
        fee = FeeMath.protocolFee(afterSnipe) + FeeMath.creatorTax(afterSnipe, creatorTaxBps);
        tokensOut = CurveMath.tokensOutForQuote(CurveMath.makeParams(quotePriceUsd), 0, afterSnipe - fee);
        exceedsCap = tokensOut > FeeMath.creatorBuyMax(creatorBuyMaxBps);
    }

    /// @inheritdoc ILaunchpad
    function creatorOf(address token) external view returns (address) {
        return metaOf[token].creator;
    }
}
