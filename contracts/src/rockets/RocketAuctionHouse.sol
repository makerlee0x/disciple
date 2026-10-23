// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Rocket721} from "./Rocket721.sol";
import {IRocketFeeFeed} from "./IRocketFeeSink.sol";
import {RocketMath} from "./RocketMath.sol";

interface IRocketPoolFund {
    function fund(uint256 amount, uint256 days_) external;
}

/// @title Daily Dutch auction for Rockets. Day i (from `genesis`, a fixed UTC time; intended 00:00 ET = 04:00 UTC
///        during EDT) sells token id i+1. Days are fixed 24h (no DST shifts).
///        First buyer at the current price wins; unsold ids are burned (skipped) after their day ends.
/// @notice Two pricing modes:
///  - Fixed mode (default): start = `fixedStartPrice` (77,000 USDG) at the open.
///  - Feed mode: start = startMultiplier x projected 5y payout per rocket from trailing-7d fees (keeper-posted feed).
///  Floor = reservePrice (77 USDG) in fixed mode; max(reservePrice, floorMultiplier x projected 5y) in feed mode.
///  Price decays over `decayDuration` (default 22h-10s: floor by 21:59:50 ET), exponential by default
///  (smooth: start * (floor/start)^(t/T)), optional linear; it then holds at the reserve (>= 2h enforced) until
///  `closeOffset` (default 23:59:50 ET), when buying stops and the unsold id becomes burnable.
contract RocketAuctionHouse is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Decay {
        Linear,
        Exponential
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant DURATION = 1 days;
    uint256 public constant FIVE_YEARS_DAYS = 1825;

    IERC20 public immutable usdg;
    Rocket721 public immutable rocket;
    uint256 public immutable genesis;

    address public treasury;
    address public pool;
    IRocketFeeFeed public feed;

    // ---- params ----
    bool public useFixedStart = true;
    uint256 public fixedStartPrice; // default 77,000 USDG
    uint256 public reservePrice; // default 77 USDG (absolute floor)
    uint256 public startMultiplierBps = 20_000; // 2.0x
    uint256 public floorMultiplierBps = 5_000; // 0.5x
    uint256 public poolShareBps = 1_000; // 10% of fees -> holders
    uint256 public maxFeedAge = 2 days;
    Decay public decay = Decay.Exponential;
    uint256 public decayDuration = 22 hours - 10; // floor reached by 21:59:50 ET
    uint256 public closeOffset = 1 days - 10; // auction closes 23:59:50 ET; unsold burnable from then
    uint256 public constant MIN_RESERVE_HOLD = 2 hours;
    uint256 public proceedsToPoolBps; // optional seed, default 0
    uint256 public proceedsStreamDays = 30;

    mapping(uint256 => bool) public sold; // by day

    event Bought(uint256 indexed day, uint256 indexed tokenId, address indexed buyer, uint256 price);
    event Burned(uint256 indexed day, uint256 indexed tokenId);

    error AuctionOver();
    error AlreadySold();
    error DayNotOver();
    error PriceTooHigh();
    error StaleFeed();
    error BadParam();
    error NotStarted();

    constructor(address owner_, IERC20 usdg_, Rocket721 rocket_, address treasury_, uint256 genesis_, uint256 unit_)
        Ownable(owner_)
    {
        usdg = usdg_;
        rocket = rocket_;
        treasury = treasury_;
        genesis = genesis_;
        fixedStartPrice = 77_000 * unit_;
        reservePrice = 77 * unit_;
    }

    // ---------------- admin ----------------
    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert BadParam();
        treasury = t;
    }

    function setPool(address p) external onlyOwner {
        pool = p;
    }

    function setFeed(IRocketFeeFeed f) external onlyOwner {
        feed = f;
    }

    function setFixedStart(bool on, uint256 price) external onlyOwner {
        if (price == 0) revert BadParam();
        useFixedStart = on;
        fixedStartPrice = price;
    }

    function setPricing(uint256 startBps, uint256 floorBps, uint256 reserve, uint256 shareBps, uint256 maxAge)
        external
        onlyOwner
    {
        if (floorBps > startBps || startBps == 0 || shareBps > BPS || maxAge == 0) revert BadParam();
        startMultiplierBps = startBps;
        floorMultiplierBps = floorBps;
        reservePrice = reserve;
        poolShareBps = shareBps;
        maxFeedAge = maxAge;
    }

    /// @notice Owner sets decay curve, decay duration and close offset (seconds after the open; fixed UTC).
    ///         Enforces: close <= 24h and the price holds at the reserve for >= 2h before close.
    function setDecay(Decay d, uint256 duration, uint256 close) external onlyOwner {
        if (duration == 0 || close > DURATION || close < duration + MIN_RESERVE_HOLD) revert BadParam();
        decay = d;
        decayDuration = duration;
        closeOffset = close;
    }

    function setProceeds(uint256 toPoolBps, uint256 streamDays) external onlyOwner {
        if (toPoolBps > BPS || streamDays == 0 || streamDays > 90) revert BadParam();
        proceedsToPoolBps = toPoolBps;
        proceedsStreamDays = streamDays;
    }

    // ---------------- views ----------------
    function currentDay() public view returns (uint256) {
        if (block.timestamp < genesis) revert NotStarted();
        return (block.timestamp - genesis) / 1 days;
    }

    /// @notice Projected 5-year payout for the next rocket: dailyPool * sum_{k<1825} 1/min(n+k, cap),
    ///         where n = live supply incl. this rocket and supply grows by one per day up to the live cap.
    function projected5y() public view returns (uint256) {
        (uint256 fees7d, uint256 at) = feed.trailingFees7d();
        if (block.timestamp > at + maxFeedAge) revert StaleFeed();
        uint256 daily = fees7d * poolShareBps / BPS / 7;
        uint256 n = rocket.totalMinted() + 1;
        uint256 cap = rocket.liveCap();
        if (n > cap) n = cap;
        uint256 h; // 1e18-scaled harmonic sum
        uint256 k;
        for (; k < FIVE_YEARS_DAYS && n + k < cap; ++k) {
            h += 1e18 / (n + k);
        }
        h += (FIVE_YEARS_DAYS - k) * 1e18 / cap;
        return daily * h / 1e18;
    }

    function startAndFloor() public view returns (uint256 start, uint256 floor) {
        if (useFixedStart) {
            start = fixedStartPrice;
            floor = reservePrice;
        } else {
            uint256 p = projected5y();
            start = p * startMultiplierBps / BPS;
            floor = p * floorMultiplierBps / BPS;
            if (floor < reservePrice) floor = reservePrice;
        }
        if (start < floor) start = floor;
    }

    function priceAt(uint256 elapsed) public view returns (uint256) {
        (uint256 s, uint256 f) = startAndFloor();
        uint256 T = decayDuration;
        if (elapsed >= T || s == f) return f;
        uint256 p;
        if (decay == Decay.Linear) {
            p = s - (s - f) * elapsed / T;
        } else {
            // p = s / 2^(log2(s/f) * t/T)
            uint256 l = RocketMath.log2(s * 1e18 / f);
            p = RocketMath.divPow2(s, l * elapsed / T);
        }
        return p < f ? f : p;
    }

    function currentPrice() public view returns (uint256) {
        uint256 d = currentDay();
        return priceAt(block.timestamp - genesis - d * 1 days);
    }

    // ---------------- actions ----------------
    error AuctionClosed();

    function buy(uint256 maxPrice) external nonReentrant returns (uint256 tokenId) {
        uint256 d = currentDay();
        if (block.timestamp - genesis - d * 1 days >= closeOffset) revert AuctionClosed();
        if (d >= rocket.MAX_SUPPLY()) revert AuctionOver();
        if (sold[d]) revert AlreadySold();
        uint256 price = currentPrice();
        if (price > maxPrice) revert PriceTooHigh();
        sold[d] = true;
        tokenId = d + 1;
        usdg.safeTransferFrom(msg.sender, address(this), price);
        uint256 toPool = pool == address(0) ? 0 : price * proceedsToPoolBps / BPS;
        if (toPool > 0) {
            usdg.forceApprove(pool, toPool);
            IRocketPoolFund(pool).fund(toPool, proceedsStreamDays);
        }
        usdg.safeTransfer(treasury, price - toPool);
        rocket.mint(msg.sender, tokenId);
        emit Bought(d, tokenId, msg.sender, price);
    }

    /// @notice Burn the id of a finished day that went unsold. Permissionless.
    function burnUnsold(uint256 day) external {
        if (day >= rocket.MAX_SUPPLY()) revert AuctionOver();
        if (sold[day]) revert AlreadySold();
        uint256 cd = currentDay();
        if (day > cd || (day == cd && block.timestamp - genesis - cd * 1 days < closeOffset)) revert DayNotOver();
        sold[day] = true; // mark processed
        rocket.burnUnsold(day + 1);
        emit Burned(day, day + 1);
    }
}

/// @notice Simplest safe feed: owner/keeper posts trailing-7d fee volume, bounded per-update change.
contract RocketFeeFeed is Ownable2Step, IRocketFeeFeed {
    uint256 public fees7d;
    uint256 public updatedAt;
    uint256 public maxChangeBps = 5_000; // +/-50% per post (0 = unbounded); first post unbounded
    mapping(address => bool) public isKeeper;

    event Posted(uint256 fees7d, uint256 at);

    error NotKeeper();
    error ChangeTooLarge();

    constructor(address owner_) Ownable(owner_) {}

    function setKeeper(address k, bool ok) external onlyOwner {
        isKeeper[k] = ok;
    }

    function setMaxChangeBps(uint256 b) external onlyOwner {
        maxChangeBps = b;
    }

    function post(uint256 v) external {
        bool own = msg.sender == owner();
        if (!own && !isKeeper[msg.sender]) revert NotKeeper();
        uint256 old = fees7d;
        if (!own && old > 0 && maxChangeBps > 0) {
            uint256 band = old * maxChangeBps / 10_000;
            if (v > old + band || v + band < old) revert ChangeTooLarge();
        }
        fees7d = v;
        updatedAt = block.timestamp;
        emit Posted(v, block.timestamp);
    }

    function trailingFees7d() external view returns (uint256, uint256) {
        return (fees7d, updatedAt);
    }
}
