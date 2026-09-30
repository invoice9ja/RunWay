// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {RunwayVault} from "../src/RunwayVault.sol";
import {RunwayFactory} from "../src/RunwayFactory.sol";
import {RevenueSplitter} from "../src/RevenueSplitter.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {ERC20} from "@openzeppelin/token/ERC20/ERC20.sol";

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

    // Addresses
    address admin = address(0x1);
    address underwriter = address(0x2);
    address watcher = address(0x3);
    address agent1 = address(0x10);
    address agent2 = address(0x11);
    address buyer1 = address(0x100);
    address buyer2 = address(0x101);
    address lender = address(0x1000);

    // Contracts
    RunwayVault vault;
    RunwayFactory factory;
    RevenueSplitter splitter1;
    RevenueSplitter splitter2;

    // Constants
    uint256 constant USDC_DECIMALS = 6;
    uint256 constant GLOBAL_MAX = 10_000 * 1e6;
    uint256 constant STARTER_CAP = 500 * 1e6;
    uint256 constant FEE_BPS = 800;
    uint256 constant SHARE_BPS = 3000;
    uint256 constant DUE_DAYS = 30;
    uint256 constant DEFAULT_SHARE_BPS = 3000;

    // Mock USDC
    MockERC20 usdc;
    uint256 usdcBalance = 1_000_000 * 1e6; // 1M USDC for testing

    function setUp() public {
        vm.label(admin, "admin");
        vm.label(underwriter, "underwriter");
        vm.label(watcher, "watcher");
        vm.label(agent1, "agent1");
        vm.label(agent2, "agent2");
        vm.label(buyer1, "buyer1");
        vm.label(buyer2, "buyer2");
        vm.label(lender, "lender");

        // Deploy mock USDC
        usdc = new MockERC20();

        // Deploy vault
        vault = new RunwayVault(
            address(usdc),
            GLOBAL_MAX,
            STARTER_CAP,
            FEE_BPS,
            SHARE_BPS,
            DUE_DAYS
        );

        // Grant admin DEFAULT_ADMIN_ROLE on vault (test contract is deployer)
        vault.grantRole(vault.DEFAULT_ADMIN_ROLE(), admin);

        // Deploy splitter implementation
        RevenueSplitter splitterImpl = new RevenueSplitter(
            address(vault),
            address(0),
            address(0),
            address(usdc),
            DEFAULT_SHARE_BPS
        );

        // Deploy factory
        factory = new RunwayFactory(
            address(vault),
            address(splitterImpl),
            address(usdc),
            DEFAULT_SHARE_BPS
        );

        // Grant roles (now as admin)
        vm.startPrank(admin);
        vault.grantRole(vault.UNDERWRITER_ROLE(), underwriter);
        vault.grantRole(vault.WATCHER_ROLE(), watcher);
        vault.grantRole(vault.DEFAULT_ADMIN_ROLE(), address(factory));
        vm.stopPrank();

        // Grant admin DEFAULT_ADMIN_ROLE on factory (test contract is deployer)
        factory.grantRole(factory.DEFAULT_ADMIN_ROLE(), admin);

        // Fund lender and vault (deposit as admin)
        usdc.mint(lender, 1_000_000 * 1e6);
        usdc.mint(admin, 100_000 * 1e6);
        vm.startPrank(admin);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(50_000 * 1e6); // 50k USDC in vault
        vm.stopPrank();

        // Fund buyers
        usdc.mint(buyer1, 10_000 * 1e6);
        usdc.mint(buyer2, 10_000 * 1e6);

        // Fund agents (for gas)
        usdc.mint(agent1, 1000 * 1e6);
        usdc.mint(agent2, 1000 * 1e6);
    }

    function test_DeployAndCreateSplitter() public {
        vm.startPrank(admin);
        address splitterAddr = factory.createSplitter(agent1, agent1);
        vm.stopPrank();

        assertEq(factory.getVault(), address(vault));
        assertTrue(vault.isSplitter(splitterAddr));
        splitter1 = RevenueSplitter(payable(splitterAddr));
        assertEq(splitter1.agent(), agent1);
        assertEq(splitter1.vault(), address(vault));
        assertEq(splitter1.shareBps(), DEFAULT_SHARE_BPS);
    }

function test_OpenLoan() public {
        // Create splitter
        vm.startPrank(admin);
        address splitterAddr = factory.createSplitter(agent1, agent1);
        vm.stopPrank();
        splitter1 = RevenueSplitter(payable(splitterAddr));

        // Open loan via underwriter (400 USDC - under STARTER_CAP of 500)
        vm.startPrank(underwriter);
        uint256 loanId = vault.openLoan(splitterAddr, 400 * 1e6, keccak256("test rationale"));
        vm.stopPrank();

        assertEq(loanId, 0);
        RunwayVault.Loan memory loan = vault.getLoan(0);
        assertEq(loan.splitter, splitterAddr);
        assertEq(loan.principal, 400 * 1e6);
        assertEq(loan.feeBps, FEE_BPS);
        assertEq(loan.shareBps, SHARE_BPS);
        assertTrue(loan.active);
        assertFalse(loan.delinquent);
        assertFalse(loan.flagged);

        // Agent can withdraw the loan principal from splitter
        vm.startPrank(agent1);
        splitter1.withdraw();
        vm.stopPrank();

        // Agent received advance (initial mint was 1000 USDC + 400 USDC loan = 1400 USDC)
        assertEq(IERC20(usdc).balanceOf(agent1), 1400 * 1e6);
    }

    function test_LoanCapEnforcement() public {
        vm.startPrank(admin);
        address splitterAddr = factory.createSplitter(agent1, agent1);
        vm.stopPrank();
        splitter1 = RevenueSplitter(payable(splitterAddr));

        // Try to open loan exceeding GLOBAL_MAX
        vm.startPrank(underwriter);
        vm.expectRevert("Exceeds cap");
        vault.openLoan(splitterAddr, GLOBAL_MAX + 1, keccak256("test"));
        vm.stopPrank();
    }

    function test_SettleAndRepay() public {
        // Setup: create splitter, open loan
        vm.startPrank(admin);
        address splitterAddr = factory.createSplitter(agent1, agent1);
        vm.stopPrank();
        splitter1 = RevenueSplitter(payable(splitterAddr));

        vm.startPrank(underwriter);
        vault.openLoan(splitterAddr, 400 * 1e6, keccak256("test"));
        vm.stopPrank();

        // Buyer pays splitter (simulate x402 payment)
        vm.startPrank(buyer1);
        IERC20(usdc).safeTransfer(splitterAddr, 100 * 1e6); // $100 revenue
        vm.stopPrank();

        // Keeper calls settle()
        splitter1.settle();

        // Check splits: 30% to vault, 70% to agent
        RunwayVault.Loan memory loan = vault.getLoan(0);
        assertEq(loan.repaid, 30 * 1e6); // 30% of $100
        // agentClaimable = loan principal (400) + agent share of revenue (70) = 470
        assertEq(splitter1.agentClaimable(), 470 * 1e6);
        assertEq(splitter1.lifetimeRevenue(), 100 * 1e6);
    }

    function test_SettleIdempotent() public {
        vm.startPrank(admin);
        address splitterAddr = factory.createSplitter(agent1, agent1);
        vm.stopPrank();
        splitter1 = RevenueSplitter(payable(splitterAddr));

        vm.startPrank(underwriter);
        vault.openLoan(splitterAddr, 400 * 1e6, keccak256("test"));
        vm.stopPrank();

        // First payment
        vm.startPrank(buyer1);
        IERC20(usdc).safeTransfer(splitterAddr, 100 * 1e6);
        vm.stopPrank();

        splitter1.settle();
        uint256 claimable1 = splitter1.agentClaimable(); // 400 + 70 = 470
        uint256 repaid1 = vault.getLoan(0).repaid; // 30

        // Call settle again with no new revenue - should be idempotent
        splitter1.settle();
        assertEq(splitter1.agentClaimable(), claimable1);
        assertEq(vault.getLoan(0).repaid, repaid1);

        // New payment
        vm.startPrank(buyer2);
        IERC20(usdc).safeTransfer(splitterAddr, 50 * 1e6);
        vm.stopPrank();

        splitter1.settle();
        // claimable1 (470) + 70% of 50 = 470 + 35 = 505
        assertEq(splitter1.agentClaimable(), claimable1 + 35 * 1e6);
        assertEq(vault.getLoan(0).repaid, repaid1 + 15 * 1e6); // 30% of $50
    }

    function test_Withdraw() public {
        vm.startPrank(admin);
        address splitterAddr = factory.createSplitter(agent1, agent1);
        vm.stopPrank();
        splitter1 = RevenueSplitter(payable(splitterAddr));

        vm.startPrank(underwriter);
        vault.openLoan(splitterAddr, 400 * 1e6, keccak256("test"));
        vm.stopPrank();

        // Generate revenue
        vm.startPrank(buyer1);
        IERC20(usdc).safeTransfer(splitterAddr, 100 * 1e6);
        vm.stopPrank();

        splitter1.settle();

        // Agent withdraws (agent1 has AGENT_ROLE)
        vm.startPrank(agent1);
        splitter1.withdraw();
        vm.stopPrank();

        assertEq(splitter1.agentClaimable(), 0);
        // Agent had 1000 initial mint + 400 loan + 70 revenue share = 1470
        assertEq(IERC20(usdc).balanceOf(agent1), 1470 * 1e6);
    }

    function test_SetPayoutBlockedDuringLoan() public {
        vm.startPrank(admin);
        address splitterAddr = factory.createSplitter(agent1, agent1);
        vm.stopPrank();
        splitter1 = RevenueSplitter(payable(splitterAddr));

        vm.startPrank(underwriter);
        vault.openLoan(splitterAddr, 400 * 1e6, keccak256("test"));
        vm.stopPrank();

        // Grant admin DEFAULT_ADMIN_ROLE on splitter (vault has DEFAULT_ADMIN_ROLE)
        vm.startPrank(address(vault));
        splitter1.grantRole(splitter1.DEFAULT_ADMIN_ROLE(), admin);
        vm.stopPrank();

        // Try to change payout - should fail because loan is active
        vm.startPrank(admin);
        vm.expectRevert("Loan active: cannot change payout");
        splitter1.setPayout(agent2);
        vm.stopPrank();
    }

    function test_MarkDelinquent() public {
        vm.startPrank(admin);
        address splitterAddr = factory.createSplitter(agent1, agent1);
        vm.stopPrank();
        splitter1 = RevenueSplitter(payable(splitterAddr));

        vm.startPrank(underwriter);
        vault.openLoan(splitterAddr, 400 * 1e6, keccak256("test"));
        vm.stopPrank();

        // Fast forward past due date
        vm.warp(block.timestamp + 31 * 86400);

        // Mark delinquent (permissionless)
        vault.markDelinquent(0);

        RunwayVault.Loan memory loan = vault.getLoan(0);
        assertTrue(loan.delinquent);
    }

    function test_FlagLoan() public {
        vm.startPrank(admin);
        address splitterAddr = factory.createSplitter(agent1, agent1);
        vm.stopPrank();
        splitter1 = RevenueSplitter(payable(splitterAddr));

        vm.startPrank(underwriter);
        vault.openLoan(splitterAddr, 400 * 1e6, keccak256("test"));
        vm.stopPrank();

        // Watcher flags loan
        vm.startPrank(watcher);
        vault.flagLoan(0, keccak256("payee swap detected"));
        vm.stopPrank();

        RunwayVault.Loan memory loan = vault.getLoan(0);
        assertTrue(loan.flagged);

        // Cannot open new loan for same splitter
        vm.startPrank(admin);
        address splitterAddr2 = factory.createSplitter(agent1, agent1);
        vm.stopPrank();

        vm.startPrank(underwriter);
        vm.expectRevert("Splitter flagged");
        vault.openLoan(splitterAddr2, 500 * 1e6, keccak256("test"));
        vm.stopPrank();
    }

    function test_PauseBlocksNewLoans() public {
        vm.startPrank(admin);
        address splitterAddr = factory.createSplitter(agent1, agent1);
        vm.stopPrank();

        vm.startPrank(admin);
        vault.pause();
        vm.stopPrank();

        vm.startPrank(underwriter);
        vm.expectRevert("Vault paused");
        vault.openLoan(splitterAddr, 1000 * 1e6, keccak256("test"));
        vm.stopPrank();
    }

    function test_FullLoanRepayment() public {
        vm.startPrank(admin);
        address splitterAddr = factory.createSplitter(agent1, agent1);
        vm.stopPrank();
        splitter1 = RevenueSplitter(payable(splitterAddr));

        vm.startPrank(underwriter);
        vault.openLoan(splitterAddr, 400 * 1e6, keccak256("test"));
        vm.stopPrank();

        // Generate enough revenue to repay (principal = 400, fee = 8% = 32, total = 432)
        // With 30% share, need 432 / 0.3 = 1440 revenue
        vm.startPrank(buyer1);
        IERC20(usdc).safeTransfer(splitterAddr, 1440 * 1e6);
        vm.stopPrank();

        splitter1.settle();

        RunwayVault.Loan memory loan = vault.getLoan(0);
        assertFalse(loan.active); // Should be fully repaid
        assertEq(loan.repaid, loan.principal);

        // Splitter loan should be inactive
        assertFalse(splitter1.loanActive());
    }

    function test_CapGrowsWithRevenue() public {
        vm.startPrank(admin);
        address splitterAddr = factory.createSplitter(agent1, agent1);
        vm.stopPrank();
        splitter1 = RevenueSplitter(payable(splitterAddr));

        // Initial cap: STARTER_CAP = 500
        // Generate some revenue first (no loan)
        vm.startPrank(buyer1);
        IERC20(usdc).safeTransfer(splitterAddr, 1000 * 1e6);
        vm.stopPrank();

        splitter1.settle(); // No loan active, all goes to agent

        // Now cap should be STARTER_CAP + 2 * lifetimeRevenue = 500 + 2*1000 = 2500
        // But capped at GLOBAL_MAX = 10000
        vm.startPrank(underwriter);
        uint256 loanId = vault.openLoan(splitterAddr, 2500 * 1e6, keccak256("test"));
        vm.stopPrank();

        assertEq(loanId, 0);
    }
}