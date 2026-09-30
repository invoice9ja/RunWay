// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {RunwayVault} from "../src/RunwayVault.sol";
import {RunwayFactory} from "../src/RunwayFactory.sol";
import {RevenueSplitter} from "../src/RevenueSplitter.sol";

contract Deploy is Script {
    // Deployment parameters (set via environment variables)
    uint256 constant GLOBAL_MAX = 10_000 * 1e6; // 10,000 USDC
    uint256 constant STARTER_CAP = 500 * 1e6; // 500 USDC
    uint256 constant FEE_BPS_DEFAULT = 800; // 8%
    uint256 constant SHARE_BPS_DEFAULT = 3000; // 30%
    uint256 constant DUE_DAYS_DEFAULT = 30;
    uint256 constant DEFAULT_SHARE_BPS = 3000; // 30%

    function run() external {
        // Load deployment parameters from env
        address usdc = vm.envAddress("USDC_ADDRESS");
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address underwriter = vm.envAddress("UNDERWRITER_ADDRESS");
        address watcher = vm.envAddress("WATCHER_ADDRESS");

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));

        // 1. Deploy RunwayVault
        RunwayVault vault = new RunwayVault(
            usdc,
            GLOBAL_MAX,
            STARTER_CAP,
            FEE_BPS_DEFAULT,
            SHARE_BPS_DEFAULT,
            DUE_DAYS_DEFAULT
        );

        // Grant roles
        vault.grantRole(vault.UNDERWRITER_ROLE(), underwriter);
        vault.grantRole(vault.WATCHER_ROLE(), watcher);
        vault.grantRole(vault.DEFAULT_ADMIN_ROLE(), admin);

        // 2. Deploy RevenueSplitter implementation (for reference)
        RevenueSplitter splitterImpl = new RevenueSplitter(
            address(vault),
            address(0), // dummy
            address(0), // dummy
            usdc, // dummy USDC
            DEFAULT_SHARE_BPS
        );

        // 3. Deploy RunwayFactory
        RunwayFactory factory = new RunwayFactory(
            address(vault),
            address(splitterImpl),
            usdc,
            DEFAULT_SHARE_BPS
        );

        // Grant factory admin role on vault
        vault.grantRole(vault.DEFAULT_ADMIN_ROLE(), address(factory));

        vm.stopBroadcast();

        // Output addresses
        console.log("=== DEPLOYMENT COMPLETE ===");
        console.log("RunwayVault:", address(vault));
        console.log("RevenueSplitterImpl:", address(splitterImpl));
        console.log("RunwayFactory:", address(factory));
        console.log("USDC:", usdc);
        console.log("Admin:", admin);
        console.log("Underwriter:", underwriter);
        console.log("Watcher:", watcher);
        console.log("GLOBAL_MAX:", GLOBAL_MAX);
        console.log("STARTER_CAP:", STARTER_CAP);
        console.log("FEE_BPS_DEFAULT:", FEE_BPS_DEFAULT);
        console.log("SHARE_BPS_DEFAULT:", SHARE_BPS_DEFAULT);
        console.log("DUE_DAYS_DEFAULT:", DUE_DAYS_DEFAULT);
    }
}