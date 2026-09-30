#!/usr/bin/env node

import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createWalletClient, createPublicClient, http, parseAbi, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as fs from "fs";

config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

console.log("PRIVATE_KEY loaded:", process.env.PRIVATE_KEY ? "YES (length: " + process.env.PRIVATE_KEY.length + ")" : "NO");
console.log("PRIVATE_KEY starts with 0x:", process.env.PRIVATE_KEY?.startsWith("0x"));
console.log("PRIVATE_KEY slice:", process.env.PRIVATE_KEY?.slice(0, 10));

async function main() {
  const network = process.env.NETWORK || "base-sepolia";
  
  let rpcUrl: string;
  let chainId: number;
  let deployedFile: string;
  
  if (network === "mainnet") {
    rpcUrl = process.env.ARC_MAINNET_RPC || process.env.RUNWAY_RPC_URL || "https://sepolia.base.org";
    chainId = 5042;
    deployedFile = "deployed-mainnet.json";
  } else {
    rpcUrl = process.env.ARC_TESTNET_RPC || "https://sepolia.base.org";
    chainId = 84532;
    deployedFile = "deployed-base-sepolia.json";
  }
  
  const projectRoot = "/home/moses/Desktop/RunWay";
  const deployed = JSON.parse(fs.readFileSync(join(projectRoot, deployedFile), "utf8"));
  
  const account = privateKeyToAccount(process.env.PRIVATE_KEY!);
  
  const publicClient = createPublicClient({
    chain: { id: chainId, name: network, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl)
  });
  
  const walletClient = createWalletClient({
    account,
    chain: { id: chainId, name: network, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl)
  });
  
  console.log(`Starting Keeper on ${network}`);
  console.log(`Keeper address: ${account.address}`);
  
  // Factory ABI (minimal)
  const factoryAbi = parseAbi([
    "function getAllSplitters() external view returns (address[] memory)",
    "function getSplittersCount() external view returns (uint256)"
  ]);
  
  // Splitter ABI (minimal)
  const splitterAbi = parseAbi([
    "function settle() external",
    "function getUnsettledRevenue() external view returns (uint256)",
    "function getBalance() external view returns (uint256)",
    "function agentClaimable() external view returns (uint256)",
    "function loanActive() external view returns (bool)"
  ]);
  
  const SETTLE_THRESHOLD = BigInt(process.env.SETTLE_THRESHOLD_USDC || "1000000"); // 1 USDC
  const INTERVAL_MS = parseInt(process.env.KEEPER_INTERVAL_MS || "300000"); // 5 minutes
  
  console.log(`Settle threshold: ${SETTLE_THRESHOLD} USDC (6 decimals)`);
  console.log(`Poll interval: ${INTERVAL_MS}ms`);
  
async function settleAll() {
    try {
      // First check splitter count
      const count = await publicClient.readContract({
        address: deployed.factory,
        abi: factoryAbi,
        functionName: "getSplittersCount"
      });
      console.log(`\n[${new Date().toISOString()}] Splitter count: ${count}`);
      
      const splitters = await publicClient.readContract({
        address: deployed.factory,
        abi: factoryAbi,
        functionName: "getAllSplitters"
      });
      console.log(`\n[${new Date().toISOString()}] Checking ${splitters.length} splitters...`);
      
      for (const splitterAddress of splitters) {
        try {
          const balance = await publicClient.readContract({
            address: splitterAddress,
            abi: parseAbi(["function getBalance() external view returns (uint256)"]),
            functionName: "getBalance"
          });
          
          const unsettled = await publicClient.readContract({
            address: splitterAddress,
            abi: parseAbi(["function getUnsettledRevenue() external view returns (uint256)"]),
            functionName: "getUnsettledRevenue"
          });
          
          console.log(`  Splitter ${splitterAddress}: balance=${formatUnits(balance, 6)}, unsettled=${formatUnits(unsettled, 6)}`);
          
          if (unsettled >= SETTLE_THRESHOLD) {
            console.log(`  Settling ${splitterAddress}: ${formatUnits(unsettled, 6)} USDC unsettled`);
            const hash = await walletClient.writeContract({
              address: splitterAddress,
              abi: parseAbi(["function settle() external"]),
              functionName: "settle"
            });
            await publicClient.waitForTransactionReceipt({ hash });
            console.log(`  ✓ Settled: ${hash}`);
          } else if (unsettled > 0) {
            console.log(`  Skipping ${splitterAddress}: ${formatUnits(unsettled, 6)} USDC below threshold`);
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
  setInterval(settleAll, 300000);
  
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