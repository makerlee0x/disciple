// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Constants} from "./libraries/Constants.sol";

interface INameRegistryLaunchpad {
    function curveOf(address token) external view returns (address);
}

interface INameRegistryCurve {
    function graduated() external view returns (bool);
    function marketCapUsd() external view returns (uint256);
}

interface INameRegistryToken {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
}

/// @title Name/ticker lock (MAINNET only; lee 2026-11-10)
/// @notice After a rocket ASCENDS (BondingCurve.graduated) and someone calls claimName, no new launch may use the same
///         name AND ticker (normalized, see nameKey) while it holds the slot. Two coins may share a name OR a ticker.
///         The image is not part of the key and stays editable (Launchpad.updateMetadata is untouched). The slot frees
///         after the holder's mcap has been below Outer Space ($33,333, tier < 4) for NAME_RELEASE_DELAY (24h):
///         markBelow → 24h → releaseName (final check still below). Everything is permissionless.
/// @dev Based on an ENS-style registrar (hash of a normalized key; slot released on "expiry", here the drop-back).
///      Reads only existing views: Launchpad.curveOf, BondingCurve.graduated / marketCapUsd (live v4 price post-grad),
///      Token.name / symbol (set once at launch from LaunchParams.name / ticker). Nothing on the trade path calls
///      this contract; Launchpad calls checkLaunch (view) on launch only. Copies launched BEFORE the original claimed
///      can still ascend and trade; their claimName just returns false. Coins launched before this registry existed
///      are unknown to it (another Launchpad). No owner: `deployer` sets `launchpad` once (Migration.setLaunchpad pattern).
contract NameRegistry {
    address public immutable deployer;
    address public launchpad;

    /// @notice nameKey → the ascended coin holding it (address(0) = free).
    mapping(bytes32 => address) public nameHolder;
    /// @notice Holder coin → timestamp its mcap was first observed below Outer Space (0 = not marked).
    mapping(address => uint256) public nameBelowSince;

    error NameLocked();
    error NotAscended();
    error NotNameHolder();
    error ReleaseTooEarly();
    error UnknownCoin();
    error OnlyDeployer();
    error LaunchpadAlreadySet();

    event LaunchpadSet(address indexed launchpad);
    event NameClaimed(bytes32 indexed key, address indexed token);
    /// @notice Drop-back mark: `since` = first time the mcap was seen below Outer Space; 0 = mark reset (at/above).
    event NameReleaseMarked(bytes32 indexed key, address indexed token, uint256 since);
    event NameReleased(bytes32 indexed key, address indexed token);

    constructor() {
        deployer = msg.sender;
    }

    function setLaunchpad(address launchpad_) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (launchpad != address(0)) revert LaunchpadAlreadySet();
        launchpad = launchpad_;
        emit LaunchpadSet(launchpad_);
    }

    /// @notice keccak256(abi.encode(lowerTrimASCII(name), lowerTrimASCII(ticker))): ASCII A-Z lowercased, leading and
    ///         trailing ASCII whitespace (space, \t \n \v \f \r) trimmed; inner bytes and non-ASCII kept as-is ("exact").
    function nameKey(string memory name, string memory ticker) public pure returns (bytes32) {
        return keccak256(abi.encode(_lowerTrim(bytes(name)), _lowerTrim(bytes(ticker))));
    }

    /// @notice Key of a launched coin (its name/ticker are immutable, so this never changes).
    function keyOf(address token) public view returns (bytes32) {
        return nameKey(INameRegistryToken(token).name(), INameRegistryToken(token).symbol());
    }

    /// @notice Called by Launchpad._launch (view): reverts NameLocked if the new coin's key is held.
    function checkLaunch(address token) external view {
        if (nameHolder[keyOf(token)] != address(0)) revert NameLocked();
    }

    /// @notice Anyone, once `token` has ASCENDED: take its name/ticker slot. True if `token` holds it (idempotent);
    ///         false (no revert) if another coin holds it.
    function claimName(address token) external returns (bool) {
        if (!INameRegistryCurve(_curve(token)).graduated()) revert NotAscended();
        bytes32 key = keyOf(token);
        address h = nameHolder[key];
        if (h == token) return true;
        if (h != address(0)) return false;
        nameHolder[key] = token;
        delete nameBelowSince[token];
        emit NameClaimed(key, token);
        return true;
    }

    /// @notice Anyone: observe the holder's mcap. Below Outer Space → mark the first time seen (kept if already marked);
    ///         at/above → reset the mark. Returns the mark after the call (0 = not marked).
    function markBelow(address token) external returns (uint256 since) {
        (bytes32 key, address c) = _held(token);
        since = nameBelowSince[token];
        if (INameRegistryCurve(c).marketCapUsd() < Constants.OUTER_SPACE_MCAP_USD) {
            if (since == 0) {
                since = block.timestamp;
                nameBelowSince[token] = since;
                emit NameReleaseMarked(key, token, since);
            }
        } else if (since != 0) {
            since = 0;
            delete nameBelowSince[token];
            emit NameReleaseMarked(key, token, 0);
        }
    }

    /// @notice Anyone: free the slot once marked for NAME_RELEASE_DELAY and the mcap is still below now. If the mcap is
    ///         back at/above, the mark resets instead and this returns false.
    function releaseName(address token) external returns (bool) {
        (bytes32 key, address c) = _held(token);
        uint256 since = nameBelowSince[token];
        if (since == 0 || block.timestamp < since + Constants.NAME_RELEASE_DELAY) revert ReleaseTooEarly();
        delete nameBelowSince[token];
        if (INameRegistryCurve(c).marketCapUsd() >= Constants.OUTER_SPACE_MCAP_USD) {
            emit NameReleaseMarked(key, token, 0);
            return false;
        }
        delete nameHolder[key];
        emit NameReleased(key, token);
        return true;
    }

    function _curve(address token) internal view returns (address c) {
        c = INameRegistryLaunchpad(launchpad).curveOf(token);
        if (c == address(0)) revert UnknownCoin();
    }

    function _held(address token) internal view returns (bytes32 key, address c) {
        c = _curve(token);
        key = keyOf(token);
        if (nameHolder[key] != token) revert NotNameHolder();
    }

    function _lowerTrim(bytes memory s) internal pure returns (bytes memory out) {
        uint256 a;
        uint256 b = s.length;
        while (a < b && _isSpace(s[a])) ++a;
        while (b > a && _isSpace(s[b - 1])) --b;
        out = new bytes(b - a);
        for (uint256 i; i < out.length; ++i) {
            bytes1 ch = s[a + i];
            if (ch >= 0x41 && ch <= 0x5A) ch = bytes1(uint8(ch) + 32);
            out[i] = ch;
        }
    }

    function _isSpace(bytes1 ch) private pure returns (bool) {
        return ch == 0x20 || (ch >= 0x09 && ch <= 0x0D);
    }
}
