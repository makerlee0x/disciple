// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC4907} from "./IERC4907.sol";

/// @title DISCIPLE Rocket (ERC-721 + ERC-4907 rentals + levels). Hard cap 777 ids; unsold ids are burned (skipped).
contract Rocket721 is ERC721, Ownable2Step, IERC4907 {
    uint256 public constant MAX_SUPPLY = 777;
    uint8 public constant MAX_LEVEL = 10;
    uint16 public constant MAX_RENTER_BPS = 10_000;

    struct Rental {
        address user;
        uint64 expires;
        uint16 renterBps; // share of rewards to renter while rented
        bool locked; // locked rental blocks transfer until expiry
    }

    address public minter; // auction house
    address public pool; // RocketPool (levels)
    uint256 public totalMinted;
    uint256 public totalBurned; // unsold ids skipped
    mapping(uint256 => bool) public skipped;
    mapping(uint256 => uint8) public levelOf;
    mapping(uint256 => Rental) internal _rentals;
    string internal _base;

    event RentalSet(uint256 indexed tokenId, address indexed user, uint64 expires, uint16 renterBps, bool locked);
    event UnsoldBurned(uint256 indexed tokenId);
    event LevelSet(uint256 indexed tokenId, uint8 level);

    error NotMinter();
    error NotPool();
    error BadId();
    error NotAuthorized();
    error RentalLocked();
    error BadBps();
    error BadLevel();

    constructor(address owner_) ERC721("DISCIPLE Rocket", "ROCKET") Ownable(owner_) {}

    function setMinter(address m) external onlyOwner {
        minter = m;
    }

    function setPool(address p) external onlyOwner {
        pool = p;
    }

    function setBaseURI(string calldata b) external onlyOwner {
        _base = b;
    }

    function _baseURI() internal view override returns (string memory) {
        return _base;
    }

    /// @notice Live cap = 777 minus burned (unsold) ids.
    function liveCap() external view returns (uint256) {
        return MAX_SUPPLY - totalBurned;
    }

    function mint(address to, uint256 id) external {
        if (msg.sender != minter) revert NotMinter();
        if (id == 0 || id > MAX_SUPPLY || skipped[id]) revert BadId();
        totalMinted++;
        _mint(to, id); // reverts if already minted
    }

    function burnUnsold(uint256 id) external {
        if (msg.sender != minter) revert NotMinter();
        if (id == 0 || id > MAX_SUPPLY || skipped[id] || _ownerOf(id) != address(0)) revert BadId();
        skipped[id] = true;
        totalBurned++;
        emit UnsoldBurned(id);
    }

    function setLevel(uint256 id, uint8 lvl) external {
        if (msg.sender != pool) revert NotPool();
        if (lvl > MAX_LEVEL) revert BadLevel();
        _requireOwned(id);
        levelOf[id] = lvl;
        emit LevelSet(id, lvl);
    }

    // ---------------- Rentals (ERC-4907 + split) ----------------
    function setUser(uint256 tokenId, address user, uint64 expires) external override {
        _setRental(tokenId, user, expires, 0, false);
    }

    /// @notice Owner/approved sets a rental with an owner-chosen reward split and optional transfer lock.
    function setRental(uint256 tokenId, address user, uint64 expires, uint16 renterBps, bool locked) external {
        _setRental(tokenId, user, expires, renterBps, locked);
    }

    function _setRental(uint256 tokenId, address user, uint64 expires, uint16 renterBps, bool locked) internal {
        address o = _requireOwned(tokenId);
        if (!_isAuthorized(o, msg.sender, tokenId)) revert NotAuthorized();
        if (renterBps > MAX_RENTER_BPS) revert BadBps();
        Rental storage r = _rentals[tokenId];
        // cannot override an active locked rental
        if (r.locked && r.expires >= block.timestamp && r.user != address(0)) revert RentalLocked();
        _rentals[tokenId] = Rental(user, expires, renterBps, locked && user != address(0));
        emit UpdateUser(tokenId, user, expires);
        emit RentalSet(tokenId, user, expires, renterBps, locked);
    }

    function userOf(uint256 tokenId) public view override returns (address) {
        Rental memory r = _rentals[tokenId];
        return (r.expires >= block.timestamp) ? r.user : address(0);
    }

    function userExpires(uint256 tokenId) external view override returns (uint256) {
        return _rentals[tokenId].expires;
    }

    function rentalOf(uint256 tokenId) external view returns (Rental memory) {
        return _rentals[tokenId];
    }

    /// @notice Who plays (energy source) and how rewards split: (operator, owner, renterBps).
    function operatorOf(uint256 tokenId) external view returns (address op, address owner_, uint16 renterBps) {
        owner_ = _requireOwned(tokenId);
        address u = userOf(tokenId);
        if (u == address(0)) return (owner_, owner_, 0);
        return (u, owner_, _rentals[tokenId].renterBps);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = _ownerOf(tokenId);
        if (from != address(0) && from != to) {
            Rental storage r = _rentals[tokenId];
            if (r.user != address(0)) {
                if (r.locked && r.expires >= block.timestamp) revert RentalLocked();
                delete _rentals[tokenId];
                emit UpdateUser(tokenId, address(0), 0);
            }
        }
        return super._update(to, tokenId, auth);
    }

    function supportsInterface(bytes4 id) public view override returns (bool) {
        return id == type(IERC4907).interfaceId || super.supportsInterface(id);
    }
}
