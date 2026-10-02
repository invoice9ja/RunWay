// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test, console } from "forge-std/Test.sol";
import { RunwayVault } from "../src/RunwayVault.sol";
import { RunwayFactory } from "../src/RunwayFactory.sol";
import { RevenueSplitter } from "../src/RevenueSplitter.sol";
import { IERC20 } from "@openzeppelin/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/token/ERC20/utils/SafeERC20.sol";
import { ERC20 } from "@openzeppelin/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {
        _mint(msg.sender, 1_000_000_000 * 1e6);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract RunwayTest is Test {
    using SafeERC20 for IERC20;

    address admin = address(0x1);
    address underwriter = address(0x2);
    address watcher = address(0x3);
    address agent1 = address(0x10);
    address agent2 = address(0x11);
    address buyer1 = address(0x100);
    address buyer2 = address(0x101);
    address lender = address(0x1000);

    RunwayVault vault;
    RunwayFactory factory;
    RevenueSplitter splitter1;

    uint256 constant GLOBAL_MAX = 10_000 * 1e6;
    uint256 constant STARTER_CAP = 500 * 1e6;
    uint256 constant FEE_BPS = 800;
    uint256 constant SHARE_BPS = 3000;
    uint256 constant DUE_DAYS = 30;
    uint256 constant DEFAULT_SHARE_BPS = 3000;

    MockERC20 usdc;

    function setUp() public {
        vm.label(admin, "admin");
        vm.label(underwriter, "underwriter");
        vm.label(watcher, "watcher");
        vm.label(agent1, "agent1");
        vm.label(agent2, "agent2");
        vm.label(buyer1, "buyer1");
        vm.label(buyer2, "buyer2");
        vm.label(lender, "lender");

        usdc = new MockERC20();

        vault = new RunwayVault(address(usdc), GLOBAL_MAX, STARTER_CAP, FEE_BPS, SHARE_BPS, DUE_DAYS);
        vault.grantRole(vault.DEFAULT_ADMIN_ROLE(), admin);

        // Implementation is left uninitialised; clones do the real setup.
        RevenueSplitter splitterImpl = new RevenueSplitter();

        factory = new RunwayFactory();
        factory.initialize(address(vault), address(splitterImpl), address(usdc), DEFAULT_SHARE_BPS);

        vm.startPrank(admin);
        vault.grantRole(vault.UNDERWRITER_ROLE(), underwriter);
        vault.grantRole(vault.WATCHER_ROLE(), watcher);
        vault.grantRole(vault.DEFAULT_ADMIN_ROLE(), address(factory));
        vm.stopPrank();

        factory.grantRole(factory.DEFAULT_ADMIN_ROLE(), admin);

        usdc.mint(lender, 1_000_000 * 1e6);
        usdc.mint(admin, 100_000 * 1e6);
        vm.startPrank(admin);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(50_000 * 1e6);
        vm.stopPrank();

        usdc.mint(buyer1, 10_000 * 1e6);
        usdc.mint(buyer2, 10_000 * 1e6);
        usdc.mint(agent1, 1000 * 1e6);
        usdc.mint(agent2, 1000 * 1e6);
    }

    function _newSplitter(address agent) internal returns (RevenueSplitter) {
        vm.prank(admin);
        address addr = factory.createSplitter(agent, agent);
        return RevenueSplitter(payable(addr));
    }

    function _pay(RevenueSplitter splitter, uint256 amount) internal {
        vm.prank(buyer1);
        IERC20(usdc).safeTransfer(address(splitter), amount);
    }

    function _openLoan(RevenueSplitter splitter, uint256 principal) internal returns (uint256) {
        vm.prank(underwriter);
        return vault.openLoan(address(splitter), principal, keccak256("test rationale"));
    }

    // -----------------------------------------------------------------------
    // deployment
    // -----------------------------------------------------------------------

    function test_DeployAndCreateSplitter() public {
        splitter1 = _newSplitter(agent1);

        assertEq(factory.getVault(), address(vault));
        assertTrue(vault.isSplitter(address(splitter1)));
        assertEq(splitter1.agent(), agent1);
        assertEq(splitter1.vault(), address(vault));
        assertEq(splitter1.shareBps(), DEFAULT_SHARE_BPS);
        assertEq(splitter1.usdc(), address(usdc));
    }

    function test_FactoryDeploysMinimalClones() public {
        splitter1 = _newSplitter(agent1);
        address clone = address(splitter1);
        address impl = factory.splitterImplementation();

        // A clone's runtime code is the proxy, so it must differ from the impl.
        assertTrue(clone != impl, "clone must not be the implementation");
        assertEq(clone.code.length, 45, "minimal clone runtime is 45 bytes");

        // Two agents get independent storage.
        RevenueSplitter second = _newSplitter(agent2);
        assertTrue(address(second) != clone);
        assertEq(second.agent(), agent2);
        assertEq(splitter1.agent(), agent1);

        // Implementation itself is never initialised as a live splitter.
        assertEq(impl.code.length > 1000, true);
    }

    function test_CloneCannotBeReinitialised() public {
        splitter1 = _newSplitter(agent1);
        vm.expectRevert("Already initialized");
        splitter1.initialize(address(vault), agent2, agent2, address(usdc), SHARE_BPS);
    }

    // -----------------------------------------------------------------------
    // loan issuance
    // -----------------------------------------------------------------------

    function test_OpenLoan() public {
        splitter1 = _newSplitter(agent1);
        uint256 loanId = _openLoan(splitter1, 400 * 1e6);

        assertEq(loanId, 0);
        RunwayVault.Loan memory loan = vault.getLoan(0);
        assertEq(loan.splitter, address(splitter1));
        assertEq(loan.principal, 400 * 1e6);
        assertEq(loan.feeBps, FEE_BPS);
        assertEq(loan.shareBps, SHARE_BPS);
        assertTrue(loan.active);
        assertFalse(loan.delinquent);
        assertFalse(loan.flagged);

        // Working capital is tracked separately from earned revenue, and the
        // vault records debt as principal plus the 8% fee.
        assertEq(splitter1.advanceHeld(), 400 * 1e6);
        assertEq(splitter1.agentClaimable(), 0);
        assertEq(splitter1.getDebtOwed(), 432 * 1e6);
    }

    function test_LoanCapEnforcement() public {
        splitter1 = _newSplitter(agent1);
        vm.prank(underwriter);
        vm.expectRevert("Exceeds cap");
        vault.openLoan(address(splitter1), GLOBAL_MAX + 1, keccak256("test"));
    }

    function test_FeeCountsAgainstTheCap() public {
        splitter1 = _newSplitter(agent1);
        // Cap is STARTER_CAP = 500 total exposure including the fee.
        // 495 principal + 39.6 fee = 534.6 > 500, so this must fail.
        vm.prank(underwriter);
        vm.expectRevert("Exceeds cap");
        vault.openLoan(address(splitter1), 495 * 1e6, keccak256("test"));
    }

    // -----------------------------------------------------------------------
    // the flat fee regression
    // -----------------------------------------------------------------------

    function test_FlatFeeIsActuallyCharged() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 400 * 1e6);

        // Principal 400 + 8% fee = 432 total owed.
        assertEq(vault.advanceOutstanding(address(splitter1)), 432 * 1e6);
        assertEq(vault.totalDue(0), 432 * 1e6);

        // Repay the whole thing and confirm the fee was collected.
        _pay(splitter1, 2000 * 1e6);
        splitter1.settle();

        RunwayVault.Loan memory loan = vault.getLoan(0);
        assertEq(loan.repaid, 432 * 1e6, "repaid must include the fee");
        assertEq(loan.repaid, loan.principal + (loan.principal * FEE_BPS) / 10000);
        assertFalse(loan.active);
        assertEq(vault.advanceOutstanding(address(splitter1)), 0);
    }

    function test_FeeIsChargedEvenOnTinyAdvances() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 100 * 1e6);

        // 100 + 8 = 108
        assertEq(vault.advanceOutstanding(address(splitter1)), 108 * 1e6);

        _pay(splitter1, 400 * 1e6);
        splitter1.settle();
        assertEq(vault.getLoan(0).repaid, 108 * 1e6);
    }

    // -----------------------------------------------------------------------
    // settlement
    // -----------------------------------------------------------------------

    function test_SettleAndRepay() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 400 * 1e6);

        _pay(splitter1, 100 * 1e6);
        splitter1.settle();

        // 30% of 100 repays the loan.
        assertEq(vault.getLoan(0).repaid, 30 * 1e6);
        // 432 owed, 30 repaid, 402 still outstanding to the vault.
        assertEq(vault.advanceOutstanding(address(splitter1)), 402 * 1e6);
        // Agent earns the other 70%.
        assertEq(splitter1.agentClaimable(), 70 * 1e6);
        assertEq(splitter1.lifetimeRevenue(), 100 * 1e6);
    }

    function test_SettleIdempotent() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 400 * 1e6);

        _pay(splitter1, 100 * 1e6);
        splitter1.settle();
        uint256 claimable1 = splitter1.agentClaimable();
        uint256 repaid1 = vault.getLoan(0).repaid;

        splitter1.settle();
        assertEq(splitter1.agentClaimable(), claimable1);
        assertEq(vault.getLoan(0).repaid, repaid1);

        _pay(splitter1, 50 * 1e6);
        splitter1.settle();
        assertEq(splitter1.agentClaimable(), claimable1 + 35 * 1e6);
        assertEq(vault.getLoan(0).repaid, repaid1 + 15 * 1e6);
    }

    function test_LenderShareCappedAtOutstanding() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 100 * 1e6); // 108 owed

        // 30% of 1000 = 300 wanted, but only 108 is outstanding.
        _pay(splitter1, 1000 * 1e6);
        splitter1.settle();

        assertEq(vault.getLoan(0).repaid, 108 * 1e6);
        assertFalse(vault.getLoan(0).active);

        // Nothing stranded: every unit is the agent's once the loan closes.
        assertEq(splitter1.surplus(), 0);
        assertEq(splitter1.getAgentOwed(), splitter1.getBalance());
    }

    function test_ExcessLenderShareReturnsToAgent() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 100 * 1e6); // 108 owed

        // First settle closes the loan and keeps the remainder with the agent.
        _pay(splitter1, 1000 * 1e6);
        splitter1.settle();

        // 1000 revenue, 108 repaid, 892 agent.
        assertEq(splitter1.agentClaimable(), 892 * 1e6);
        assertEq(splitter1.surplus(), 0);

        // Later revenue has no loan, so all of it is the agent's.
        _pay(splitter1, 50 * 1e6);
        splitter1.settle();
        assertEq(splitter1.agentClaimable(), 942 * 1e6);
        assertEq(splitter1.surplus(), 0);
    }

    // -----------------------------------------------------------------------
    // the custody regression
    // -----------------------------------------------------------------------

    function test_AgentClaimNeverExceedsCustody() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 400 * 1e6);

        for (uint256 i = 0; i < 10; i++) {
            _pay(splitter1, 137 * 1e6);
            splitter1.settle();

            assertLe(splitter1.getAgentOwed(), splitter1.getBalance(), "agent owed must never exceed tokens held");
            assertEq(splitter1.surplus(), 0, "no USDC may be stranded");
        }
    }

    function test_WithdrawDrainsEverythingOwed() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 400 * 1e6);
        _pay(splitter1, 2000 * 1e6);
        splitter1.settle();

        uint256 owed = splitter1.getAgentOwed();
        vm.prank(agent1);
        splitter1.withdraw();

        assertEq(splitter1.agentClaimable(), 0);
        assertEq(vault.advanceOutstanding(address(splitter1)), 0);
        assertEq(splitter1.getBalance(), 0);
        assertEq(IERC20(usdc).balanceOf(agent1), 1000 * 1e6 + owed);
    }

    function test_WithdrawNeverOverdraws() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 400 * 1e6);
        _pay(splitter1, 100 * 1e6);
        splitter1.settle();

        uint256 held = splitter1.getBalance();
        vm.prank(agent1);
        splitter1.withdraw();

        assertEq(splitter1.getBalance(), 0);
        assertEq(IERC20(usdc).balanceOf(agent1), 1000 * 1e6 + held);
    }

    // -----------------------------------------------------------------------
    // the settle underflow regression
    // -----------------------------------------------------------------------

    function test_SettleDoesNotUnderflowAfterWithdrawal() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 400 * 1e6);

        // Agent pulls the advance out before any revenue arrives, which used to
        // drop the balance below lastSettledBalance and revert the next settle.
        vm.prank(agent1);
        splitter1.withdraw();
        assertEq(splitter1.getBalance(), 0);

        _pay(splitter1, 300 * 1e6);
        splitter1.settle();

        assertEq(splitter1.lifetimeRevenue(), 300 * 1e6);
        assertEq(vault.getLoan(0).repaid, 90 * 1e6);
        assertEq(splitter1.agentClaimable(), 210 * 1e6);
    }

    function test_RepeatedWithdrawSettleCycles() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 400 * 1e6);

        for (uint256 i = 0; i < 5; i++) {
            _pay(splitter1, 250 * 1e6);
            splitter1.settle();
            vm.prank(agent1);
            splitter1.withdraw();
            assertEq(splitter1.getBalance(), 0);
        }
        assertEq(splitter1.surplus(), 0);
    }

    // -----------------------------------------------------------------------
    // the vault solvency regression
    // -----------------------------------------------------------------------

    function test_AdminCannotWithdrawFundsOwedToLender() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 400 * 1e6);

        // Vault holds 50k, 432 of it is owed.
        uint256 available = vault.availableToWithdraw();
        assertEq(available, vault.getBalance() - vault.advanceOutstanding(address(splitter1)));

        vm.prank(admin);
        vm.expectRevert("Exceeds available balance");
        vault.withdraw(available + 1);
    }

    function test_AdminCanWithdrawFreeBalance() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 400 * 1e6);

        uint256 available = vault.availableToWithdraw();
        vm.prank(admin);
        vault.withdraw(available);

        assertEq(vault.getBalance(), vault.getTotalOutstanding());
        assertEq(vault.availableToWithdraw(), 0);
    }

    function test_VaultStaysSolventThroughFullRepayment() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 400 * 1e6);

        uint256 vaultAfterDeposit = vault.getBalance();

        _pay(splitter1, 2000 * 1e6);
        splitter1.settle();

        // Every unit the vault received is accounted for.
        assertEq(vault.getBalance() - vaultAfterDeposit, 432 * 1e6);
        assertEq(vault.getTotalOutstanding(), 0);
        assertGe(vault.getBalance(), vault.getTotalOutstanding());
    }

    // -----------------------------------------------------------------------
    // payout, delinquency, flags
    // -----------------------------------------------------------------------

    function test_SetPayoutBlockedDuringLoan() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 400 * 1e6);

        bytes32 adminRole = splitter1.DEFAULT_ADMIN_ROLE();
        vm.prank(address(vault));
        splitter1.grantRole(adminRole, admin);

        vm.prank(admin);
        vm.expectRevert("Loan active: cannot change payout");
        splitter1.setPayout(agent2);
    }

    function test_SetPayoutAfterRepayment() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 400 * 1e6);
        _pay(splitter1, 2000 * 1e6);
        splitter1.settle();

        // Take the existing balance before redirecting, so this test isolates
        // the payout change rather than measuring unclaimed principal.
        vm.prank(agent1);
        splitter1.withdraw();

        bytes32 adminRole = splitter1.DEFAULT_ADMIN_ROLE();
        vm.prank(address(vault));
        splitter1.grantRole(adminRole, admin);

        vm.prank(admin);
        splitter1.setPayout(agent2);
        assertEq(splitter1.payout(), agent2);

        _pay(splitter1, 100 * 1e6);
        splitter1.settle();
        uint256 before = IERC20(usdc).balanceOf(agent2);
        vm.prank(agent1);
        splitter1.withdraw();
        // agent2 already held its 1000 USDC setup mint.
        assertEq(IERC20(usdc).balanceOf(agent2) - before, 100 * 1e6);
    }

    function test_MarkDelinquent() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 400 * 1e6);

        vm.warp(block.timestamp + 31 * 86400);
        vault.markDelinquent(0);
        assertTrue(vault.getLoan(0).delinquent);
    }

    function test_FlagLoan() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 400 * 1e6);

        vm.prank(watcher);
        vault.flagLoan(0, keccak256("payee swap detected"));
        assertTrue(vault.getLoan(0).flagged);

        RevenueSplitter second = _newSplitter(agent1);

        vm.prank(underwriter);
        vm.expectRevert("Splitter flagged");
        vault.openLoan(address(second), 500 * 1e6, keccak256("test"));
    }

    function test_PauseBlocksNewLoans() public {
        splitter1 = _newSplitter(agent1);

        vm.prank(admin);
        vault.pause();

        vm.prank(underwriter);
        vm.expectRevert("Vault paused");
        vault.openLoan(address(splitter1), 1000 * 1e6, keccak256("test"));
    }

    function test_FullLoanRepayment() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 400 * 1e6);

        // 432 owed at a 30% share needs 1440 of revenue.
        _pay(splitter1, 1440 * 1e6);
        splitter1.settle();

        RunwayVault.Loan memory loan = vault.getLoan(0);
        assertFalse(loan.active);
        assertEq(loan.repaid, loan.principal + (loan.principal * FEE_BPS) / 10000);
        assertFalse(splitter1.loanActive());
        assertEq(splitter1.surplus(), 0);
    }

    function test_CapGrowsWithRevenue() public {
        splitter1 = _newSplitter(agent1);

        _pay(splitter1, 1000 * 1e6);
        splitter1.settle();

        // 500 + 2*1000 = 2500 of exposure allowed, fee included.
        // 2320 + 185.6 = 2505.6 is still too much, so 2310 + 184.8 = 2494.8 fits.
        uint256 principal = 2310 * 1e6;
        vm.prank(underwriter);
        uint256 loanId = vault.openLoan(address(splitter1), principal, keccak256("test"));
        assertEq(loanId, 0);
    }

    function test_SecondLoanAfterFullRepayment() public {
        splitter1 = _newSplitter(agent1);

        // First cycle.
        _openLoan(splitter1, 400 * 1e6);
        _pay(splitter1, 2000 * 1e6);
        splitter1.settle();
        assertFalse(vault.getLoan(0).active);

        // Second cycle on the same splitter.
        uint256 loanId = _openLoan(splitter1, 400 * 1e6);
        assertEq(loanId, 1);
        assertEq(vault.advanceOutstanding(address(splitter1)), 432 * 1e6);

        _pay(splitter1, 2000 * 1e6);
        splitter1.settle();
        assertFalse(vault.getLoan(1).active);
        assertEq(vault.getTotalOutstanding(), 0);
    }

    function test_ThreeLoanCycles() public {
        splitter1 = _newSplitter(agent1);

        for (uint256 i = 0; i < 3; i++) {
            uint256 id = _openLoan(splitter1, 400 * 1e6);
            _pay(splitter1, 2000 * 1e6);
            splitter1.settle();
            assertFalse(vault.getLoan(id).active, "loan should close");
            assertEq(vault.getTotalOutstanding(), 0);
            assertEq(splitter1.surplus(), 0);
        }
        assertEq(vault.getLoansLength(), 3);
    }

    /**
     * @dev The agent must be able to administer its own splitter.
     *
     * Regression for a lock: the vault was the sole DEFAULT_ADMIN_ROLE holder
     * and exposes no delegation, so nobody could ever grant or revoke a role on
     * a splitter. That made `payout` permanent and left the agent unable to
     * recover from a lost key, with its revenue accruing and unwithdrawable.
     */
    function test_AgentCanAdministerItsOwnSplitter() public {
        splitter1 = _newSplitter(agent1);
        assertTrue(splitter1.hasRole(splitter1.DEFAULT_ADMIN_ROLE(), agent1), "agent should be admin");

        // The agent can rotate its own key. The role is read before the prank:
        // a staticcall inside a prank scope consumes it, which is how the first
        // version of this test sent grantRole as the test contract.
        address replacement = address(0xB0B);
        bytes32 agentRole = splitter1.AGENT_ROLE();
        vm.prank(agent1);
        splitter1.grantRole(agentRole, replacement);

        // Give it something to withdraw, so the assertion is that the
        // replacement key works rather than that the call does not revert on
        // an empty balance.
        _pay(splitter1, 50 * 1e6);
        splitter1.settle();

        vm.prank(replacement);
        splitter1.withdraw();

        assertEq(splitter1.getAgentOwed(), 0, "replacement key should have withdrawn");
    }

    function test_PayoutCanBeRedirectedByTheAgent() public {
        splitter1 = _newSplitter(agent1);
        address newPayout = address(0xB0B);

        vm.prank(agent1);
        splitter1.setPayout(newPayout);

        assertEq(splitter1.payout(), newPayout);
        assertTrue(splitter1.hasRole(splitter1.AGENT_ROLE(), agent1), "agent keeps its role");
    }

    function test_PayoutCannotBeRedirectedMidAdvance() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 100 * 1e6);

        vm.prank(agent1);
        vm.expectRevert("Loan active: cannot change payout");
        splitter1.setPayout(address(0xB0B));
    }

    function test_VaultRetainsAdminSoItCanCorrectAMisconfiguredPayout() public {
        splitter1 = _newSplitter(agent1);
        assertTrue(
            splitter1.hasRole(splitter1.DEFAULT_ADMIN_ROLE(), address(vault)),
            "the lender should still be able to redirect a bad payout"
        );
    }

    // -----------------------------------------------------------------------
    // repay authority
    //
    // repay() credits debt without moving tokens: settle() calls it and then
    // transfers the USDC itself. So the vault has to prove the caller is the
    // splitter that owes the money. If it does not, anyone can mark a loan
    // repaid for free, which shrinks the debt the vault is owed, inflates
    // availableToWithdraw, and lets the admin drain USDC that was never repaid.
    // It also lets an outsider shrink `owed` so the next settle() routes the
    // lender's 30% share to the agent instead.
    // -----------------------------------------------------------------------

    function test_RepayRejectsCallerThatIsNotTheSplitter() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 100 * 1e6);
        uint256 owedBefore = vault.advanceOutstanding(address(splitter1));
        assertGt(owedBefore, 0, "loan should be outstanding");

        vm.prank(address(0xB0B));
        vm.expectRevert();
        vault.repay(address(splitter1), 100 * 1e6);

        assertEq(vault.advanceOutstanding(address(splitter1)), owedBefore, "a rejected repay must not credit any debt");
    }

    function test_RepayRejectsAdminAndUnderwriterToo() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 100 * 1e6);
        uint256 owedBefore = vault.advanceOutstanding(address(splitter1));

        // The admin can already withdraw free funds; being able to also erase
        // debt would turn every repayment into a withdrawal.
        vm.prank(admin);
        vm.expectRevert();
        vault.repay(address(splitter1), 100 * 1e6);

        vm.prank(underwriter);
        vm.expectRevert();
        vault.repay(address(splitter1), 100 * 1e6);

        assertEq(vault.advanceOutstanding(address(splitter1)), owedBefore);
    }

    function test_RepayCannotBeUsedToInflateFreeFunds() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 100 * 1e6);

        uint256 freeBefore = vault.availableToWithdraw();
        uint256 owed = vault.advanceOutstanding(address(splitter1));
        assertGt(owed, 0);

        vm.prank(address(0xB0B));
        vm.expectRevert();
        vault.repay(address(splitter1), owed);

        assertEq(vault.availableToWithdraw(), freeBefore, "free funds must not move without a real repayment");
    }

    function test_SettleStillWorksAfterTighteningRepay() public {
        splitter1 = _newSplitter(agent1);
        _openLoan(splitter1, 100 * 1e6);
        _pay(splitter1, 300 * 1e6);

        // settle() calls repay as the splitter itself, which must still work.
        splitter1.settle();

        uint256 owed = vault.advanceOutstanding(address(splitter1));
        uint256 expected = 100 * 1e6 + (100 * 1e6 * 800) / 10000 - (300 * 1e6 * 3000) / 10000;
        assertLe(owed, expected, "settlement should have credited the lender its share");
    }
}
