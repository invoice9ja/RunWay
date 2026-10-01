// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Script, console } from "forge-std/Script.sol";
import { RunwayFactory } from "../src/RunwayFactory.sol";

contract CreateSplitter is Script {
    function run() external {
        address factory = vm.envAddress("FACTORY_ADDRESS");
        address agent = vm.envAddress("AGENT_ADDRESS");
        address payout = vm.envAddress("PAYOUT_ADDRESS");
        uint256 shareBps = vm.envUint("SHARE_BPS");

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));

        RunwayFactory(factory).createSplitter(agent, payout, shareBps);

        vm.stopBroadcast();

        console.log("Splitter created for agent:", agent);
    }
}
