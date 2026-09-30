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
  const buyer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  
  console.log(`Starting Demo Buyer on ${network}`);
  console.log(`Buyer address: ${buyer.address}`);

  // Load deployed addresses
  const fs = await import("fs");
  const addressesFile = `deployed-${network}.json`;
  if (!fs.existsSync(addressesFile)) {
    throw new Error(`No deployment file found: ${addressesFile}`);
  }
  const { factory: factoryAddress, usdc: usdcAddress } = JSON.parse(fs.readFileSync(addressesFile, "utf8"));

  const factory = await import("../contracts/typechain").then(m => m.RunwayFactory__factory.connect(factoryAddress, provider));
  const splitters = await factory.getAllSplitters();
  
  if (splitters.length === 0) {
    throw new Error("No splitters deployed. Create one via factory first.");
  }

  const splitterAddress = splitters[0];
  const PAYMENT_AMOUNT = BigInt(process.env.DEMO_PAYMENT_AMOUNT_USDC || "100000"); // 0.1 USDC
  const INTERVAL_MS = parseInt(process.env.DEMO_BUYER_INTERVAL_MS || "60000"); // 1 minute

  console.log(`Using splitter: ${splitterAddress}`);
  console.log(`Payment amount: ${PAYMENT_AMOUNT} USDC (6 decimals)`);
  console.log(`Interval: ${INTERVAL_MS}ms`);

  // Get USDC contract
  const usdc = await import("@openzeppelin/contracts").then(m => m.IERC20__factory.connect(usdcAddress, buyer));
  
  // Check USDC balance
  const balance = await usdc.balanceOf(buyer.address);
  console.log(`Buyer USDC balance: ${balance}`);

  async function makePayment() {
    try {
      console.log(`\n[${new Date().toISOString()}] Making payment of ${PAYMENT_AMOUNT} USDC to ${splitterAddress}`);
      
      // In a real x402 flow, the buyer would:
      // 1. Call seller endpoint
      // 2. Receive 402 with payment requirements
      // 3. Sign EIP-3009 authorization
      // 4. Submit to facilitator
      // 5. Facilitator calls transferWithAuthorization on USDC
      
      // For demo, we directly transfer USDC to splitter (simulating facilitator)
      const tx = await usdc.transfer(splitterAddress, PAYMENT_AMOUNT);
      await tx.wait();
      console.log(`✓ Payment sent: ${tx.hash}`);
      
      // Check splitter balance
      const splitter = RevenueSplitter__factory.connect(splitterAddress, provider);
      const balance = await splitter.getBalance();
      console.log(`Splitter balance: ${balance}`);
    } catch (error) {
      console.error("Payment failed:", error.message);
    }
  }

  // Make initial payment
  await makePayment();

  // Then run on interval
  setInterval(makePayment, INTERVAL_MS);

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down demo buyer...");
    process.exit(0);
  });

  console.log("Demo buyer running. Press Ctrl+C to stop.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});