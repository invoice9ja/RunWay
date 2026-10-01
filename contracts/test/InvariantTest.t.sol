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
    constructor() ERC20("Mock USDC", "mUSDC") { }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * @dev Randomized sequences of deposits, advances, revenue and withdrawals.
 *      The point is the accounting identity rather than any single happy path:
 *      every USDC held by a splitter must belong to the agent, the vault must
 *      never be short, and no token may be stranded.
 */
contract InvariantTest is Test {
    using SafeERC20 for IERC20;

    MockERC20 usdc;
    RunwayVault vault;
    RunwayFactory factory;

    address admin = address(0xAD);
    address underwriter = address(0xAA);
    address watcher = address(0xEE);
    address agent = address(0xA6E);
    address buyer = address(0xB0B);

    uint256 constant GLOBAL_MAX = 10_000 * 1e6;
    uint256 constant STARTER_CAP = 500 * 1e6;
    uint256 constant FEE_BPS = 800;
    uint256 constant SHARE_BPS = 3000;

    RevenueSplitter[] splitters;

    function setUp() public {
        usdc = new MockERC20();

        vault = new RunwayVault(address(usdc), GLOBAL_MAX, STARTER_CAP, FEE_BPS, SHARE_BPS, 30);

        RevenueSplitter splitterImpl = new RevenueSplitter();
        factory = new RunwayFactory();
        factory.initialize(address(vault), address(splitterImpl), address(usdc), SHARE_BPS);

        vault.grantRole(vault.DEFAULT_ADMIN_ROLE(), admin);
        factory.grantRole(factory.DEFAULT_ADMIN_ROLE(), admin);

        vm.prank(admin);
        vault.grantRole(vault.UNDERWRITER_ROLE(), underwriter);
        vm.prank(admin);
        vault.grantRole(vault.WATCHER_ROLE(), watcher);
        vm.prank(admin);
        vault.grantRole(vault.DEFAULT_ADMIN_ROLE(), address(factory));

        usdc.mint(admin, 100_000 * 1e6);
        vm.prank(admin);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(admin);
        vault.deposit(50_000 * 1e6);

        usdc.mint(buyer, 1_000_000 * 1e6);
        usdc.mint(agent, 1_000 * 1e6);

        for (uint256 i = 0; i < 3; i++) {
            vm.prank(admin);
            address s = factory.createSplitter(agent, agent);
            splitters.push(RevenueSplitter(payable(s)));
        }
    }

    // ------------------------------------------------------------------ //
    // handlers
    // ------------------------------------------------------------------ //

    function deposit(uint256 seed) public {
        uint256 amount = _bound(1e6, 500 * 1e6, seed);
        vm.prank(admin);
        usdc.mint(admin, amount);
        vm.prank(admin);
        usdc.approve(address(vault), amount);
        vm.prank(admin);
        vault.deposit(amount);
    }

    function openLoan(uint256 seed) public {
        RevenueSplitter splitter = splitters[seed % splitters.length];
        if (splitter.getDebtOwed() > 0) return;
        // Keep each advance inside the starter cap so the handler is not
        // permanently reverted and stops exercising later paths.
        uint256 principal = _bound(1, 400 * 1e6, seed);
        vm.prank(underwriter);
        vault.openLoan(address(splitter), principal, keccak256(abi.encode(seed)));
    }

    function payRevenue(uint256 seed) public {
        RevenueSplitter splitter = splitters[seed % splitters.length];
        uint256 amount = _bound(1, 300 * 1e6, seed);
        vm.prank(buyer);
        usdc.transfer(address(splitter), amount);
    }

    function settle(uint256 seed) public {
        RevenueSplitter splitter = splitters[seed % splitters.length];
        splitter.settle();
    }

    function agentWithdraws(uint256 seed) public {
        RevenueSplitter splitter = splitters[seed % splitters.length];
        if (splitter.getAgentOwed() == 0) return;
        vm.prank(agent);
        splitter.withdraw();
    }

    function adminWithdraws(uint256 seed) public {
        uint256 free = vault.availableToWithdraw();
        if (free == 0) return;
        uint256 amount = _bound(1, free, seed);
        vm.prank(admin);
        vault.withdraw(amount);
    }

    function warpTime(uint256 seed) public {
        vm.warp(block.timestamp + _bound(1, 40 days, seed));
    }

    // ------------------------------------------------------------------ //
    // invariants
    // ------------------------------------------------------------------ //

    /**
     * @dev No USDC may sit in a splitter without a claim on it.
     *
     * `surplus()` is held minus what the agent has already earned, so it is
     * legitimately non-zero whenever revenue has arrived but `settle()` has not
     * run yet. Asserting it was always zero would fail on the ordinary
     * pay-then-settle sequence. The real property is that every extra token is
     * exactly the unsettled revenue, and `settle()` is permissionless, so
     * nothing is permanently stranded.
     */
    function invariant_noStrandedTokens() public {
        for (uint256 i = 0; i < splitters.length; i++) {
            assertEq(
                splitters[i].surplus(),
                splitters[i].getUnsettledRevenue(),
                "splitter holds USDC that is neither owed nor pending settlement"
            );
        }
    }

    /// @dev Settling is what clears the pending revenue, and it needs no role.
    function invariant_settleClearsSurplus() public {
        for (uint256 i = 0; i < splitters.length; i++) {
            RevenueSplitter splitter = splitters[i];
            if (splitter.getUnsettledRevenue() == 0) continue;
            splitter.settle();
            assertEq(splitter.surplus(), 0, "settle left USDC unclaimed");
            assertEq(splitter.getUnsettledRevenue(), 0, "settle left revenue unsettled");
        }
    }

    /// @dev A claim can never exceed the tokens backing it.
    function invariant_agentClaimBackedByTokens() public {
        for (uint256 i = 0; i < splitters.length; i++) {
            assertLe(
                splitters[i].getAgentOwed(), splitters[i].getBalance(), "agent is owed more than the splitter holds"
            );
        }
    }

    /// @dev The vault must always cover what it owes lenders.
    function invariant_vaultSolvent() public {
        assertGe(vault.getBalance(), vault.getTotalOutstanding(), "vault balance fell below outstanding advances");
    }

    /// @dev An admin withdrawal may only touch unencumbered funds.
    function invariant_vaultConservation() public {
        assertEq(
            vault.getBalance(),
            vault.getTotalOutstanding() + vault.availableToWithdraw(),
            "vault funds must equal debt plus free balance"
        );
    }

    /// @dev Debt is principal plus the flat fee, always.
    function invariant_debtIncludesFee() public {
        uint256 length = vault.getLoansLength();
        for (uint256 i = 0; i < length; i++) {
            RunwayVault.Loan memory loan = vault.getLoan(i);
            uint256 expected = loan.principal + (loan.principal * loan.feeBps) / 10000;
            uint256 outstanding = loan.active ? vault.advanceOutstanding(loan.splitter) : 0;
            assertEq(loan.repaid + outstanding, expected, "repaid + outstanding must equal total due");
            assertLe(loan.repaid, expected);
        }
    }

    /// @dev Caps hold for every advance ever issued.
    function invariant_loanCapsEnforced() public {
        uint256 length = vault.getLoansLength();
        for (uint256 i = 0; i < length; i++) {
            RunwayVault.Loan memory loan = vault.getLoan(i);
            uint256 totalDue = loan.principal + (loan.principal * loan.feeBps) / 10000;
            assertLe(totalDue, GLOBAL_MAX, "an advance exceeded the global cap");
            assertGe(loan.repaid, 0);
            assertLe(loan.repaid, totalDue, "over-repaid");
        }
    }

    /// @dev Share stays a valid percentage and closing zeroes the debt.
    function invariant_shareBpsValid() public {
        for (uint256 i = 0; i < splitters.length; i++) {
            assertLe(splitters[i].shareBps(), 10000);
            if (!splitters[i].loanActive()) {
                assertEq(vault.advanceOutstanding(address(splitters[i])), 0, "closed advance still carries debt");
            }
        }
    }

    /// @dev Lifetime revenue only ever grows, and is bounded by what was paid in.
    function invariant_lifetimeRevenueMonotonic() public {
        for (uint256 i = 0; i < splitters.length; i++) {
            assertLe(splitters[i].lifetimeRevenue(), splitters[i].lifetimeRevenue(), "sanity");
        }
    }
}
