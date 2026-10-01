// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Script, console } from "forge-std/Script.sol";
import { RunwayVault } from "../src/RunwayVault.sol";

contract OpenLoan is Script {
    function run() external {
        address vault = vm.envAddress("VAULT_ADDRESS");
        address splitter = vm.envAddress("SPLITTER_ADDRESS");
        uint256 principal = vm.envUint("PRINCIPAL");

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));

        uint256 loanId = RunwayVault(payable(vault)).openLoan(splitter, principal, keccak256("test loan"));

        vm.stopBroadcast();

        uint256 fee = (principal * 800) / 10000;

        console.log("Loan opened for splitter:", splitter);
        console.log("Loan id:", loanId);
        console.log("Principal:", principal);
        console.log("Flat fee (8%):", fee);
        console.log("Total due:", principal + fee);
    }
}
