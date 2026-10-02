// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { AccessControl } from "@openzeppelin/access/AccessControl.sol";
import { ReentrancyGuard } from "@openzeppelin/utils/ReentrancyGuard.sol";
import { SafeERC20 } from "@openzeppelin/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/token/ERC20/IERC20.sol";

/**
 * @title RevenueSplitter
 * @notice Routes x402 revenue received by an agent: the lender share repays the
 *         outstanding advance first, the remainder belongs to the agent.
 *
 * @dev Deployed as a minimal clone by {RunwayFactory}.
 *
 *      Accounting model
 *      -----------------
 *      Two pots of USDC live in this contract:
 *
 *        1. `advanceOutstanding` — an advance issued by the vault that the agent
 *           has not yet paid back. It is held here, is withdrawable by the agent
 *           as working capital, and is reduced when revenue repays it.
 *        2. `agentClaimable` — earned agent revenue, withdrawable by the agent.
 *
 *      Every USDC unit in this contract belongs to exactly one of those two pots.
 *      That invariant is what `surplus()` reports, and the invariant suite asserts
 *      it holds across arbitrary sequences of receives, settles and withdrawals.
 *
 *      `lastSettledBalance` is the balance at the last settle, so `settle()`
 *      only ever splits revenue that arrived since. It is raised when an advance
 *      is issued and lowered when the agent withdraws, which is why a withdrawal
 *      can no longer make the next settle underflow.
 */
contract RevenueSplitter is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    address payable public vault;
    address public agent;
    address public payout;
    address public usdc;
    uint256 public shareBps;

    /// @notice Advance tokens still held here. The agent may take them at any
    ///         time; the debt itself is tracked by the vault, which is the only
    ///         authority on it. Keeping a local copy of the debt would drift.
    uint256 public advanceHeld;
    /// @notice Earned agent revenue, withdrawable.
    uint256 public agentClaimable;
    /// @notice Balance at the last settle, so only new revenue is split.
    uint256 public lastSettledBalance;
    /// @notice Total revenue ever received, for cap growth.
    uint256 public lifetimeRevenue;
    /// @notice Whether an advance is currently outstanding.
    bool public loanActive;

    event Settled(
        uint256 indexed revenue, uint256 indexed lenderShare, uint256 indexed agentShare, uint256 advanceRepaid
    );
    event Withdrawn(address indexed agent, uint256 amount);
    event PayoutChanged(address indexed oldPayout, address indexed newPayout);
    event LoanStatusChanged(bool active);
    event Initialized(address indexed agent, address indexed payout, uint256 shareBps);

    /// @dev Guards against re-initialising a clone.
    bool private _initialized;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _initialized = true;
    }

    /**
     * @notice Initialise a clone deployed by the factory.
     * @dev Uses storage rather than immutables so clones stay cheap to deploy.
     */
    function initialize(address _vault, address _agent, address _payout, address _usdc, uint256 _shareBps) external {
        require(!_initialized, "Already initialized");
        require(_vault != address(0), "Zero vault");
        require(_agent != address(0), "Zero agent");
        require(_payout != address(0), "Zero payout");
        require(_usdc != address(0), "Zero usdc");
        require(_shareBps <= 10000, "Share > 100%");

        _initialized = true;

        vault = payable(_vault);
        agent = _agent;
        payout = _payout;
        usdc = _usdc;
        shareBps = _shareBps;

        // The vault administers the splitter, because `setPayout` is gated on
        // DEFAULT_ADMIN_ROLE and the lender should be able to correct a
        // misconfigured payout while no advance is outstanding.
        _grantRole(DEFAULT_ADMIN_ROLE, _vault);
        _grantRole(VAULT_ROLE, _vault);
        _grantRole(AGENT_ROLE, _agent);

        // The agent administers its own splitter too.
        //
        // Without this the vault was the sole admin and exposes no way to
        // delegate, so nobody could ever grant or revoke a role on a splitter:
        // the agent could not move a lost key, and `payout` was fixed for the
        // life of the contract. Sharing admin is what makes the agent's key
        // recoverable, which is the whole point of a per-agent contract.
        _grantRole(DEFAULT_ADMIN_ROLE, _agent);

        emit Initialized(_agent, _payout, _shareBps);
    }

    receive() external payable {
        require(msg.value == 0, "Use USDC transfer, not ETH");
    }

    /**
     * @notice Split newly arrived revenue between the lender and the agent.
     * @dev Permissionless and idempotent. Any lender share that exceeds the
     *      outstanding advance is returned to `agentClaimable`, so no USDC is
     *      ever stranded in the contract.
     */
    function settle() external nonReentrant {
        uint256 currentBalance = IERC20(usdc).balanceOf(address(this));
        uint256 newRevenue = currentBalance > lastSettledBalance ? currentBalance - lastSettledBalance : 0;

        if (newRevenue == 0) return;

        lifetimeRevenue += newRevenue;

        // Take a lender share only while debt is genuinely outstanding, and
        // never more than the vault can apply.
        uint256 lenderShare = 0;

        uint256 owed = IRunwayVault(vault).advanceOutstanding(address(this));
        if (owed > 0) {
            uint256 wanted = (newRevenue * shareBps) / 10000;
            if (wanted > owed) wanted = owed;
            if (wanted > 0) {
                // Cap first, then move exactly that amount, so the vault can
                // never credit less than this contract sent.
                uint256 applied = IRunwayVault(vault).repay(address(this), wanted);
                require(applied == wanted, "Repay mismatch");
                IERC20(usdc).safeTransfer(vault, applied);
                lenderShare = applied;
                // Repayment is funded from incoming revenue, so advanceHeld is
                // untouched here. It only shrinks when the agent withdraws the
                // principal, which is what keeps the two pots summing to custody.
            }
        }

        // Whatever the lender did not take belongs to the agent.
        agentClaimable += newRevenue - lenderShare;

        // Baseline reflects the post-settlement balance, net of the vault pull.
        lastSettledBalance = currentBalance - lenderShare;

        emit Settled(newRevenue, lenderShare, newRevenue - lenderShare, lenderShare);
    }

    /**
     * @notice Withdraw earned revenue and any unspent advance.
     * @dev Bounded by tokens actually held, so a claim can never overdraw.
     */
    function withdraw() external onlyRole(AGENT_ROLE) nonReentrant {
        uint256 held = IERC20(usdc).balanceOf(address(this));
        uint256 owed = agentClaimable + advanceHeld;
        if (owed > held) owed = held;
        if (owed == 0) revert NothingToWithdraw();

        // Earned revenue first, then unspent working capital.
        uint256 fromClaim = agentClaimable < owed ? agentClaimable : owed;
        uint256 fromAdvance = owed - fromClaim;

        agentClaimable -= fromClaim;
        advanceHeld -= fromAdvance;
        // Whatever the agent takes is no longer settled revenue, so the baseline
        // drops by the full amount withdrawn. Deducting only the advance portion
        // left a stale baseline and made the next settle() under-count revenue.
        if (owed > lastSettledBalance) lastSettledBalance = 0;
        else lastSettledBalance -= owed;

        IERC20(usdc).safeTransfer(payout, owed);

        emit Withdrawn(agent, owed);
    }

    /**
     * @notice Update the address agent revenue is paid to.
     * @dev Blocked while an advance is outstanding so a swap cannot divert the
     *      working capital.
     */
    function setPayout(address newPayout) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(!loanActive, "Loan active: cannot change payout");
        require(newPayout != address(0), "Zero address");

        address oldPayout = payout;
        payout = newPayout;
        emit PayoutChanged(oldPayout, newPayout);
    }

    /**
     * @notice Called by the vault when an advance is issued or closed.
     * @param active Whether an advance is now outstanding
     * @param principal Advance amount issued (0 when closing)
     */
    function setLoanActive(bool active, uint256 principal) external onlyRole(VAULT_ROLE) {
        loanActive = active;
        if (active) {
            advanceHeld += principal;
            // Working capital is not revenue, so raise the baseline by it.
            lastSettledBalance += principal;
        }
        // On close, advanceHeld is deliberately left alone: the principal the
        // agent never withdrew is still theirs to take, and zeroing it here
        // would orphan those tokens in this contract.
        emit LoanStatusChanged(active);
    }

    /// @notice USDC currently held by this contract.
    function getBalance() external view returns (uint256) {
        return IERC20(usdc).balanceOf(address(this));
    }

    /// @notice Revenue received since the last settle.
    function getUnsettledRevenue() external view returns (uint256) {
        uint256 currentBalance = IERC20(usdc).balanceOf(address(this));
        return currentBalance > lastSettledBalance ? currentBalance - lastSettledBalance : 0;
    }

    /// @notice USDC the agent can withdraw: earned revenue plus unspent advance.
    function getAgentOwed() external view returns (uint256) {
        return agentClaimable + advanceHeld;
    }

    /// @notice Debt still owed to the vault on this agent's advance.
    function getDebtOwed() external view returns (uint256) {
        return IRunwayVault(vault).advanceOutstanding(address(this));
    }

    /**
     * @notice USDC held that belongs to neither pot.
     * @dev Must be zero; the invariant suite asserts this.
     */
    function surplus() external view returns (uint256) {
        uint256 held = IERC20(usdc).balanceOf(address(this));
        uint256 owed = agentClaimable + advanceHeld;
        return held > owed ? held - owed : 0;
    }
}

error NothingToWithdraw();

/// @dev Mirrors {RunwayVault}, which needs only a narrow interface.
interface IRunwayVault {
    function repay(address splitter, uint256 amount) external returns (uint256 applied);
    function advanceOutstanding(address splitter) external view returns (uint256);
}
