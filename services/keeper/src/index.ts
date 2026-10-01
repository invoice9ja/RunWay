#!/usr/bin/env node

import { config } from "dotenv";
config({ path: ".env" });

import { ethers } from "ethers";
import { RevenueSplitter__factory } from "../contracts/typechain";

async function main() {
  const network = process.env.NETWORK || "mainnet";
  const rpcUrl = network === "mainnet" 
    ? process.env.ARC_MAINNET_RPC 
    : process.env.ARC_TESTNET_RPC;
  
  if (!rpcUrl) {
    throw new Error(`RPC URL not configured for ${network}`);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const keeper = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  
  console.log(`Starting Keeper on ${network}`);
  console.log(`Keeper address: ${keeper.address}`);

  // Load deployed addresses
  const fs = await import("fs");
  const addressesFile = `deployed-${network}.json`;
  if (!fs.existsSync(addressesFile)) {
    throw new Error(`No deployment file found: ${addressesFile}`);
  }
  const deployment = JSON.parse(fs.readFileSync(addressesFile, "utf8"));
  // The mainnet deployment file is a placeholder with deployed:false. Refuse to
  // act on it rather than sending a transaction to an undefined address.
  if (deployment.deployed === false) {
    throw new Error(`${addressesFile} reports deployed:false. Nothing exists on ${network} yet.`);
  }
  const { factory: factoryAddress } = deployment;

  const factory = await import("../contracts/typechain").then(m => m.RunwayFactory__factory.connect(factoryAddress, keeper));
  
  const SETTLE_THRESHOLD = BigInt(process.env.SETTLE_THRESHOLD_USDC || "1000000"); // 1 USDC
  const INTERVAL_MS = parseInt(process.env.KEEPER_INTERVAL_MS || "300000"); // 5 minutes

  console.log(`Settle threshold: ${SETTLE_THRESHOLD} USDC (6 decimals)`);
  console.log(`Poll interval: ${INTERVAL_MS}ms`);

  async function settleAll() {
    try {
      const splitters = await factory.getAllSplitters();
      console.log(`\n[${new Date().toISOString()}] Checking ${splitters.length} splitters...`);

      for (const splitterAddress of splitters) {
        const splitter = RevenueSplitter__factory.connect(splitterAddress, keeper);
        
        try {
          const balance = await splitter.getBalance();
          const unsettled = await splitter.getUnsettledRevenue();
          
          if (unsettled >= SETTLE_THRESHOLD) {
            console.log(`  Settling ${splitterAddress}: ${unsettled} USDC unsettled`);
            const tx = await splitter.settle();
            await tx.wait();
            console.log(`  ✓ Settled: ${tx.hash}`);
          } else if (unsettled > 0) {
            console.log(`  Skipping ${splitterAddress}: ${unsettled} USDC below threshold`);
          }
        } catch (error) {
          console.error(`  Error settling ${splitterAddress}:`, error.message);
        }
      }
    } catch (error) {
      console.error("Error in settleAll:", error.message);
    }
  }

  // Run immediately on start
  await settleAll();

  // Then run on interval
  setInterval(settleAll, INTERVAL_MS);

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down keeper...");
    process.exit(0);
  });

  console.log("Keeper running. Press Ctrl+C to stop.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});