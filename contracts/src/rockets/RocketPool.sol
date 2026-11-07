// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Rocket721} from "./Rocket721.sol";
import {IRocketFeeSink} from "./IRocketFeeSink.sol";

/// @title RocketPool: shared USDG holder pool with daily epochs, daily energy (+1 grace day / 7), levels, referral, rentals.
/// @notice Rewards deposited into day `d` are shared by rockets "ignited" for day `d`, pro-rata by weight
///         (per-day rewardPerWeight). Idle rockets earn nothing that day; their share goes to active ones.
///         Days with zero active weight roll forward. Claims are pull-based in USDG.
contract RocketPool is Ownable2Step, ReentrancyGuard, IRocketFeeSink {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant GRACE_WINDOW = 7; // 1 autopilot day per 7-day window (per rocket)
    uint256 public constant MAX_REFERRAL_BPS = 2_500; // +1.25x
    uint256 public constant ACC = 1e36;

    IERC20 public immutable usdg;
    Rocket721 public immutable rocket;
    uint256 public immutable genesis; // day 0 start (UTC-aligned recommended)

    address public treasury;
    mapping(address => bool) public isDepositor; // FeeRouter / keeper
    mapping(address => bool) public isReporter; // Router / hook / keeper

    // ---- params (owner-settable) ----
    uint256 public levelCostUnit; // k in cumulative cost = k*L^2 (USDG units), default 77 USDG
    uint256 public levelTreasuryBps = 5_000; // 50% treasury / 50% pool
    uint256 public levelStreamDays = 30; // pool share streamed over N days
    uint256 public minQualifying; // flat minimum qualifying action notional, default 33 USDG

    // ---- epochs ----
    mapping(uint256 => uint256) public dayRewards;
    mapping(uint256 => uint256) public dayActiveWeight;
    uint256 public carryCursor; // all days < cursor processed for rollover

    // ---- energy / referral ----
    enum Activity {
        Trade,
        TrampWall,
        TierHold
    }
    mapping(address => uint256) public activeDayPlusOne; // wallet energized for day (d+1)
    mapping(uint256 => uint256) public graceWindowPlusOne; // rocket used grace in window (w+1)
    mapping(address => uint16) public referralBps;

    // ---- per token ignite record (at most one unsettled day) ----
    struct Ignite {
        uint32 day; // day+1 (0 = none)
        uint32 weight;
        uint16 renterBps;
        address owner;
        address user;
    }
    mapping(uint256 => Ignite) public igniteOf;
    mapping(address => uint256) public claimable;

    event Deposited(address indexed from, uint256 amount, uint256 startDay, uint256 days_);
    event ActivityReported(address indexed wallet, Activity kind, uint256 notional, bool qualified);
    event Ignited(uint256 indexed tokenId, uint256 indexed day, address indexed operator, uint256 weight, bool grace);
    event Settled(uint256 indexed tokenId, uint256 day, uint256 ownerAmt, uint256 userAmt);
    event Claimed(address indexed account, uint256 amount);
    event LeveledUp(uint256 indexed tokenId, uint8 level, uint256 cost);
    event RolledOver(uint256 fromDay, uint256 toDay, uint256 amount);

    error NotDepositor();
    error NotReporter();
    error AlreadyIgnited();
    error NoEnergy();
    error MaxLevel();
    error BadParam();
    error ZeroAddress();

    constructor(address owner_, IERC20 usdg_, Rocket721 rocket_, address treasury_, uint256 genesis_, uint256 unit_)
        Ownable(owner_)
    {
        if (treasury_ == address(0) || address(usdg_) == address(0)) revert ZeroAddress();
        usdg = usdg_;
        rocket = rocket_;
        treasury = treasury_;
        genesis = genesis_;
        levelCostUnit = 77 * unit_;
        minQualifying = 33 * unit_;
    }

    // ---------------- admin ----------------
    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        treasury = t;
    }

    function setDepositor(address a, bool ok) external onlyOwner {
        isDepositor[a] = ok;
    }

    function setReporter(address a, bool ok) external onlyOwner {
        isReporter[a] = ok;
    }

    function setLevelParams(uint256 unitCost, uint256 treasuryBps, uint256 streamDays) external onlyOwner {
        if (treasuryBps > BPS || streamDays == 0 || streamDays > 90) revert BadParam();
        levelCostUnit = unitCost;
        levelTreasuryBps = treasuryBps;
        levelStreamDays = streamDays;
    }

    function setMinQualifying(uint256 v) external onlyOwner {
        if (v == 0) revert BadParam();
        minQualifying = v;
    }

    /// @notice Keeper/owner posts referral boost per wallet (computed off-chain, 30d rolling, anti-sybil filtered).
    function setReferralBps(address wallet, uint16 bps) external {
        if (msg.sender != owner() && !isReporter[msg.sender]) revert NotReporter();
        if (bps > MAX_REFERRAL_BPS) revert BadParam();
        referralBps[wallet] = bps;
    }

    // ---------------- views ----------------
    function today() public view returns (uint256) {
        return (block.timestamp - genesis) / 1 days;
    }

    /// @notice weight in bps (10000 = 1.0x): (1 + 0.1L) * (1 + referral), max 2.0 * 1.25 = 2.5x.
    function weightOf(uint256 tokenId, address operator) public view returns (uint256) {
        uint256 lv = rocket.levelOf(tokenId);
        return (BPS + 1_000 * lv) * (BPS + referralBps[operator]) / BPS;
    }

    function levelCost(uint8 fromLevel) public view returns (uint256) {
        // cumulative k*L^2 -> step cost k*((L+1)^2 - L^2) = k*(2L+1)
        return levelCostUnit * (2 * uint256(fromLevel) + 1);
    }

    function pending(uint256 tokenId) external view returns (uint256 ownerAmt, uint256 userAmt) {
        Ignite memory ig = igniteOf[tokenId];
        if (ig.day == 0 || ig.day - 1 >= today()) return (0, 0);
        uint256 d = ig.day - 1;
        uint256 amt = dayRewards[d] * ig.weight / dayActiveWeight[d];
        userAmt = amt * ig.renterBps / BPS;
        ownerAmt = amt - userAmt;
    }

    // ---------------- inflows ----------------
    /// @inheritdoc IRocketFeeSink
    function depositFees(uint256 amount) external override {
        if (!isDepositor[msg.sender]) revert NotDepositor();
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        _rollover(64);
        dayRewards[today()] += amount;
        emit Deposited(msg.sender, amount, today(), 1);
    }

    /// @inheritdoc IRocketFeeSink
    function reportActivity(address wallet, uint256 notionalUsdg) external override {
        _report(wallet, Activity.Trade, notionalUsdg);
    }

    /// @notice Report a qualifying action (trade, tramp/wall, or hold through a tier break) >= minQualifying.
    ///         Self-trade / wash filtering is the reporter's responsibility (trust boundary).
    function reportAction(address wallet, Activity kind, uint256 notionalUsdg) external {
        _report(wallet, kind, notionalUsdg);
    }

    function _report(address wallet, Activity kind, uint256 notionalUsdg) internal {
        if (!isReporter[msg.sender]) revert NotReporter();
        bool q = notionalUsdg >= minQualifying;
        if (q) activeDayPlusOne[wallet] = today() + 1;
        emit ActivityReported(wallet, kind, notionalUsdg, q);
    }

    function isEnergized(address wallet) public view returns (bool) {
        return activeDayPlusOne[wallet] == today() + 1;
    }

    function graceAvailable(uint256 tokenId) public view returns (bool) {
        return graceWindowPlusOne[tokenId] != today() / GRACE_WINDOW + 1;
    }

    // ---------------- play ----------------
    /// @notice Ignite a rocket for today. Requires its operator (renter if rented, else owner) to have a qualifying
    ///         action today (one action covers all of that wallet's rockets), else uses the rocket's 1 grace day
    ///         per 7-day window. Callable by anyone (agents/automation allowed); rewards go to owner/renter.
    function ignite(uint256 tokenId) public {
        uint256 d = today();
        _rollover(64);
        _settle(tokenId);
        Ignite storage ig = igniteOf[tokenId];
        if (ig.day == d + 1) revert AlreadyIgnited();
        (address op, address own, uint16 rbps) = rocket.operatorOf(tokenId);
        bool grace;
        if (!isEnergized(op)) {
            if (!graceAvailable(tokenId)) revert NoEnergy();
            graceWindowPlusOne[tokenId] = d / GRACE_WINDOW + 1;
            grace = true;
        }
        uint256 w = weightOf(tokenId, op);
        dayActiveWeight[d] += w;
        igniteOf[tokenId] = Ignite(uint32(d + 1), uint32(w), rbps, own, op);
        emit Ignited(tokenId, d, op, w, grace);
    }

    function igniteMany(uint256[] calldata ids) external {
        for (uint256 i; i < ids.length; ++i) {
            ignite(ids[i]);
        }
    }

    function settle(uint256[] calldata ids) external {
        for (uint256 i; i < ids.length; ++i) {
            _settle(ids[i]);
        }
    }

    function claim() external nonReentrant returns (uint256 amt) {
        amt = claimable[msg.sender];
        claimable[msg.sender] = 0;
        if (amt > 0) usdg.safeTransfer(msg.sender, amt);
        emit Claimed(msg.sender, amt);
    }

    /// @notice Pay k*(2L+1) USDG to raise level by one (max 10). 50% treasury, 50% streamed into the pool.
    function levelUp(uint256 tokenId) external nonReentrant {
        uint8 lv = rocket.levelOf(tokenId);
        if (lv >= rocket.MAX_LEVEL()) revert MaxLevel();
        uint256 cost = levelCost(lv);
        usdg.safeTransferFrom(msg.sender, address(this), cost);
        uint256 toT = cost * levelTreasuryBps / BPS;
        if (toT > 0) usdg.safeTransfer(treasury, toT);
        _rollover(64);
        _stream(cost - toT, levelStreamDays);
        rocket.setLevel(tokenId, lv + 1);
        emit LeveledUp(tokenId, lv + 1, cost);
    }

    /// @notice Anyone may seed the pool (e.g. auction proceeds share), streamed over `days_`.
    function fund(uint256 amount, uint256 days_) external {
        if (days_ == 0 || days_ > 90) revert BadParam();
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        _rollover(64);
        _stream(amount, days_);
    }

    /// @notice Process rollover of empty past days in bounded batches.
    function pokeRollover(uint256 maxDays) external {
        _rollover(maxDays);
    }

    // ---------------- internal ----------------
    function _stream(uint256 amount, uint256 days_) internal {
        uint256 d = today();
        uint256 per = amount / days_;
        for (uint256 i; i < days_; ++i) {
            dayRewards[d + i] += per;
        }
        dayRewards[d] += amount - per * days_; // dust
        emit Deposited(msg.sender, amount, d, days_);
    }

    function _settle(uint256 tokenId) internal {
        Ignite memory ig = igniteOf[tokenId];
        if (ig.day == 0) return;
        uint256 d = ig.day - 1;
        if (d >= today()) return; // not finalized
        delete igniteOf[tokenId];
        uint256 amt = dayRewards[d] * ig.weight / dayActiveWeight[d];
        uint256 u = amt * ig.renterBps / BPS;
        claimable[ig.user] += u;
        claimable[ig.owner] += amt - u;
        emit Settled(tokenId, d, amt - u, u);
    }

    /// @dev Move rewards of finished days with zero active weight into today.
    function _rollover(uint256 maxDays) internal {
        uint256 t = today();
        uint256 c = carryCursor;
        uint256 end = c + maxDays < t ? c + maxDays : t;
        uint256 carry;
        for (; c < end; ++c) {
            if (dayActiveWeight[c] == 0 && dayRewards[c] > 0) {
                carry += dayRewards[c];
                dayRewards[c] = 0;
            }
        }
        carryCursor = c;
        if (carry > 0) {
            dayRewards[t] += carry;
            emit RolledOver(carryCursor, t, carry);
        }
    }
}
