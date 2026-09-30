// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {Clones} from "@openzeppelin/proxy/Clones.sol";
import {RevenueSplitter} from "./RevenueSplitter.sol";

/**
 * @title RunwayVault
 * @notice Holds lender funds, manages loans, receives repayments from splitters
 */
contract RunwayVault is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant UNDERWRITER_ROLE = keccak256("UNDERWRITER_ROLE");
    bytes32 public constant WATCHER_ROLE = keccak256("WATCHER_ROLE");
    bytes32 public constant SPLITTER_ROLE = keccak256("SPLITTER_ROLE");

    struct Loan {
        address splitter;
        uint256 principal; // Principal amount (includes flat fee)
        uint256 feeBps; // Flat fee in basis points (e.g., 800 = 8%)
        uint256 shareBps; // Revenue share in basis points (e.g., 3000 = 30%)
        uint256 dueDate; // Soft due date timestamp
        uint256 repaid; // Total repaid so far
        bool delinquent; // Past due with outstanding balance
        bool flagged; // Watcher flagged for payee swap
        bytes32 rationaleHash; // Hash of underwriter rationale JSON
        bool active; // Loan is active (not fully repaid)
    }

    IERC20 public immutable usdc;
    uint256 public immutable GLOBAL_MAX; // Hard cap per agent
    uint256 public immutable STARTER_CAP; // Base allowance before revenue history
    uint256 public immutable FEE_BPS_DEFAULT; // Default flat fee (800 = 8%)
    uint256 public immutable SHARE_BPS_DEFAULT; // Default revenue share (3000 = 30%)
    uint256 public immutable DUE_DAYS_DEFAULT; // Default due date in days (30)

    Loan[] public loans;
    mapping(address => uint256) public splitterToLoanId; // splitter => loan index + 1
    mapping(address => bool) public isSplitter; // Registered splitters
    mapping(address => address) public splitterToAgent; // splitter => agent
    mapping(address => bool) public agentFlagged; // Agent flagged for payee swap
    bool public paused; // Pause new loans (not repayments)

    event LoanOpened(
        uint256 indexed loanId,
        address indexed splitter,
        uint256 principal,
        uint256 feeBps,
        uint256 shareBps,
        uint256 dueDate,
        bytes32 rationaleHash
    );
    event Repaid(uint256 indexed loanId, uint256 amount);
    event Delinquent(uint256 indexed loanId);
    event Flagged(uint256 indexed loanId, bytes32 reasonHash);
    event Paused(bool paused);
    event SplitterRegistered(address indexed splitter, address indexed agent);
    event FundsDeposited(uint256 amount);
    event FundsWithdrawn(uint256 amount);

    constructor(
        address _usdc,
        uint256 _globalMax,
        uint256 _starterCap,
        uint256 _feeBpsDefault,
        uint256 _shareBpsDefault,
        uint256 _dueDaysDefault
    ) AccessControl() ReentrancyGuard() {
        // Explicitly grant DEFAULT_ADMIN_ROLE to deployer (msg.sender)
        // This ensures the role is set even if base constructor has issues
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

        usdc = IERC20(_usdc);
        GLOBAL_MAX = _globalMax;
        STARTER_CAP = _starterCap;
        FEE_BPS_DEFAULT = _feeBpsDefault;
        SHARE_BPS_DEFAULT = _shareBpsDefault;
        DUE_DAYS_DEFAULT = _dueDaysDefault;
    }

    /**
     * @notice Open a new loan for a splitter
     * @param splitter RevenueSplitter address
     * @param principal Loan principal (includes fee)
     * @param rationaleHash Hash of underwriter rationale JSON
     * @dev Only UNDERWRITER_ROLE. Validates caps and state.
     */
    function openLoan(
        address splitter,
        uint256 principal,
        bytes32 rationaleHash
    ) external onlyRole(UNDERWRITER_ROLE) nonReentrant returns (uint256) {
        require(!paused, "Vault paused");
        require(isSplitter[splitter], "Not a registered splitter");
        require(splitterToLoanId[splitter] == 0, "Active loan exists");
        require(!_isSplitterFlagged(splitter), "Splitter flagged");

        // Calculate max allowed: min(GLOBAL_MAX, STARTER_CAP + 2 * lifetimeRevenue)
        RevenueSplitter splitterContract = RevenueSplitter(payable(splitter));
        uint256 lifetimeRevenue = splitterContract.lifetimeRevenue();
        uint256 ruleLimit = STARTER_CAP + (2 * lifetimeRevenue);
        uint256 maxAllowed = ruleLimit < GLOBAL_MAX ? ruleLimit : GLOBAL_MAX;

        require(principal <= maxAllowed, "Exceeds cap");
        require(principal > 0, "Zero principal");

        // Transfer principal to splitter (agent receives as advance)
        usdc.safeTransfer(splitter, principal);

        uint256 loanId = loans.length;
        loans.push(Loan({
            splitter: splitter,
            principal: principal,
            feeBps: FEE_BPS_DEFAULT,
            shareBps: SHARE_BPS_DEFAULT,
            dueDate: block.timestamp + (DUE_DAYS_DEFAULT * 86400),
            repaid: 0,
            delinquent: false,
            flagged: false,
            rationaleHash: rationaleHash,
            active: true
        }));

        splitterToLoanId[splitter] = loanId + 1;

        // Notify splitter that loan is active
        splitterContract.setLoanActive(true, principal);

        emit LoanOpened(loanId, splitter, principal, FEE_BPS_DEFAULT, SHARE_BPS_DEFAULT, block.timestamp + (DUE_DAYS_DEFAULT * 86400), rationaleHash);

        return loanId;
    }

    /**
     * @notice Receive repayment from splitter's settle()
     * @dev Called by splitter (has SPLITTER_ROLE). Splits repayment between fee and principal.
     */
    function repay(uint256 amount) external onlyRole(SPLITTER_ROLE) nonReentrant {
        // Find the loan for this splitter
        uint256 loanId = splitterToLoanId[msg.sender] - 1;
        require(loanId < loans.length, "No loan for splitter");
        Loan storage loan = loans[loanId];
        require(loan.active, "Loan not active");

        uint256 outstanding = loan.principal - loan.repaid;
        uint256 repayment = amount < outstanding ? amount : outstanding;

        if (repayment == 0) return;

        loan.repaid += repayment;

        // Check if fully repaid
        if (loan.repaid >= loan.principal) {
            loan.active = false;
            splitterToLoanId[msg.sender] = 0;
            RevenueSplitter(payable(msg.sender)).setLoanActive(false, 0);
        }

        emit Repaid(loanId, repayment);
    }

    /**
     * @notice Mark loan as delinquent (past due with outstanding balance)
     * @dev Permissionless. Blocks new advances for this agent.
     */
    function markDelinquent(uint256 loanId) external nonReentrant {
        require(loanId < loans.length, "Invalid loan");
        Loan storage loan = loans[loanId];
        require(loan.active, "Loan not active");
        require(block.timestamp > loan.dueDate, "Not past due");
        require(loan.repaid < loan.principal, "Fully repaid");
        require(!loan.delinquent, "Already delinquent");

        loan.delinquent = true;
        emit Delinquent(loanId);
    }

    /**
     * @notice Watcher flags a loan (payee swap detected)
     * @dev Only WATCHER_ROLE. Blocks further advances for this agent.
     */
    function flagLoan(uint256 loanId, bytes32 reasonHash) external onlyRole(WATCHER_ROLE) nonReentrant {
        require(loanId < loans.length, "Invalid loan");
        Loan storage loan = loans[loanId];
        require(loan.active, "Loan not active");
        require(!loan.flagged, "Already flagged");

        loan.flagged = true;
        address agent = splitterToAgent[loan.splitter];
        agentFlagged[agent] = true;
        emit Flagged(loanId, reasonHash);
    }

    /**
     * @notice Pause new loans (emergency)
     * @dev Owner only. Never pauses repayments or withdrawals.
     */
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        paused = true;
        emit Paused(true);
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        paused = false;
        emit Paused(false);
    }

    /**
     * @notice Deposit USDC into vault (lender adds funds)
     */
    function deposit(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        require(amount > 0, "Zero amount");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit FundsDeposited(amount);
    }

    /**
     * @notice Withdraw USDC from vault (lender removes excess funds)
     */
    function withdraw(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        require(amount > 0, "Zero amount");
        require(usdc.balanceOf(address(this)) >= amount, "Insufficient balance");
        usdc.safeTransfer(msg.sender, amount);
        emit FundsWithdrawn(amount);
    }

    /**
     * @notice Register a splitter (called by factory)
     */
    function registerSplitter(address splitter, address agent) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(!isSplitter[splitter], "Already registered");
        isSplitter[splitter] = true;
        splitterToAgent[splitter] = agent;
        // Grant SPLITTER_ROLE to the splitter contract
        _grantRole(SPLITTER_ROLE, splitter);
        emit SplitterRegistered(splitter, agent);
    }

    /**
     * @notice Get loan by ID
     */
    function getLoan(uint256 loanId) external view returns (Loan memory) {
        require(loanId < loans.length, "Invalid loan");
        return loans[loanId];
    }

    /**
     * @notice Get loan ID for a splitter
     */
    function getLoanId(address splitter) external view returns (uint256) {
        return splitterToLoanId[splitter] > 0 ? splitterToLoanId[splitter] - 1 : type(uint256).max;
    }

    /**
     * @notice Check if splitter's agent is flagged
     */
    function _isSplitterFlagged(address splitter) internal view returns (bool) {
        address agent = splitterToAgent[splitter];
        if (agent == address(0)) return false;
        return agentFlagged[agent];
    }

    /**
     * @notice Get vault USDC balance
     */
    function getBalance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /**
     * @notice Get total outstanding across all active loans
     */
    function getTotalOutstanding() external view returns (uint256) {
        uint256 total = 0;
        for (uint256 i = 0; i < loans.length; i++) {
            if (loans[i].active) {
                total += loans[i].principal - loans[i].repaid;
            }
        }
        return total;
    }

    function getLoansLength() external view returns (uint256) {
        return loans.length;
    }
}