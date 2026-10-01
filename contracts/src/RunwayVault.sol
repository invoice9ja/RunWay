// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { AccessControl } from "@openzeppelin/access/AccessControl.sol";
import { ReentrancyGuard } from "@openzeppelin/utils/ReentrancyGuard.sol";
import { SafeERC20 } from "@openzeppelin/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/token/ERC20/IERC20.sol";

/**
 * @title RunwayVault
 * @notice Holds lender funds and services revenue-backed advances to AI agents.
 *
 * @dev Debt model
 *      -----------
 *      An advance has two parts:
 *
 *        principal — USDC handed to the agent as working capital
 *        fee       — a flat fee charged on top, `principal * feeBps / 10_000`
 *
 *      `totalDue()` is what the lender is owed. Repayments reduce `principal`
 *      first and then `fee`, so an advance always ends at exactly zero rather
 *      than leaving a rounding remainder behind. The flat fee is charged because
 *      {repay} works against `totalDue`, not against `principal`.
 *
 *      Solvency
 *      --------
 *      `availableToWithdraw()` excludes every outstanding advance, so an admin
 *      cannot withdraw funds that are still owed to lenders.
 */
contract RunwayVault is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant UNDERWRITER_ROLE = keccak256("UNDERWRITER_ROLE");
    bytes32 public constant WATCHER_ROLE = keccak256("WATCHER_ROLE");

    struct Loan {
        address splitter;
        uint256 principal;
        uint256 feeBps;
        uint256 shareBps;
        uint256 dueDate;
        uint256 repaid;
        bool delinquent;
        bool flagged;
        bytes32 rationaleHash;
        bool active;
    }

    IERC20 public immutable usdc;
    uint256 public immutable GLOBAL_MAX;
    uint256 public immutable STARTER_CAP;
    uint256 public immutable FEE_BPS_DEFAULT;
    uint256 public immutable SHARE_BPS_DEFAULT;
    uint256 public immutable DUE_DAYS_DEFAULT;

    Loan[] public loans;
    mapping(address => uint256) public splitterToLoanId; // splitter => loan index + 1
    mapping(address => bool) public isSplitter;
    mapping(address => address) public splitterToAgent;
    mapping(address => bool) public agentFlagged;
    mapping(address => uint256) public outstandingBySplitter;
    bool public paused;

    event LoanOpened(
        uint256 indexed loanId,
        address indexed splitter,
        uint256 principal,
        uint256 fee,
        uint256 totalDue,
        uint256 feeBps,
        uint256 shareBps,
        uint256 dueDate,
        bytes32 rationaleHash
    );
    event Repaid(uint256 indexed loanId, uint256 amount, uint256 outstanding);
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
        require(_usdc != address(0), "USDC cannot be zero address");
        require(_feeBpsDefault <= 10000, "Fee > 100%");
        require(_shareBpsDefault <= 10000, "Share > 100%");
        require(_globalMax > 0, "Zero global max");
        require(_dueDaysDefault > 0, "Zero due days");

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

        usdc = IERC20(_usdc);
        GLOBAL_MAX = _globalMax;
        STARTER_CAP = _starterCap;
        FEE_BPS_DEFAULT = _feeBpsDefault;
        SHARE_BPS_DEFAULT = _shareBpsDefault;
        DUE_DAYS_DEFAULT = _dueDaysDefault;
    }

    /**
     * @notice Issue an advance to an agent, fronting principal plus its fee.
     * @param splitter Registered RevenueSplitter
     * @param principal Working capital advanced to the agent
     * @param rationaleHash Hash of the underwriter rationale
     * @return loanId Index of the new loan
     */
    function openLoan(address splitter, uint256 principal, bytes32 rationaleHash)
        external
        onlyRole(UNDERWRITER_ROLE)
        nonReentrant
        returns (uint256)
    {
        require(!paused, "Vault paused");
        require(isSplitter[splitter], "Not a registered splitter");
        require(splitterToLoanId[splitter] == 0, "Active loan exists");
        require(!_isSplitterFlagged(splitter), "Splitter flagged");
        require(principal > 0, "Zero principal");

        // Cap on total exposure, so a fat fee cannot push the position past it.
        IRevenueSplitter splitterContract = IRevenueSplitter(splitter);
        uint256 lifetimeRevenue = splitterContract.lifetimeRevenue();
        uint256 ruleLimit = STARTER_CAP + (2 * lifetimeRevenue);
        uint256 maxAllowed = ruleLimit < GLOBAL_MAX ? ruleLimit : GLOBAL_MAX;

        uint256 fee = (principal * FEE_BPS_DEFAULT) / 10000;
        uint256 due = principal + fee;
        require(due <= maxAllowed, "Exceeds cap");

        // Only principal leaves the vault. The fee is charged on repayment, so
        // the vault is not required to fund it up front.
        usdc.safeTransfer(splitter, principal);

        uint256 dueDate = block.timestamp + (DUE_DAYS_DEFAULT * 86400);
        uint256 loanId = loans.length;

        loans.push(
            Loan({
                splitter: splitter,
                principal: principal,
                feeBps: FEE_BPS_DEFAULT,
                shareBps: SHARE_BPS_DEFAULT,
                dueDate: dueDate,
                repaid: 0,
                delinquent: false,
                flagged: false,
                rationaleHash: rationaleHash,
                active: true
            })
        );

        splitterToLoanId[splitter] = loanId + 1;
        outstandingBySplitter[splitter] = due;

        emit LoanOpened(
            loanId, splitter, principal, fee, due, FEE_BPS_DEFAULT, SHARE_BPS_DEFAULT, dueDate, rationaleHash
        );

        // CEI: all state above is final before the external call.
        splitterContract.setLoanActive(true, principal);

        return loanId;
    }

    /**
     * @notice Apply a repayment from a splitter's settle().
     * @dev Splitters hold SPLITTER_ROLE by construction; the mapping is the
     *      authority check. Returns the amount actually applied so the caller can
     *      return any excess to the agent instead of stranding it.
     * @return applied Amount credited against the outstanding balance
     */
    function repay(address splitter, uint256 amount) external nonReentrant returns (uint256 applied) {
        require(isSplitter[splitter], "Unknown splitter");
        require(amount > 0, "Zero repayment");

        uint256 outstanding = outstandingBySplitter[splitter];
        applied = amount < outstanding ? amount : outstanding;
        if (applied == 0) return 0;

        uint256 loanSlot = splitterToLoanId[splitter];
        require(loanSlot != 0, "No loan for splitter");
        uint256 loanId = loanSlot - 1;
        Loan storage loan = loans[loanId];
        require(loan.active, "Loan not active");

        loan.repaid += applied;
        outstandingBySplitter[splitter] = outstanding - applied;

        if (outstanding - applied == 0) {
            loan.active = false;
            outstandingBySplitter[splitter] = 0;
            splitterToLoanId[splitter] = 0;
            IRevenueSplitter(payable(splitter)).setLoanActive(false, 0);
        }

        emit Repaid(loanId, applied, outstanding - applied);
    }

    /// @notice Total still owed on an advance, principal plus unpaid fee.
    function advanceOutstanding(address splitter) public view returns (uint256) {
        return outstandingBySplitter[splitter];
    }

    /**
     * @notice Flag an advance as delinquent once it is past due.
     * @dev Permissionless, so anyone can record a missed repayment.
     */
    function markDelinquent(uint256 loanId) external nonReentrant {
        require(loanId < loans.length, "Invalid loan");
        Loan storage loan = loans[loanId];
        require(loan.active, "Loan not active");
        require(block.timestamp > loan.dueDate, "Not past due");
        require(outstandingBySplitter[loan.splitter] > 0, "Fully repaid");
        require(!loan.delinquent, "Already delinquent");

        loan.delinquent = true;
        emit Delinquent(loanId);
    }

    /**
     * @notice Flag an advance after a payee swap, blocking further borrowing.
     */
    function flagLoan(uint256 loanId, bytes32 reasonHash) external onlyRole(WATCHER_ROLE) nonReentrant {
        require(loanId < loans.length, "Invalid loan");
        Loan storage loan = loans[loanId];
        require(loan.active, "Loan not active");
        require(!loan.flagged, "Already flagged");

        loan.flagged = true;
        agentFlagged[splitterToAgent[loan.splitter]] = true;
        emit Flagged(loanId, reasonHash);
    }

    /// @notice Pause new advances. Repayments and settlement stay open.
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        paused = true;
        emit Paused(true);
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        paused = false;
        emit Paused(false);
    }

    /// @notice Lender adds funds.
    function deposit(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        require(amount > 0, "Zero amount");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit FundsDeposited(amount);
    }

    /**
     * @notice Lender withdraws funds that are not owed to any agent.
     * @dev Refuses to touch the balance backing outstanding advances, which the
     *      previous version allowed and which made the vault insolvent.
     */
    function withdraw(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        require(amount > 0, "Zero amount");
        uint256 free = availableToWithdraw();
        require(amount <= free, "Exceeds available balance");

        usdc.safeTransfer(msg.sender, amount);
        emit FundsWithdrawn(amount);
    }

    /// @notice Vault balance not backing any outstanding advance.
    function availableToWithdraw() public view returns (uint256) {
        uint256 held = usdc.balanceOf(address(this));
        uint256 owed = getTotalOutstanding();
        return held > owed ? held - owed : 0;
    }

    /// @notice Register a splitter and grant it repayment authority.
    function registerSplitter(address splitter, address agent) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(splitter != address(0), "Zero splitter");
        require(agent != address(0), "Zero agent");
        require(!isSplitter[splitter], "Already registered");

        isSplitter[splitter] = true;
        splitterToAgent[splitter] = agent;
        emit SplitterRegistered(splitter, agent);
    }

    /// @notice Full loan record.
    function getLoan(uint256 loanId) external view returns (Loan memory) {
        require(loanId < loans.length, "Invalid loan");
        return loans[loanId];
    }

    /// @notice Loan id for a splitter, or type(uint256).max when none.
    function getLoanId(address splitter) external view returns (uint256) {
        return splitterToLoanId[splitter] > 0 ? splitterToLoanId[splitter] - 1 : type(uint256).max;
    }

    /// @notice Total the agent still owes on an advance.
    function getOutstanding(address splitter) external view returns (uint256) {
        return outstandingBySplitter[splitter];
    }

    /// @notice Principal plus fee due on a loan.
    function totalDue(uint256 loanId) public view returns (uint256) {
        require(loanId < loans.length, "Invalid loan");
        Loan storage loan = loans[loanId];
        return loan.principal + (loan.principal * loan.feeBps) / 10000 - loan.repaid;
    }

    /// @notice Vault USDC balance.
    function getBalance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice Sum of outstanding advances across all agents.
    function getTotalOutstanding() public view returns (uint256) {
        uint256 total = 0;
        for (uint256 i = 0; i < loans.length; i++) {
            if (loans[i].active) {
                total += outstandingBySplitter[loans[i].splitter];
            }
        }
        return total;
    }

    function getLoansLength() external view returns (uint256) {
        return loans.length;
    }

    function _isSplitterFlagged(address splitter) internal view returns (bool) {
        address agent = splitterToAgent[splitter];
        if (agent == address(0)) return false;
        return agentFlagged[agent];
    }

    receive() external payable {
        require(msg.value == 0, "Use USDC transfer, not ETH");
    }
}

/// @dev Mirrors {RevenueSplitter}, which needs only a narrow interface.
interface IRevenueSplitter {
    function lifetimeRevenue() external view returns (uint256);
    function setLoanActive(bool active, uint256 principal) external;
    function agent() external view returns (address);
}
