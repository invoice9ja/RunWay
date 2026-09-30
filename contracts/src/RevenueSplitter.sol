// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {RunwayVault} from "./RunwayVault.sol";

/**
 * @title RevenueSplitter
 * @notice Minimal clone contract that receives x402 revenue and splits it between lender and agent
 * @dev Deployed via RunwayFactory. Uses Clones for gas efficiency.
 */
contract RevenueSplitter is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    address payable public immutable vault;
    address public immutable agent;
    address public payout; // Where agent withdraws to
    address public immutable usdc; // USDC token address
    uint256 public immutable shareBps; // Lender share in basis points (e.g., 3000 = 30%)
    uint256 public agentClaimable; // Accrued agent share available for withdrawal (revenue share + loan principal)
    uint256 public lastSettledBalance; // USDC balance at last settle()
    uint256 public lifetimeRevenue; // Total revenue ever received
    bool public loanActive; // Whether a loan is currently outstanding

    event Settled(uint256 indexed revenue, uint256 indexed lenderShare, uint256 indexed agentShare);
    event Withdrawn(address indexed agent, uint256 amount);
    event PayoutChanged(address indexed oldPayout, address indexed newPayout);
    event LoanStatusChanged(bool active);

    constructor(
        address _vault,
        address _agent,
        address _payout,
        address _usdc,
        uint256 _shareBps
    ) AccessControl() ReentrancyGuard() {
        _grantRole(DEFAULT_ADMIN_ROLE, payable(_vault));
        _grantRole(VAULT_ROLE, payable(_vault));
        _grantRole(AGENT_ROLE, _agent);
        vault = payable(_vault);
        agent = _agent;
        payout = _payout;
        usdc = _usdc;
        shareBps = _shareBps;
    }

    /**
     * @notice Receive USDC revenue from x402 payments
     */
    receive() external payable {
        // Only accept USDC (non-zero amount)
        require(msg.value == 0, "Use USDC transfer, not ETH");
    }

    /**
     * @notice Settle new revenue - split between vault and agent
     * @dev Permissionless, idempotent. Only processes new revenue since last settle.
     */
    function settle() external nonReentrant {
        uint256 currentBalance = IERC20(usdc).balanceOf(address(this));
        uint256 newRevenue = currentBalance - lastSettledBalance;

        if (newRevenue == 0) {
            return; // Idempotent: no new revenue
        }

        lifetimeRevenue += newRevenue;

        uint256 lenderShare;
        if (loanActive) {
            // Calculate lender share of new revenue
            lenderShare = (newRevenue * shareBps) / 10000;
            // Cap at outstanding debt (vault will track actual outstanding)
            // We transfer what we calculate; vault's repay() will handle capping
        } else {
            lenderShare = 0;
        }

        uint256 agentShare = newRevenue - lenderShare;

        // Update last settled balance to balance after lender share transfer
        // This ensures idempotency: next settle will only see new revenue
        lastSettledBalance = currentBalance - lenderShare;
        agentClaimable += agentShare;

        // Transfer lender share to vault and notify vault of repayment
        if (lenderShare > 0) {
            IERC20(usdc).safeTransfer(vault, lenderShare);
            RunwayVault(vault).repay(lenderShare);
        }

        emit Settled(newRevenue, lenderShare, agentShare);
    }

    /**
     * @notice Agent withdraws their claimable share
     * @dev Pull-based: agent controls when to withdraw. Payout address can be changed.
     */
    function withdraw() external onlyRole(AGENT_ROLE) nonReentrant {
        uint256 amount = agentClaimable;
        require(amount > 0, "Nothing to withdraw");

        agentClaimable = 0;
        IERC20(usdc).safeTransfer(payout, amount);

        emit Withdrawn(agent, amount);
    }

    /**
     * @notice Update payout address (blocked while loan is active)
     */
    function setPayout(address newPayout) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(!loanActive, "Loan active: cannot change payout");
        require(newPayout != address(0), "Zero address");

        address oldPayout = payout;
        payout = newPayout;
        emit PayoutChanged(oldPayout, newPayout);
    }

    /**
     * @notice Called by vault when loan is opened
     * @param principal Loan principal amount to make available to agent
     */
    function setLoanActive(bool active, uint256 principal) external onlyRole(VAULT_ROLE) {
        loanActive = active;
        if (active && principal > 0) {
            agentClaimable += principal;
            lastSettledBalance = principal; // Initialize so loan principal isn't counted as revenue
        }
        emit LoanStatusChanged(active);
    }

    /**
     * @notice Get current USDC balance
     */
    function getBalance() external view returns (uint256) {
        return IERC20(usdc).balanceOf(address(this));
    }

    /**
     * @notice Get unsettled revenue (since last settle)
     */
    function getUnsettledRevenue() external view returns (uint256) {
        uint256 currentBalance = IERC20(usdc).balanceOf(address(this));
        return currentBalance > lastSettledBalance ? currentBalance - lastSettledBalance : 0;
    }
}