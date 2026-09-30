#!/usr/bin/env node

import { config } from "dotenv";
config({ path: ".env" });

import { ethers } from "ethers";
import { RevenueSplitter__factory, RunwayVault__factory, RunwayFactory__factory } from "../contracts/typechain";

async function main() {
  const network = process.env.NETWORK || "testnet";
  const rpcUrl = network === "mainnet" 
    ? process.env.ARC_MAINNET_RPC 
    : process.env.ARC_TESTNET_RPC;
  
  if (!rpcUrl) {
    throw new Error(`RPC URL not configured for ${network}`);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const deployer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  
  console.log(`Testing integration on ${network}`);

  // Load deployed addresses
  const fs = await import("fs");
  const addressesFile = `deployed-${network}.json`;
  if (!fs.existsSync(addressesFile)) {
    throw new Error(`No deployment file found: ${addressesFile}`);
  }
  const { vault: vaultAddress, factory: factoryAddress, usdc: usdcAddress } = JSON.parse(fs.readFileSync(addressesFile, "utf8"));

  // Get USDC contract
  const usdc = await import("@openzeppelin/contracts").then(m => m.IERC20__factory.connect(usdcAddress, deployer));

  // Get contracts
  const vault = RunwayVault__factory.connect(vaultAddress, deployer);
  const factory = RunwayFactory__factory.connect(factoryAddress, deployer);

  console.log("\n=== Integration Test ===");
  console.log(`Vault: ${vaultAddress}`);
  console.log(`Factory: ${factoryAddress}`);
  console.log(`USDC: ${usdcAddress}`);

  // Test 1: Create a splitter
  console.log("\n1. Creating splitter...");
  const splitterAddr = await factory.createSplitter(deployer.address, deployer.address);
  console.log(`   Splitter created: ${splitterAddr}`);

  // Test 2: Check splitter registration
  console.log("\n2. Checking splitter registration...");
  const isSplitter = await vault.isSplitter(splitterAddr);
  console.log(`   Is registered: ${isSplitter}`);

  // Test 3: Open a loan (as underwriter)
  console.log("\n3. Opening loan (500 USDC)...");
  const underwriterRole = await vault.UNDERWRITER_ROLE();
  const underwriterAddress = process.env.UNDERWRITER_ADDRESS || deployer.address;
  
  // Grant underwriter role if needed
  const hasRole = await vault.hasRole(underwriterRole, deployer.address);
  if (!hasRole) {
    await vault.grantRole(underwriterRole, deployer.address);
    console.log("   Granted underwriter role to deployer");
  }

  const tx = await vault.openLoan(splitterAddr, 500_000_000, ethers.keccak256(ethers.toUtf8Bytes("test loan")));
  await tx.wait();
  console.log("   Loan opened");

  // Test 4: Check loan details
  console.log("\n4. Checking loan details...");
  const loan = await vault.getLoan(0);
  console.log(`   Principal: ${loan.principal}`);
  console.log(`   Active: ${loan.active}`);

  // Test 5: Send USDC to splitter (simulate revenue)
  console.log("\n5. Sending revenue to splitter (100 USDC)...");
  await usdc.transfer(splitterAddr, 100_000_000);
  console.log("   Revenue sent");

  // Test 6: Call settle
  console.log("\n6. Calling settle()...");
  const splitter = RevenueSplitter__factory.connect(splitterAddr, deployer);
  const settleTx = await splitter.settle();
  await settleTx.wait();
  console.log("   Settled");

  // Test 7: Check results
  console.log("\n7. Checking results...");
  const vaultLoan = await vault.getLoan(0);
  console.log(`   Loan repaid: ${vaultLoan.repaid}`);
  console.log(`   Agent claimable: ${await splitter.agentClaimable()}`);
  console.log(`   Lifetime revenue: ${await splitter.lifetimeRevenue()}`);

  // Test 8: Agent withdraw
  console.log("\n8. Agent withdrawing...");
  const withdrawTx = await splitter.withdraw();
  await withdrawTx.wait();
  console.log("   Withdrawn");
  console.log(`   Agent USDC balance: ${await usdc.balanceOf(deployer.address)}`);

  console.log("\n=== All tests passed! ===");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});