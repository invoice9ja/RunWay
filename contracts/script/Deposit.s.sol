// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Script, console } from "forge-std/Script.sol";
import { RunwayVault } from "../src/RunwayVault.sol";

contract Deposit is Script {
    function run() external {
        address vault = vm.envAddress("VAULT_ADDRESS");
        address usdc = vm.envAddress("USDC_ADDRESS");
        uint256 amount = vm.envUint("AMOUNT");

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));

        RunwayVault(payable(vault)).deposit(amount);

        vm.stopBroadcast();

        console.log("Deposited", amount, "USDC to vault:", vault);
    }
}
