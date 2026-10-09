// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Script, console } from "forge-std/Script.sol";
import { RunwayVault } from "../src/RunwayVault.sol";
import { RunwayFactory } from "../src/RunwayFactory.sol";
import { RevenueSplitter } from "../src/RevenueSplitter.sol";

contract Deploy is Script {
    /// Arc mainnet chain id. Deployment to it requires an explicit confirmation,
    /// because the caps below are sized for a testnet and a mistake here is not
    /// undoable: there is no redeploy, only a migration.
    uint256 constant ARC_MAINNET_CHAIN_ID = 5042;
    uint256 constant USDC_UNIT = 1e6;

    /**
     * Risk parameters.
     *
     * These were compile-time constants, which meant changing them for a new
     * network meant editing and recompiling the script — the least safe way to
     * adjust a number that governs how much real money the vault will hand out.
     * They are read from the environment in USDC and basis points instead, with
     * the current testnet sizing as the default.
     *
     * The defaults are deliberately small. GLOBAL_MAX is the most the vault can
     * ever be owed at once and STARTER_CAP the most any one borrower can take,
     * so both should be raised deliberately, not inherited.
     */
    function globalMax() internal view returns (uint256) {
        return vm.envOr("GLOBAL_MAX_USDC", uint256(10_000)) * USDC_UNIT;
    }

    function starterCap() internal view returns (uint256) {
        return vm.envOr("STARTER_CAP_USDC", uint256(500)) * USDC_UNIT;
    }

    function feeBps() internal view returns (uint256) {
        return vm.envOr("FEE_BPS_DEFAULT", uint256(800));
    }

    function shareBps() internal view returns (uint256) {
        return vm.envOr("SHARE_BPS_DEFAULT", uint256(3000));
    }

    function dueDays() internal view returns (uint256) {
        return vm.envOr("DUE_DAYS_DEFAULT", uint256(30));
    }

    function run() external {
        address usdc = vm.envAddress("USDC_ADDRESS");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        // .env carries placeholders for these, so derive the roles from the
        // deployer key rather than requiring three more entries to maintain.
        address deployer = vm.addr(deployerKey);
        address admin = vm.envOr("ADMIN_ADDRESS", deployer);
        address underwriter = vm.envOr("UNDERWRITER_ADDRESS", deployer);
        address watcher = vm.envOr("WATCHER_ADDRESS", deployer);

        uint256 chainId = block.chainid;

        /**
         * Mainnet guard.
         *
         * Deploying to a public chain is irreversible and the script's defaults
         * are testnet-sized. Requiring RUNWAY_MAINNET_CONFIRM means nobody
         * produces a mainnet deployment by forgetting which RPC was exported,
         * and it forces the caps and role addresses to be set deliberately.
         */
        if (chainId == ARC_MAINNET_CHAIN_ID) {
            require(
                vm.envOr("RUNWAY_MAINNET_CONFIRM", false),
                "Refusing to deploy to Arc mainnet without RUNWAY_MAINNET_CONFIRM=true"
            );
            require(
                vm.envOr("GLOBAL_MAX_USDC", uint256(0)) > 0,
                "Set GLOBAL_MAX_USDC explicitly before deploying to mainnet"
            );
            require(
                vm.envOr("STARTER_CAP_USDC", uint256(0)) > 0,
                "Set STARTER_CAP_USDC explicitly before deploying to mainnet"
            );
            console.log("=== MAINNET DEPLOYMENT ===");
        } else {
            console.log("=== TESTNET DEPLOYMENT ===");
        }

        uint256 max = globalMax();
        uint256 starter = starterCap();
        uint256 fee = feeBps();
        uint256 share = shareBps();
        uint256 due = dueDays();

        require(starter <= max, "STARTER_CAP_USDC must not exceed GLOBAL_MAX_USDC");
        require(fee <= 2000, "FEE_BPS_DEFAULT above 20% is not a lending product");
        require(share <= 5000, "SHARE_BPS_DEFAULT above 50% takes more than half the revenue");

        vm.startBroadcast(deployerKey);

        // 1. Deploy RunwayVault
        RunwayVault vault = new RunwayVault(usdc, max, starter, fee, share, due);

        // Grant roles
        vault.grantRole(vault.UNDERWRITER_ROLE(), underwriter);
        vault.grantRole(vault.WATCHER_ROLE(), watcher);
        vault.grantRole(vault.DEFAULT_ADMIN_ROLE(), admin);

        // 2. Deploy RevenueSplitter implementation, used as the clone target.
        //    Constructor leaves it uninitialised so it is never a live splitter.
        RevenueSplitter splitterImpl = new RevenueSplitter();

        // 3. Deploy RunwayFactory, then initialise it once with its dependencies.
        RunwayFactory factory = new RunwayFactory();
        factory.initialize(address(vault), address(splitterImpl), usdc, share);

        // Grant factory admin role on vault
        vault.grantRole(vault.DEFAULT_ADMIN_ROLE(), address(factory));

        vm.stopBroadcast();

        // Output addresses
        console.log("=== DEPLOYMENT COMPLETE ===");
        console.log("Chain id:", chainId);
        console.log("RunwayVault:", address(vault));
        console.log("RevenueSplitterImpl:", address(splitterImpl));
        console.log("RunwayFactory:", address(factory));
        console.log("Fee on 1 USDC advance:", (fee * 1e6) / 10000, "USDC");
        console.log("USDC:", usdc);
        console.log("Admin:", admin);
        console.log("Underwriter:", underwriter);
        console.log("Watcher:", watcher);
        console.log("GLOBAL_MAX:", max);
        console.log("STARTER_CAP:", starter);
        console.log("FEE_BPS_DEFAULT:", fee);
        console.log("SHARE_BPS_DEFAULT:", share);
        console.log("DUE_DAYS_DEFAULT:", due);
    }
}
