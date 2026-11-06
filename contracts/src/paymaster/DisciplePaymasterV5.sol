// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Owned2Step} from "../utils/Owned2Step.sol";
import {PackedUserOperation, PostOpMode, IPaymasterV07, IEntryPointStakeV07} from "./IPaymasterV07.sol";

/// @title DisciplePaymasterV5 — pre-funded USDG gas credit for EntryPoint v0.7
/// @notice Each player holds a USDG gas balance in THIS contract. Validation only reads and writes that ledger
///         (no token calls): an op is admitted when unreserved credit covers the signed max token cost, and that
///         amount is reserved here. postOp charges the actual gas (ceil, no markup) from the reservation and
///         releases the rest, including when the account call reverts. Player credit is not treasury revenue.
/// @dev ERC-7562: validation uses no banned opcodes and no token storage. The only external call is a pure
///      self-call that decodes calldata, plus ecrecover. Token movement happens in execution (deposit) and postOp
///      (treasury fee, withdraw). A zero-credit account may use one bounded setup op; that op's ETH is unsecured
///      if execution does not deposit. Stake is required for the paymaster's own-storage rules (STO-031).
contract DisciplePaymasterV5 is IPaymasterV07, Owned2Step {
    uint256 public constant PREPAY_VERSION = 5;
    /// @notice $2 at 6 decimals. Both supported USDG tokens (RH testnet mock and mainnet Paxos) use 6 decimals.
    uint256 public constant SETUP_DEPOSIT = 2_000_000;
    uint256 internal constant TOKEN_TRANSFER_GAS = 80_000;
    uint256 internal constant PAYMASTER_DATA_OFFSET = 52;
    uint256 internal constant QUOTE_LENGTH = 76;
    uint256 internal constant SIGNATURE_LENGTH = 65;
    uint256 public constant PAYMASTER_AND_DATA_LENGTH = PAYMASTER_DATA_OFFSET + QUOTE_LENGTH + SIGNATURE_LENGTH; // 193
    uint256 internal constant PENALTY_PERCENT = 10;
    uint256 public constant MAX_QUOTE_WINDOW = 1 hours;
    /// @notice Floor covering a treasury transfer plus a full withdraw transfer. Remeasured for v5 settlement.
    uint256 public constant MIN_PM_POST_OP_GAS_LIMIT = 150_000;
    /// @notice Default gas-unit cap for the one-time zero-credit setup op. Owner may tighten after measurement.
    uint256 public constant DEFAULT_BOOTSTRAP_GAS = 3_200_000;

    bytes32 public constant ALLOWANCE_TYPEHASH = keccak256("DisciplePaymaster.Allowance(v1)");
    bytes32 public constant LAUNCH_QUOTE_TYPEHASH = keccak256("DisciplePaymaster.LaunchQuote(v1)");
    bytes32 public constant OP_QUOTE_TYPEHASH = keccak256("DisciplePaymaster.OpQuote(v1)");

    uint8 internal constant KIND_NORMAL = 0;
    uint8 internal constant KIND_WITHDRAW = 1;
    uint8 internal constant KIND_BOOTSTRAP = 2;

    bytes4 internal constant EXECUTE = bytes4(keccak256("execute(address,uint256,bytes)"));
    bytes4 internal constant EXECUTE_BATCH = bytes4(keccak256("executeBatch((address,uint256,bytes)[])"));
    bytes4 internal constant EXECUTE_USER_OP = 0x8dd7712f;
    bytes4 internal constant APPROVE_SEL = 0x095ea7b3;
    bytes4 internal constant DEPOSIT_SEL = bytes4(keccak256("deposit(address,uint256)"));
    bytes4 internal constant WITHDRAW_SEL = bytes4(keccak256("withdraw()"));
    bytes4 internal constant INSTALL_VALIDATION = bytes4(keccak256("installValidation(bytes25,bytes4[],bytes,bytes[])"));

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    struct Context {
        address sender;
        bytes32 userOpHash;
        uint256 rate;
        uint256 reserved;
        uint256 maxTokenCost;
        uint256 executionGasLimit;
        uint256 preOpGas;
        uint48 validUntil;
        uint8 kind;
    }

    IEntryPointStakeV07 public immutable entryPoint;
    address public immutable usdg;

    address public signer;
    address public treasury;
    uint256 public minRate;
    uint256 public maxRate;
    uint256 public maxGasPerOp;
    uint256 public maxLaunchGasPerOp;
    uint256 public maxBootstrapGasPerOp;
    uint256 public postOpGas;
    bool public paused;
    bool public bootstrapCodehashEnforced;

    /// @notice Player gas credit, including amounts reserved by pending ops. Not withdrawable while reserved.
    mapping(address => uint256) public creditOf;
    /// @notice Sum of signed max-token reservations for `account`.
    mapping(address => uint256) public reservedOf;
    mapping(bytes32 => uint256) public reservationOf;
    mapping(bytes32 => bytes32) public contextHashOf;
    /// @notice One unsecured setup op has already been admitted for this account.
    mapping(address => bool) public bootstrapUsed;
    /// @notice A sponsored withdraw is in flight. Later ops from this account are refused until postOp.
    mapping(address => bool) public withdrawPending;
    /// @notice Failed outgoing transfers (treasury fees). Not player credit and not withdrawable via withdraw().
    mapping(address => uint256) public claimOf;
    mapping(bytes32 => bool) public allowedBootstrapCodehash;

    event SignerSet(address indexed signer);
    event TreasurySet(address indexed treasury);
    event BoundsSet(uint256 minRate, uint256 maxRate, uint256 maxGasPerOp);
    event LaunchGasLimitSet(uint256 maxLaunchGasPerOp);
    event BootstrapGasLimitSet(uint256 maxBootstrapGasPerOp);
    event PostOpGasSet(uint256 postOpGas);
    event PausedSet(bool paused);
    event BootstrapCodehashSet(bytes32 indexed codehash, bool allowed);
    event BootstrapCodehashEnforcedSet(bool enforced);
    event Deposited(address indexed account, address indexed payer, uint256 amount);
    event Reserved(bytes32 indexed userOpHash, address indexed sender, uint256 amount);
    event UserOperationCharged(
        bytes32 indexed userOpHash, address indexed sender, uint256 gasCostToken, uint256 debtRepaid, uint256 rate
    );
    event Withdrawn(address indexed account, uint256 amount);
    event WithdrawTransferFailed(address indexed account, uint256 amount);
    event BootstrapAdmitted(address indexed sender, bytes32 indexed userOpHash, uint256 depositAmount);
    event BootstrapUnpaid(bytes32 indexed userOpHash, address indexed sender, uint256 gasCostToken);
    event ClaimRecorded(address indexed recipient, uint256 amount);
    event ClaimPaid(address indexed recipient, uint256 amount);
    event StuckReservationSettled(bytes32 indexed userOpHash, uint256 actualWeiCost, uint256 charge);

    error NotEntryPoint();
    error ZeroAddress();
    error InvalidBounds();
    error PaymasterAndDataLengthInvalid();
    error QuoteWindowInvalid();
    error RateOutOfBounds(uint256 rate);
    error MaxCostAboveCap(uint256 maxWeiCost, uint256 cap);
    error GasLimitAboveCap(uint256 gasUnits, uint256 cap);
    error MaxCostTooLow(uint256 maxTokenCost, uint256 required);
    error InsufficientCredit(uint256 available, uint256 required);
    error PostOpGasLimitTooLow(uint256 limit, uint256 min);
    error Paused();
    error InvalidContext();
    error Pending();
    error BootstrapUnavailable();
    error BadCreditCall();
    error DepositFailed();
    error OnlyAccount();
    error TransferFailed();
    error RecoveryNotReady();
    error Reentered();
    error CodehashNotAllowed(bytes32 codehash);

    uint256 private _lock;

    modifier nonReentrant() {
        if (_lock == 1) revert Reentered();
        _lock = 1;
        _;
        _lock = 0;
    }

    constructor(
        address entryPoint_,
        address usdg_,
        address owner_,
        address signer_,
        address treasury_,
        uint256 minRate_,
        uint256 maxRate_,
        uint256 maxGasPerOp_,
        uint256 postOpGas_
    ) Owned2Step(owner_) {
        if (entryPoint_ == address(0) || usdg_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        entryPoint = IEntryPointStakeV07(entryPoint_);
        usdg = usdg_;
        _setSigner(signer_);
        _setTreasury(treasury_);
        _setBounds(minRate_, maxRate_, maxGasPerOp_);
        _setPostOpGas(postOpGas_);
        maxBootstrapGasPerOp = DEFAULT_BOOTSTRAP_GAS;
        emit BootstrapGasLimitSet(DEFAULT_BOOTSTRAP_GAS);
    }

    // ───────────────────────── funding ─────────────────────────

    /// @notice Pull `amount` USDG from the caller and credit `account`. The account funds itself from a userOp
    ///         (approve + deposit in execution). A third party may also fund `account` directly. An in-execution
    ///         deposit does not cover the reservation of the same userOp.
    function deposit(address account, uint256 amount) external nonReentrant {
        if (account == address(0) || amount == 0) revert DepositFailed();
        uint256 beforeBal = IERC20(usdg).balanceOf(address(this));
        if (!_tryTransferFrom(msg.sender, address(this), amount)) revert DepositFailed();
        uint256 got = IERC20(usdg).balanceOf(address(this)) - beforeBal;
        if (got != amount) revert DepositFailed();
        creditOf[account] += amount;
        emit Deposited(account, msg.sender, amount);
    }

    /// @notice Move `amount` of the caller's unreserved credit back to itself immediately.
    ///         A sponsored op has already reserved its gas; this cannot take that reservation, so the
    ///         following calls in the same batch can spend the returned USDG and postOp can still charge.
    function release(uint256 amount) external nonReentrant {
        address account = msg.sender;
        if (withdrawPending[account]) revert Pending();
        if (amount == 0 || amount == type(uint256).max) revert TransferFailed();
        uint256 free = creditOf[account] - reservedOf[account];
        if (amount > free) revert InsufficientCredit(free, amount);
        creditOf[account] -= amount;
        if (!_tryTransfer(account, amount)) {
            creditOf[account] += amount;
            emit WithdrawTransferFailed(account, amount);
            revert TransferFailed();
        }
        emit Withdrawn(account, amount);
    }

    /// @notice Send the caller's entire unreserved credit back to itself.
    ///         A sponsored withdraw sets `withdrawPending` in validation and pays in postOp, after gas is charged,
    ///         so this call is only the marker and does not transfer. A direct call (nothing pending) pays immediately.
    function withdraw() external nonReentrant {
        address account = msg.sender;
        if (withdrawPending[account]) return;
        if (reservedOf[account] != 0) revert Pending();
        uint256 amount = creditOf[account];
        if (amount == 0) return;
        creditOf[account] = 0;
        if (!_tryTransfer(account, amount)) {
            creditOf[account] = amount;
            emit WithdrawTransferFailed(account, amount);
            revert TransferFailed();
        }
        emit Withdrawn(account, amount);
    }

    /// @notice Retry a failed treasury (or other non-player) transfer. Payment goes only to `recipient`.
    function claim(address recipient) external nonReentrant {
        uint256 amount = claimOf[recipient];
        if (amount == 0) return;
        claimOf[recipient] = 0;
        if (!_tryTransfer(recipient, amount)) {
            claimOf[recipient] = amount;
            revert TransferFailed();
        }
        emit ClaimPaid(recipient, amount);
    }

    /// @notice Credit minus reservations. This is what the next op can lock, and what withdraw can pay
    ///         when nothing is pending (the in-flight op's own reservation is excluded until postOp).
    function availableCredit(address account) external view returns (uint256) {
        return creditOf[account] - reservedOf[account];
    }

    // ───────────────────────── EntryPoint v0.7 ─────────────────────────

    /// @inheritdoc IPaymasterV07
    function validatePaymasterUserOp(PackedUserOperation calldata op, bytes32 userOpHash, uint256 maxCost)
        external
        override
        returns (bytes memory context, uint256 validationData)
    {
        _onlyEntryPoint();
        if (paused) revert Paused();
        (uint48 validUntil, uint48 validAfter, uint256 rate, uint256 maxTokenCost, bytes calldata sig) =
            parsePaymasterAndData(op.paymasterAndData);
        if (validUntil <= validAfter || validUntil - validAfter > MAX_QUOTE_WINDOW) revert QuoteWindowInvalid();
        if (rate < minRate || rate > maxRate) revert RateOutOfBounds(rate);

        address sender = op.sender;
        bool opOk = _signedBySigner(getOpHash(op, validUntil, validAfter, rate, maxTokenCost), sig);
        bool allowOk = _signedBySigner(getHash(sender, validUntil, validAfter, rate, maxTokenCost), sig);
        bool launchOk = _signedBySigner(getLaunchOpHash(op, validUntil, validAfter, rate, maxTokenCost), sig);

        (uint8 kind, uint256 fundAmount) = _classify(op.callData, sender, maxTokenCost);
        uint256 gasCap;
        if (kind == KIND_BOOTSTRAP) {
            // The reusable allowance does not authorize the unsecured setup op. The quote is exact-op.
            if (!opOk) return ("", _packValidationData(true, validUntil, validAfter));
            gasCap = maxBootstrapGasPerOp;
            if (gasCap == 0) revert BootstrapUnavailable();
            if (bootstrapCodehashEnforced && !allowedBootstrapCodehash[sender.codehash]) {
                revert CodehashNotAllowed(sender.codehash);
            }
        } else if (launchOk) {
            gasCap = maxLaunchGasPerOp;
        } else if (opOk || allowOk) {
            gasCap = maxGasPerOp;
        } else {
            return ("", _packValidationData(true, validUntil, validAfter));
        }

        uint256 gasUnits = op.preVerificationGas + uint128(uint256(op.accountGasLimits) >> 128)
            + uint128(uint256(op.accountGasLimits)) + _pmVerificationGasLimit(op.paymasterAndData)
            + _pmPostOpGasLimit(op.paymasterAndData);
        if (gasUnits > gasCap) revert GasLimitAboveCap(gasUnits, gasCap);
        uint256 dynamicWeiCap = gasCap * uint128(uint256(op.gasFees));
        if (maxCost > dynamicWeiCap) revert MaxCostAboveCap(maxCost, dynamicWeiCap);

        uint256 pmPostOp = _pmPostOpGasLimit(op.paymasterAndData);
        if (pmPostOp < MIN_PM_POST_OP_GAS_LIMIT) revert PostOpGasLimitTooLow(pmPostOp, MIN_PM_POST_OP_GAS_LIMIT);

        uint256 required = tokenCost(maxCost, rate);
        if (maxTokenCost < required) revert MaxCostTooLow(maxTokenCost, required);
        if (contextHashOf[userOpHash] != bytes32(0) || reservationOf[userOpHash] != 0) revert InvalidContext();

        uint256 reserved;
        if (kind == KIND_BOOTSTRAP) {
            bootstrapUsed[sender] = true;
            emit BootstrapAdmitted(sender, userOpHash, fundAmount);
        } else {
            if (withdrawPending[sender]) revert Pending();
            uint256 available = creditOf[sender] - reservedOf[sender];
            if (available < maxTokenCost) revert InsufficientCredit(available, maxTokenCost);
            if (kind == KIND_WITHDRAW && reservedOf[sender] != 0) revert Pending();
            reservedOf[sender] += maxTokenCost;
            reservationOf[userOpHash] = maxTokenCost;
            reserved = maxTokenCost;
            if (kind == KIND_WITHDRAW) withdrawPending[sender] = true;
            emit Reserved(userOpHash, sender, maxTokenCost);
        }

        context = abi.encode(
            Context({
                sender: sender,
                userOpHash: userOpHash,
                rate: rate,
                reserved: reserved,
                maxTokenCost: maxTokenCost,
                executionGasLimit: uint128(uint256(op.accountGasLimits)) + pmPostOp,
                preOpGas: op.preVerificationGas + uint128(uint256(op.accountGasLimits) >> 128)
                    + _pmVerificationGasLimit(op.paymasterAndData),
                validUntil: validUntil,
                kind: kind
            })
        );
        contextHashOf[userOpHash] = keccak256(context);
        validationData = _packValidationData(false, validUntil, validAfter);
    }

    /// @inheritdoc IPaymasterV07
    /// @dev Charges credit on success and on account revert. Does not revert: a reverting postOp would roll the
    ///      charge back and leave the validation reservation stuck. Token-transfer failure becomes `claimOf`.
    function postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)
        external
        override
        nonReentrant
    {
        _onlyEntryPoint();
        Context memory c = abi.decode(context, (Context));
        bytes32 got = keccak256(context);
        if (contextHashOf[c.userOpHash] != got) revert InvalidContext();
        delete contextHashOf[c.userOpHash];

        uint256 gasCost =
            _gasTokenCost(actualGasCost, actualUserOpFeePerGas, c.preOpGas, c.executionGasLimit, c.rate);
        uint256 cap = c.kind == KIND_BOOTSTRAP ? c.maxTokenCost : c.reserved;
        if (gasCost > cap) gasCost = cap;

        if (c.kind == KIND_BOOTSTRAP) {
            if (creditOf[c.sender] >= gasCost && gasCost != 0) {
                creditOf[c.sender] -= gasCost;
                _payTreasury(gasCost);
            } else if (gasCost != 0 && creditOf[c.sender] < gasCost) {
                // Setup execution did not leave enough credit (usually the account call reverted).
                emit BootstrapUnpaid(c.userOpHash, c.sender, gasCost);
                emit UserOperationCharged(c.userOpHash, c.sender, 0, 0, c.rate);
                return;
            }
            emit UserOperationCharged(c.userOpHash, c.sender, gasCost, 0, c.rate);
            return;
        }

        if (reservationOf[c.userOpHash] != c.reserved || reservedOf[c.sender] < c.reserved) revert InvalidContext();
        delete reservationOf[c.userOpHash];
        reservedOf[c.sender] -= c.reserved;
        if (c.kind == KIND_WITHDRAW) withdrawPending[c.sender] = false;
        if (gasCost != 0) {
            creditOf[c.sender] -= gasCost;
            _payTreasury(gasCost);
        }
        if (c.kind == KIND_WITHDRAW && mode == PostOpMode.opSucceeded && reservedOf[c.sender] == 0) {
            uint256 rest = creditOf[c.sender];
            if (rest != 0) {
                creditOf[c.sender] = 0;
                if (_tryTransfer(c.sender, rest)) emit Withdrawn(c.sender, rest);
                else {
                    creditOf[c.sender] = rest;
                    emit WithdrawTransferFailed(c.sender, rest);
                }
            }
        }
        emit UserOperationCharged(c.userOpHash, c.sender, gasCost, 0, c.rate);
    }

    /// @notice Owner recovery when postOp runs out of gas. Validation reservations survive that revert; the
    ///         account execution does not. After the quote window plus one day, while paused, reconcile the
    ///         EntryPoint's actual gas cost and release the reservation. Does not sweep a withdraw.
    function settleStuck(bytes calldata context, uint256 actualWeiCost) external nonReentrant {
        _checkOwner();
        Context memory c = abi.decode(context, (Context));
        if (contextHashOf[c.userOpHash] != keccak256(context)) revert InvalidContext();
        if (!paused || block.timestamp <= uint256(c.validUntil) + 1 days) revert RecoveryNotReady();
        delete contextHashOf[c.userOpHash];
        uint256 charge = tokenCost(actualWeiCost, c.rate);
        if (c.kind == KIND_BOOTSTRAP) {
            if (charge > c.maxTokenCost) revert MaxCostTooLow(c.maxTokenCost, charge);
            if (creditOf[c.sender] >= charge && charge != 0) {
                creditOf[c.sender] -= charge;
                _payTreasury(charge);
            } else if (charge != 0) {
                emit BootstrapUnpaid(c.userOpHash, c.sender, charge);
                charge = 0;
            }
        } else {
            if (reservationOf[c.userOpHash] != c.reserved) revert InvalidContext();
            if (charge > c.reserved) revert MaxCostTooLow(c.reserved, charge);
            delete reservationOf[c.userOpHash];
            reservedOf[c.sender] -= c.reserved;
            if (c.kind == KIND_WITHDRAW) withdrawPending[c.sender] = false;
            if (charge != 0) {
                creditOf[c.sender] -= charge;
                _payTreasury(charge);
            }
        }
        emit StuckReservationSettled(c.userOpHash, actualWeiCost, charge);
        emit UserOperationCharged(c.userOpHash, c.sender, charge, 0, c.rate);
    }

    // ───────────────────────── views ─────────────────────────

    function tokenCost(uint256 weiAmount, uint256 rate) public pure returns (uint256) {
        return (weiAmount * rate + 1e18 - 1) / 1e18;
    }

    function owedOf(address) external pure returns (uint256) {
        return 0;
    }

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

    function getOpHash(
        PackedUserOperation calldata op,
        uint48 validUntil,
        uint48 validAfter,
        uint256 rate,
        uint256 maxTokenCost
    ) public view returns (bytes32) {
        return _getOpHash(op, validUntil, validAfter, rate, maxTokenCost, OP_QUOTE_TYPEHASH);
    }

    function getLaunchOpHash(
        PackedUserOperation calldata op,
        uint48 validUntil,
        uint48 validAfter,
        uint256 rate,
        uint256 maxTokenCost
    ) public view returns (bytes32) {
        return _getOpHash(op, validUntil, validAfter, rate, maxTokenCost, LAUNCH_QUOTE_TYPEHASH);
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

    function getDeposit() external view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    /// @notice Pure calldata decode used by validation via a self-call so a malformed op returns "not a batch"
    ///         instead of aborting the paymaster with an ABI panic. No storage, no token, no value.
    function decodeCalls(bytes calldata cd) external view returns (Call[] memory calls) {
        if (msg.sender != address(this)) revert OnlyAccount();
        if (cd.length >= 4 && bytes4(cd[:4]) == EXECUTE_USER_OP) cd = cd[4:];
        if (cd.length < 4) revert BadCreditCall();
        bytes4 sel = bytes4(cd[:4]);
        if (sel == EXECUTE) {
            (address t, uint256 v, bytes memory d) = abi.decode(cd[4:], (address, uint256, bytes));
            calls = new Call[](1);
            calls[0] = Call(t, v, d);
        } else if (sel == EXECUTE_BATCH) {
            calls = abi.decode(cd[4:], (Call[]));
        } else {
            revert BadCreditCall();
        }
    }

    // ───────────────────────── deposit / stake ─────────────────────────

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

    function setBounds(uint256 minRate_, uint256 maxRate_, uint256 maxGasPerOp_) external {
        _checkOwner();
        _setBounds(minRate_, maxRate_, maxGasPerOp_);
    }

    function setLaunchGasLimit(uint256 gasUnits) external {
        _checkOwner();
        maxLaunchGasPerOp = gasUnits;
        emit LaunchGasLimitSet(gasUnits);
    }

    function setBootstrapGasLimit(uint256 gasUnits) external {
        _checkOwner();
        maxBootstrapGasPerOp = gasUnits;
        emit BootstrapGasLimitSet(gasUnits);
    }

    function setBootstrapCodehash(bytes32 codehash, bool allowed) external {
        _checkOwner();
        allowedBootstrapCodehash[codehash] = allowed;
        emit BootstrapCodehashSet(codehash, allowed);
    }

    function setBootstrapCodehashEnforced(bool enforced) external {
        _checkOwner();
        bootstrapCodehashEnforced = enforced;
        emit BootstrapCodehashEnforcedSet(enforced);
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

    // ───────────────────────── internals ─────────────────────────

    function _classify(bytes calldata cd, address sender, uint256 maxTokenCost) internal returns (uint8 kind, uint256 depositAmt) {
        (bool ok, Call[] memory calls) = _tryCalls(cd);
        if (!ok) return (KIND_NORMAL, 0);
        (uint8 shape, uint256 dep) = _shape(calls, sender);
        if (shape == 3) revert BadCreditCall();
        if (shape == KIND_WITHDRAW) return (KIND_WITHDRAW, 0);
        if (
            shape == KIND_BOOTSTRAP && creditOf[sender] == 0 && reservedOf[sender] == 0 && !bootstrapUsed[sender]
                && dep >= SETUP_DEPOSIT && dep >= maxTokenCost && maxBootstrapGasPerOp != 0
        ) {
            return (KIND_BOOTSTRAP, dep);
        }
        return (KIND_NORMAL, dep);
    }

    /// @dev shape 0 = ordinary calls, 1 = withdraw only, 2 = setup/top-up funding shape, 3 = invalid credit call.
    function _shape(Call[] memory calls, address sender) internal view returns (uint8 shape, uint256 depositAmt) {
        if (calls.length == 1 && calls[0].target == address(this) && calls[0].value == 0 && calls[0].data.length >= 4
            && bytes4(calls[0].data) == WITHDRAW_SEL) {
            if (calls[0].data.length != 4) return (3, 0);
            return (KIND_WITHDRAW, 0);
        }
        uint256 approveAmt;
        uint256 deposits;
        uint256 approveN;
        uint256 depositN;
        bool other;
        bool sawWithdraw;
        for (uint256 i; i < calls.length; ++i) {
            Call memory k = calls[i];
            if (k.data.length < 4) return (3, 0);
            bytes4 sel = bytes4(k.data);
            if (k.target == usdg && sel == APPROVE_SEL) {
                if (k.value != 0 || k.data.length != 68) return (3, 0);
                (address spender, uint256 amt) = abi.decode(_args(k.data), (address, uint256));
                if (spender != address(this)) {
                    other = true;
                    continue;
                }
                if (amt == type(uint256).max) return (3, 0);
                if (amt == 0) continue; // revoke is not a funding leg
                approveN++;
                approveAmt += amt;
            } else if (k.target == address(this) && sel == DEPOSIT_SEL) {
                if (k.value != 0 || k.data.length != 68) return (3, 0);
                (address account, uint256 amt) = abi.decode(_args(k.data), (address, uint256));
                if (account != sender || amt == 0 || amt == type(uint256).max) return (3, 0);
                depositN++;
                deposits += amt;
            } else if (k.target == address(this) && sel == WITHDRAW_SEL) {
                sawWithdraw = true;
            } else if (k.target == sender && k.value == 0 && sel == INSTALL_VALIDATION) {
                // session install may ride in the setup batch
            } else {
                other = true;
            }
        }
        if (sawWithdraw) return (3, 0);
        if (approveN == 0 && depositN == 0) return (KIND_NORMAL, 0);
        if (approveN != 1 || depositN != 1 || approveAmt != deposits) return (3, 0);
        if (other) return (KIND_NORMAL, deposits); // top-up beside a trade; still exact approve == deposit
        return (KIND_BOOTSTRAP, deposits); // funding shape; caller decides if it is the one-time setup
    }

    function _tryCalls(bytes calldata cd) internal view returns (bool ok, Call[] memory calls) {
        try this.decodeCalls(cd) returns (Call[] memory c) {
            return (true, c);
        } catch {
            return (false, calls);
        }
    }

    function _gasTokenCost(
        uint256 actualGasCost,
        uint256 fee,
        uint256 preOpGas,
        uint256 executionGasLimit,
        uint256 rate
    ) internal view returns (uint256) {
        uint256 penalty = expectedPenaltyGasCost(actualGasCost, fee, postOpGas, preOpGas, executionGasLimit);
        return tokenCost(actualGasCost + penalty + postOpGas * fee, rate);
    }

    function _payTreasury(uint256 amount) internal {
        if (amount == 0) return;
        if (_tryTransfer(treasury, amount)) return;
        claimOf[treasury] += amount;
        emit ClaimRecorded(treasury, amount);
    }

    function _getOpHash(
        PackedUserOperation calldata op,
        uint48 validUntil,
        uint48 validAfter,
        uint256 rate,
        uint256 maxTokenCost,
        bytes32 domain
    ) internal view returns (bytes32) {
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
            abi.encode(domain, opPart, block.chainid, address(this), validUntil, validAfter, rate, maxTokenCost)
        );
    }

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

    function _setBounds(uint256 minRate_, uint256 maxRate_, uint256 maxGasPerOp_) internal {
        if (minRate_ == 0 || minRate_ > maxRate_ || maxGasPerOp_ == 0) revert InvalidBounds();
        minRate = minRate_;
        maxRate = maxRate_;
        maxGasPerOp = maxGasPerOp_;
        emit BoundsSet(minRate_, maxRate_, maxGasPerOp_);
    }

    function _setPostOpGas(uint256 g) internal {
        if (g > maxGasPerOp) revert InvalidBounds();
        postOpGas = g;
        emit PostOpGasSet(g);
    }

    function _tryTransferFrom(address from, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) = usdg.call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        return _transferSucceeded(ok, ret);
    }

    function _tryTransfer(address to, uint256 amount) internal returns (bool) {
        bytes memory data = abi.encodeCall(IERC20.transfer, (to, amount));
        address token = usdg;
        uint256 limit = TOKEN_TRANSFER_GAS;
        bool ok;
        uint256 result;
        uint256 length;
        assembly ("memory-safe") {
            let out := mload(0x40)
            mstore(out, 0)
            ok := call(limit, token, 0, add(data, 32), mload(data), out, 32)
            length := returndatasize()
            result := mload(out)
        }
        return ok && (length == 0 || (length >= 32 && result == 1));
    }

    function _transferSucceeded(bool ok, bytes memory ret) internal pure returns (bool) {
        if (!ok) return false;
        if (ret.length == 0) return true;
        if (ret.length < 32) return false;
        uint256 result;
        assembly ("memory-safe") {
            result := mload(add(ret, 32))
        }
        return result == 1;
    }

    function _pmVerificationGasLimit(bytes calldata pmd) internal pure returns (uint256) {
        return uint128(bytes16(pmd[20:36]));
    }

    function _pmPostOpGasLimit(bytes calldata pmd) internal pure returns (uint256) {
        return uint128(bytes16(pmd[36:52]));
    }

    function _packValidationData(bool sigFailed, uint48 validUntil, uint48 validAfter) internal pure returns (uint256) {
        return (sigFailed ? 1 : 0) | (uint256(validUntil) << 160) | (uint256(validAfter) << 208);
    }

    function _args(bytes memory d) internal pure returns (bytes memory a) {
        a = new bytes(d.length - 4);
        for (uint256 i; i < a.length; ++i) a[i] = d[i + 4];
    }
}
