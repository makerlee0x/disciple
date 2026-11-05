// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Owned2Step} from "../utils/Owned2Step.sol";
import {PackedUserOperation, PostOpMode, IPaymasterV07, IEntryPointStakeV07} from "./IPaymasterV07.sol";

interface IDecimalsPm {
    function decimals() external view returns (uint8);
}

/// @title DisciplePaymaster — USDG token paymaster for EntryPoint v0.7
/// @notice Validation secures the signed maximum USDG charge BEFORE arbitrary account execution. A standing
///         allowance is required; an approval in the sponsored batch cannot authorize payment. postOp pays the
///         treasury and refunds unused collateral, including for reverted user calls. Failed transfers become
///         recipient-owned credits, not unsecured user debt. Owner pause and a global pending-exposure cap bound
///         operations whose postOp does not complete. Quotes retain the existing 193-byte wire format and domains.
/// @dev Pricing / v0.7 penalty formula adapted from Pimlico SingletonPaymasterV7 (MIT).
contract DisciplePaymaster is IPaymasterV07, Owned2Step {
    // ───────────────────────── constants / immutables ─────────────────────────
    uint256 internal constant PAYMASTER_DATA_OFFSET = 52;
    uint256 internal constant QUOTE_LENGTH = 76; // 6 + 6 + 32 + 32
    uint256 internal constant SIGNATURE_LENGTH = 65;
    uint256 public constant PAYMASTER_AND_DATA_LENGTH = PAYMASTER_DATA_OFFSET + QUOTE_LENGTH + SIGNATURE_LENGTH; // 193
    /// @notice EntryPoint v0.7 charges the paymaster 10% of unused execution gas (callGasLimit + postOpGasLimit).
    uint256 internal constant PENALTY_PERCENT = 10;
    /// @notice Max signed validity window. Validation can't read TIMESTAMP (ERC-7562); the EntryPoint enforces it.
    uint256 public constant MAX_QUOTE_WINDOW = 1 hours;
    uint256 public constant MAX_POST_OP_GAS = 200_000;
    /// @notice Floor on the op's paymasterPostOpGasLimit, covering settlement and two token transfers.
    ///         Even if settlement cannot complete, the validation precharge stays secured and consumes exposure.
    uint256 public constant MIN_PM_POST_OP_GAS_LIMIT = 100_000; // transfer to treasury + refund (F-01 precharge)
    /// @notice Domain tag of the allowance hash (keeps it distinct from the per-op quote hash).
    bytes32 public constant ALLOWANCE_TYPEHASH = keccak256("DisciplePaymaster.Allowance(v1)");
    /// @notice Domain tag of the op-bound per-op quote hash (getOpHash).
    bytes32 public constant OP_QUOTE_TYPEHASH = keccak256("DisciplePaymaster.OpQuote(v1)");

    bytes4 internal constant EXECUTE = bytes4(keccak256("execute(address,uint256,bytes)"));
    bytes4 internal constant EXECUTE_BATCH = bytes4(keccak256("executeBatch((address,uint256,bytes)[])"));
    bytes4 internal constant EXECUTE_USER_OP = 0x8dd7712f; // IAccountExecute.executeUserOp (MAv2 prefix)
    bytes4 internal constant APPROVE = 0x095ea7b3; // approve(address,uint256)
    /// @notice AUDIT Info (2026-10-24): sanity ceiling on maxCostCap, in whole USDG (scaled by decimals at construction).
    uint256 public constant MAX_COST_CAP_LIMIT_USDG = 100;

    IEntryPointStakeV07 public immutable entryPoint;
    /// @notice The only fee token.
    address public immutable usdg;
    /// @notice MAX_COST_CAP_LIMIT_USDG in USDG raw units (100 * 10**usdg.decimals()); enforced by setBounds.
    uint256 public immutable maxCostCapLimit;

    // ───────────────────────── owner-set config ─────────────────────────
    address public signer;
    address public treasury;
    /// @notice Sanity bounds on the signed rate (USDG raw units per 1e18 wei).
    uint256 public minRate;
    uint256 public maxRate;
    /// @notice Max USDG (raw) one op may be allowed to cost.
    uint256 public maxCostCap;
    /// @notice Gas billed for postOp itself (not included in postOp's actualGasCost).
    uint256 public postOpGas;

    /// @notice Outstanding precharges (already held in USDG), per sender and globally.
    mapping(address => uint256) public reservedOf;
    uint256 public exposure;
    uint256 public exposureLimit;
    bool public paused;
    /// @notice Failed treasury/refund transfers remain owned by their recipient and may be claimed later.
    mapping(address => uint256) public creditOf;
    mapping(bytes32 => uint256) public prechargeOf;

    struct Context {
        address sender;
        bytes32 userOpHash;
        uint256 rate;
        uint256 precharged;
        uint256 executionGasLimit;
        uint256 preOpGas;
    }

    event SignerSet(address indexed signer);
    event TreasurySet(address indexed treasury);
    event BoundsSet(uint256 minRate, uint256 maxRate, uint256 maxCostCap);
    event PostOpGasSet(uint256 postOpGas);
    event PausedSet(bool paused);
    event ExposureLimitSet(uint256 exposureLimit);
    event UserOperationCharged(
        bytes32 indexed userOpHash, address indexed sender, uint256 gasCostToken, uint256 debtRepaid, uint256 rate
    );
    event Precharged(bytes32 indexed userOpHash, address indexed sender, uint256 amount);
    event CreditRecorded(address indexed recipient, uint256 amount);
    event CreditClaimed(address indexed recipient, uint256 amount);

    error NotEntryPoint();
    error ZeroAddress();
    error InvalidBounds();
    error MaxCostCapAboveLimit(uint256 maxCostCap, uint256 limit);
    error PaymasterAndDataLengthInvalid();
    error QuoteWindowInvalid();
    error RateOutOfBounds(uint256 rate);
    error MaxCostAboveCap(uint256 maxTokenCost, uint256 cap);
    error MaxCostTooLow(uint256 maxTokenCost, uint256 required);
    error InsufficientUsdgBalance(uint256 balance, uint256 required);
    error InsufficientUsdgAllowance(uint256 allowance, uint256 required);
    error PostOpGasLimitTooLow(uint256 limit, uint256 min);
    error Paused();
    error ExposureLimitExceeded(uint256 exposure, uint256 limit);
    error PrechargeFailed(uint256 amount);
    error InvalidContext();

    constructor(
        address entryPoint_,
        address usdg_,
        address owner_,
        address signer_,
        address treasury_,
        uint256 minRate_,
        uint256 maxRate_,
        uint256 maxCostCap_,
        uint256 postOpGas_
    ) Owned2Step(owner_) {
        if (entryPoint_ == address(0) || usdg_ == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        entryPoint = IEntryPointStakeV07(entryPoint_);
        usdg = usdg_;
        maxCostCapLimit = MAX_COST_CAP_LIMIT_USDG * 10 ** IDecimalsPm(usdg_).decimals();
        _setSigner(signer_);
        _setTreasury(treasury_);
        _setBounds(minRate_, maxRate_, maxCostCap_);
        _setPostOpGas(postOpGas_);
        exposureLimit = maxCostCap_;
        emit ExposureLimitSet(maxCostCap_);
    }

    // ───────────────────────── EntryPoint v0.7 ─────────────────────────

    /// @inheritdoc IPaymasterV07
    /// @dev AUDIT F-01: pulls `maxTokenCost` USDG up front (standing allowance). Same-batch approve is ignored.
    function validatePaymasterUserOp(PackedUserOperation calldata op, bytes32 userOpHash, uint256 maxCost)
        external
        override
        returns (bytes memory context, uint256 validationData)
    {
        _onlyEntryPoint();
        if (paused) revert Paused();
        (uint48 validUntil, uint48 validAfter, uint256 rate, uint256 maxTokenCost, bytes calldata sig) =
            parsePaymasterAndData(op.paymasterAndData);

        address sender = op.sender;
        if (
            !_signedBySigner(getHash(sender, validUntil, validAfter, rate, maxTokenCost), sig)
                && !_signedBySigner(getOpHash(op, validUntil, validAfter, rate, maxTokenCost), sig)
        ) {
            // ERC-4337: a bad signature returns SIG_VALIDATION_FAILED (the EntryPoint rejects with AA34), no revert.
            return ("", _packValidationData(true, validUntil, validAfter));
        }

        if (validUntil <= validAfter || validUntil - validAfter > MAX_QUOTE_WINDOW) revert QuoteWindowInvalid();
        if (rate < minRate || rate > maxRate) revert RateOutOfBounds(rate);
        if (maxTokenCost > maxCostCap) revert MaxCostAboveCap(maxTokenCost, maxCostCap);

        uint256 pmPostOp = _pmPostOpGasLimit(op.paymasterAndData);
        if (pmPostOp < MIN_PM_POST_OP_GAS_LIMIT) revert PostOpGasLimitTooLow(pmPostOp, MIN_PM_POST_OP_GAS_LIMIT);

        uint256 required = tokenCost(maxCost, rate);
        if (maxTokenCost < required) revert MaxCostTooLow(maxTokenCost, required);
        uint256 nextExposure = exposure + maxTokenCost;
        if (nextExposure > exposureLimit) revert ExposureLimitExceeded(nextExposure, exposureLimit);
        if (prechargeOf[userOpHash] != 0) revert InvalidContext();

        uint256 bal = IERC20(usdg).balanceOf(sender);
        if (bal < maxTokenCost) revert InsufficientUsdgBalance(bal, maxTokenCost);
        uint256 al = IERC20(usdg).allowance(sender, address(this));
        if (al < maxTokenCost) revert InsufficientUsdgAllowance(al, maxTokenCost);
        // Never inspect callData for payment authorization: arbitrary owner execution may revoke approval,
        // drain its remaining USDG, or revert. Only tokens already held here secure this operation.
        uint256 held = IERC20(usdg).balanceOf(address(this));
        if (
            !_tryTransferFrom(sender, address(this), maxTokenCost)
                || IERC20(usdg).balanceOf(address(this)) != held + maxTokenCost
        ) revert PrechargeFailed(maxTokenCost);
        prechargeOf[userOpHash] = maxTokenCost;
        reservedOf[sender] += maxTokenCost;
        exposure = nextExposure;
        emit Precharged(userOpHash, sender, maxTokenCost);

        context = abi.encode(
            Context({
                sender: sender,
                userOpHash: userOpHash,
                rate: rate,
                precharged: maxTokenCost,
                executionGasLimit: uint128(uint256(op.accountGasLimits)) + pmPostOp,
                preOpGas: op.preVerificationGas + uint128(uint256(op.accountGasLimits) >> 128)
                    + _pmVerificationGasLimit(op.paymasterAndData)
            })
        );
        validationData = _packValidationData(false, validUntil, validAfter);
    }

    /// @inheritdoc IPaymasterV07
    /// @dev Both successful and reverted user calls pay from the validation precharge. Never pulls from the sender.
    function postOp(PostOpMode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)
        external
        override
    {
        _onlyEntryPoint();
        Context memory c = abi.decode(context, (Context));
        if (prechargeOf[c.userOpHash] != c.precharged || c.precharged == 0) revert InvalidContext();
        delete prechargeOf[c.userOpHash];
        reservedOf[c.sender] -= c.precharged;
        exposure -= c.precharged;
        uint256 penalty =
            expectedPenaltyGasCost(actualGasCost, actualUserOpFeePerGas, postOpGas, c.preOpGas, c.executionGasLimit);
        uint256 gasCost = tokenCost(actualGasCost + penalty + postOpGas * actualUserOpFeePerGas, c.rate);
        if (gasCost > c.precharged) gasCost = c.precharged;
        _payOrCredit(treasury, gasCost);
        _payOrCredit(c.sender, c.precharged - gasCost);
        emit UserOperationCharged(c.userOpHash, c.sender, gasCost, 0, c.rate);
    }

    /// @notice Anyone may retry a failed transfer, but payment always goes to the credit's owner.
    function claimCredit(address recipient) external {
        uint256 amount = creditOf[recipient];
        delete creditOf[recipient];
        if (amount != 0 && !_tryTransfer(recipient, amount)) revert PrechargeFailed(amount);
        emit CreditClaimed(recipient, amount);
    }

    // ───────────────────────── views / helpers ─────────────────────────

    /// @notice USDG raw units for `weiAmount` at `rate` (rounded up: we never sponsor dust).
    function tokenCost(uint256 weiAmount, uint256 rate) public pure returns (uint256) {
        return (weiAmount * rate + 1e18 - 1) / 1e18;
    }

    /// @notice Hash the quote signer signs (EIP-191 personal_sign over it): a per-sender allowance, valid for any op of
    ///         `sender` in [validAfter, validUntil] on this chain and this paymaster. It deliberately does NOT bind the
    ///         userOp (nonce, callData, gas): every per-op rule (cost ≤ maxTokenCost, balance, standing
    ///         allowance + precharge, rate and cap bounds, postOp gas floor) is checked on-chain in validatePaymasterUserOp.
    function getHash(address sender, uint48 validUntil, uint48 validAfter, uint256 rate, uint256 maxTokenCost)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                ALLOWANCE_TYPEHASH, sender, block.chainid, address(this), validUntil, validAfter, rate, maxTokenCost
            )
        );
    }

    /// @notice Op-bound hash for a per-op quote (pm_getPaymasterData): binds the exact userOp (nonce, initCode,
    ///         callData incl. the approve amount, account + paymaster gas limits, preVerificationGas, fees), chain and
    ///         this paymaster. Single use (the nonce), so a large per-op maxTokenCost can't be reused by other ops.
    function getOpHash(
        PackedUserOperation calldata op,
        uint48 validUntil,
        uint48 validAfter,
        uint256 rate,
        uint256 maxTokenCost
    ) public view returns (bytes32) {
        bytes32 pmGas = op.paymasterAndData.length >= PAYMASTER_DATA_OFFSET
            ? bytes32(op.paymasterAndData[20:PAYMASTER_DATA_OFFSET])
            : bytes32(0);
        bytes32 opPart = keccak256(
            abi.encode(
                op.sender,
                op.nonce,
                keccak256(op.initCode),
                keccak256(op.callData),
                op.accountGasLimits,
                pmGas,
                op.preVerificationGas,
                op.gasFees
            )
        );
        return keccak256(
            abi.encode(
                OP_QUOTE_TYPEHASH, opPart, block.chainid, address(this), validUntil, validAfter, rate, maxTokenCost
            )
        );
    }

    /// @notice Retained for quote-service wire compatibility: secured precharges are not unsecured debt.
    function owedOf(address) external pure returns (uint256) {
        return 0;
    }

    function parsePaymasterAndData(bytes calldata pmd)
        public
        pure
        returns (uint48 validUntil, uint48 validAfter, uint256 rate, uint256 maxTokenCost, bytes calldata sig)
    {
        if (pmd.length != PAYMASTER_AND_DATA_LENGTH) revert PaymasterAndDataLengthInvalid();
        uint256 p = PAYMASTER_DATA_OFFSET;
        validUntil = uint48(bytes6(pmd[p:p + 6]));
        validAfter = uint48(bytes6(pmd[p + 6:p + 12]));
        rate = uint256(bytes32(pmd[p + 12:p + 44]));
        maxTokenCost = uint256(bytes32(pmd[p + 44:p + 76]));
        sig = pmd[p + 76:];
    }

    /// @notice True if the account call's FIRST inner call is `usdg.approve(address(this), amt)` with amt ≥ `min`.
    ///         Accepts `execute` / `executeBatch`, with or without the MAv2 `executeUserOp` selector prefix.
    ///         Malformed calldata returns false (never reverts). Not used for payment authorization (AUDIT F-01):
    ///         validation requires a standing allowance and precharges before execution.
    function firstCallApproves(bytes calldata cd, uint256 min) public view returns (bool) {
        if (cd.length >= 4 && bytes4(cd[:4]) == EXECUTE_USER_OP) cd = cd[4:];
        if (cd.length < 4) return false;
        bytes4 sel = bytes4(cd[:4]);
        bytes calldata a = cd[4:];
        bytes calldata tup;
        if (sel == EXECUTE) {
            tup = a; // (address target, uint256 value, bytes data)
        } else if (sel == EXECUTE_BATCH) {
            bool ok;
            bytes calldata arr;
            (ok, arr) = _tail(a, 0); // arr = [len][off_0]...[off_n-1]...
            if (!ok || arr.length < 64 || _w(arr, 0) == 0) return false;
            bytes calldata elems = arr[32:];
            uint256 off0 = _w(elems, 0);
            if (off0 > elems.length) return false;
            tup = elems[off0:];
        } else {
            return false;
        }
        if (tup.length < 96) return false;
        uint256 target = _w(tup, 0);
        if (target != uint256(uint160(usdg))) return false;
        (bool okD, bytes calldata inner) = _bytesAt(tup, _w(tup, 64));
        if (!okD || inner.length != 68 || bytes4(inner[:4]) != APPROVE) return false;
        return _w(inner[4:], 0) == uint256(uint160(address(this))) && _w(inner[4:], 32) >= min;
    }

    function expectedPenaltyGasCost(
        uint256 actualGasCost,
        uint256 feePerGas,
        uint256 postOpGas_,
        uint256 preOpGas,
        uint256 executionGasLimit
    ) public pure returns (uint256) {
        if (feePerGas == 0) return 0;
        uint256 actualGas = actualGasCost / feePerGas + postOpGas_;
        uint256 executionGasUsed = actualGas > preOpGas ? actualGas - preOpGas : 0;
        if (executionGasLimit <= executionGasUsed) return 0;
        return ((executionGasLimit - executionGasUsed) * PENALTY_PERCENT / 100) * feePerGas;
    }

    /// @notice This paymaster's EntryPoint deposit (wei).
    function getDeposit() external view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    // ───────────────────────── deposit / stake ─────────────────────────

    /// @notice Anyone (the keeper) may top up the EntryPoint deposit.
    function deposit() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    function withdrawTo(address payable to, uint256 amount) external {
        _checkOwner();
        if (to == address(0)) revert ZeroAddress();
        entryPoint.withdrawTo(to, amount);
    }

    function addStake(uint32 unstakeDelaySec) external payable {
        _checkOwner();
        entryPoint.addStake{value: msg.value}(unstakeDelaySec);
    }

    function unlockStake() external {
        _checkOwner();
        entryPoint.unlockStake();
    }

    function withdrawStake(address payable to) external {
        _checkOwner();
        if (to == address(0)) revert ZeroAddress();
        entryPoint.withdrawStake(to);
    }

    // ───────────────────────── owner config ─────────────────────────

    function setSigner(address s) external {
        _checkOwner();
        _setSigner(s);
    }

    function setTreasury(address t) external {
        _checkOwner();
        _setTreasury(t);
    }

    function setBounds(uint256 minRate_, uint256 maxRate_, uint256 maxCostCap_) external {
        _checkOwner();
        _setBounds(minRate_, maxRate_, maxCostCap_);
    }

    function setPostOpGas(uint256 g) external {
        _checkOwner();
        _setPostOpGas(g);
    }

    function setPaused(bool p) external {
        _checkOwner();
        paused = p;
        emit PausedSet(p);
    }

    /// @notice Maximum outstanding, already-secured USDG precharges across ALL accounts (not per identity).
    function setExposureLimit(uint256 limit) external {
        _checkOwner();
        if (limit == 0) revert InvalidBounds();
        exposureLimit = limit;
        emit ExposureLimitSet(limit);
    }

    // ───────────────────────── internals ─────────────────────────

    function _signedBySigner(bytes32 hash, bytes calldata sig) internal view returns (bool) {
        (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(MessageHashUtils.toEthSignedMessageHash(hash), sig);
        return err == ECDSA.RecoverError.NoError && rec == signer;
    }

    function _onlyEntryPoint() internal view {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();
    }

    function _setSigner(address s) internal {
        if (s == address(0)) revert ZeroAddress();
        signer = s;
        emit SignerSet(s);
    }

    function _setTreasury(address t) internal {
        if (t == address(0)) revert ZeroAddress();
        treasury = t;
        emit TreasurySet(t);
    }

    function _setBounds(uint256 minRate_, uint256 maxRate_, uint256 maxCostCap_) internal {
        if (minRate_ == 0 || minRate_ > maxRate_ || maxCostCap_ == 0) revert InvalidBounds();
        if (maxCostCap_ > maxCostCapLimit) revert MaxCostCapAboveLimit(maxCostCap_, maxCostCapLimit);
        minRate = minRate_;
        maxRate = maxRate_;
        maxCostCap = maxCostCap_;
        emit BoundsSet(minRate_, maxRate_, maxCostCap_);
    }

    function _setPostOpGas(uint256 g) internal {
        if (g > MAX_POST_OP_GAS) revert InvalidBounds();
        postOpGas = g;
        emit PostOpGasSet(g);
    }

    function _tryTransferFrom(address from, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) = usdg.call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        return _transferSucceeded(ok, ret);
    }

    function _tryTransfer(address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) = usdg.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        return _transferSucceeded(ok, ret);
    }

    function _transferSucceeded(bool ok, bytes memory ret) internal pure returns (bool) {
        if (!ok) return false;
        if (ret.length == 0) return true;
        if (ret.length < 32) return false;
        uint256 result;
        assembly ("memory-safe") { result := mload(add(ret, 32)) }
        return result == 1;
    }

    function _payOrCredit(address recipient, uint256 amount) internal {
        if (amount != 0 && !_tryTransfer(recipient, amount)) {
            creditOf[recipient] += amount;
            emit CreditRecorded(recipient, amount);
        }
    }

    function _pmVerificationGasLimit(bytes calldata pmd) internal pure returns (uint256) {
        return uint128(bytes16(pmd[20:36]));
    }

    function _pmPostOpGasLimit(bytes calldata pmd) internal pure returns (uint256) {
        return uint128(bytes16(pmd[36:52]));
    }

    /// @dev ERC-4337 validationData: sigFailed | validUntil << 160 | validAfter << 208.
    function _packValidationData(bool sigFailed, uint48 validUntil, uint48 validAfter) internal pure returns (uint256) {
        return (sigFailed ? 1 : 0) | (uint256(validUntil) << 160) | (uint256(validAfter) << 208);
    }

    function _w(bytes calldata b, uint256 at) internal pure returns (uint256 v) {
        if (b.length < at + 32) return type(uint256).max; // callers treat as invalid
        v = uint256(bytes32(b[at:at + 32]));
    }

    /// @dev ABI tail at the head-word offset stored at `headAt` (relative to `b`).
    function _tail(bytes calldata b, uint256 headAt) internal pure returns (bool, bytes calldata) {
        uint256 off = _w(b, headAt);
        if (off >= b.length) return (false, b[:0]);
        return (true, b[off:]);
    }

    /// @dev Dynamic `bytes` at offset `off` (relative to `b`): [len][data].
    function _bytesAt(bytes calldata b, uint256 off) internal pure returns (bool, bytes calldata) {
        if (off > b.length || b.length - off < 32) return (false, b[:0]);
        uint256 len = uint256(bytes32(b[off:off + 32]));
        if (len > b.length - off - 32) return (false, b[:0]);
        return (true, b[off + 32:off + 32 + len]);
    }
}
