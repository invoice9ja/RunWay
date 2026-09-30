#!/usr/bin/env node

import { config } from "dotenv";
config({ path: ".env" });

import { ethers } from "ethers";
import { RunwayVault__factory, RunwayFactory__factory, RevenueSplitter__factory } from "../contracts/typechain";
import * as fs from "fs";

async function main() {
  const args = process.argv.slice(2);
  const network = args.find(a => a.startsWith("--network="))?.split("=")[1] || "testnet";
  const rpcUrl = network === "mainnet" 
    ? process.env.ARC_MAINNET_RPC 
    : process.env.ARC_TESTNET_RPC;
  
  if (!rpcUrl) {
    throw new Error(`RPC URL not configured for ${network}`);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const deployer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  
  console.log(`Deploying to ${network} (${rpcUrl})`);
  console.log(`Deployer: ${deployer.address}`);

  const usdcAddress = process.env.USDC_ADDRESS!;
  const adminAddress = process.env.ADMIN_ADDRESS || deployer.address;
  const underwriterAddress = process.env.UNDERWRITER_ADDRESS!;
  const watcherAddress = process.env.WATCHER_ADDRESS!;

  const GLOBAL_MAX = BigInt(process.env.GLOBAL_MAX || "10000000000");
  const STARTER_CAP = BigInt(process.env.STARTER_CAP || "500000000");
  const FEE_BPS_DEFAULT = parseInt(process.env.FEE_BPS_DEFAULT || "800");
  const SHARE_BPS_DEFAULT = parseInt(process.env.SHARE_BPS_DEFAULT || "3000");
  const DUE_DAYS_DEFAULT = parseInt(process.env.DUE_DAYS_DEFAULT || "30");

  // 1. Deploy RunwayVault
  console.log("\n1. Deploying RunwayVault...");
  const vaultFactory = new RunwayVault__factory(deployer);
  const vault = await vaultFactory.deploy(
    usdcAddress,
    GLOBAL_MAX,
    STARTER_CAP,
    FEE_BPS_DEFAULT,
    SHARE_BPS_DEFAULT,
    DUE_DAYS_DEFAULT
  );
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log(`   RunwayVault deployed to: ${vaultAddress}`);

  // 2. Deploy RevenueSplitter implementation (for reference)
  console.log("\n2. Deploying RevenueSplitter implementation...");
  const splitterFactory = new RevenueSplitter__factory(deployer);
  const splitterImpl = await splitterFactory.deploy(
    vaultAddress,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    usdcAddress,
    SHARE_BPS_DEFAULT
  );
  await splitterImpl.waitForDeployment();
  const splitterImplAddress = await splitterImpl.getAddress();
  console.log(`   RevenueSplitter impl deployed to: ${splitterImplAddress}`);

  // 3. Deploy RunwayFactory
  console.log("\n3. Deploying RunwayFactory...");
  const factoryFactory = new RunwayFactory__factory(deployer);
  const factory = await factoryFactory.deploy(
    vaultAddress,
    splitterImplAddress,
    usdcAddress,
    SHARE_BPS_DEFAULT
  );
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log(`   RunwayFactory deployed to: ${factoryAddress}`);

  // 4. Grant roles
  console.log("\n4. Granting roles...");
  
  const underwriterRole = await vault.UNDERWRITER_ROLE();
  let tx = await vault.grantRole(underwriterRole, underwriterAddress);
  await tx.wait();
  console.log(`   UNDERWRITER_ROLE granted to ${underwriterAddress}`);

  const watcherRole = await vault.WATCHER_ROLE();
  tx = await vault.grantRole(watcherRole, watcherAddress);
  await tx.wait();
  console.log(`   WATCHER_ROLE granted to ${watcherAddress}`);

  const defaultAdminRole = await vault.DEFAULT_ADMIN_ROLE();
  tx = await vault.grantRole(defaultAdminRole, factoryAddress);
  await tx.wait();
  console.log(`   DEFAULT_ADMIN_ROLE on vault granted to factory`);

  const factoryDefaultAdminRole = await factory.DEFAULT_ADMIN_ROLE();
  tx = await factory.grantRole(factoryDefaultAdminRole, adminAddress);
  await tx.wait();
  console.log(`   DEFAULT_ADMIN_ROLE on factory granted to admin`);

  console.log("\n=== DEPLOYMENT COMPLETE ===");
  console.log(`RunwayVault: ${vaultAddress}`);
  console.log(`RevenueSplitterImpl: ${splitterImplAddress}`);
  console.log(`RunwayFactory: ${factoryAddress}`);
  console.log(`USDC: ${usdcAddress}`);
  console.log(`Admin: ${adminAddress}`);
  console.log(`Underwriter: ${underwriterAddress}`);
  console.log(`Watcher: ${watcherAddress}`);
  console.log(`GLOBAL_MAX: ${GLOBAL_MAX}`);
  console.log(`STARTER_CAP: ${STARTER_CAP}`);
  console.log(`FEE_BPS_DEFAULT: ${FEE_BPS_DEFAULT}`);
  console.log(`SHARE_BPS_DEFAULT: ${SHARE_BPS_DEFAULT}`);
  console.log(`DUE_DAYS_DEFAULT: ${DUE_DAYS_DEFAULT}`);

  // Save addresses to file for services
  const addresses = {
    network,
    vault: vaultAddress,
    splitterImpl: splitterImplAddress,
    factory: factoryAddress,
    usdc: usdcAddress,
    admin: adminAddress,
    underwriter: underwriterAddress,
    watcher: watcherAddress,
    timestamp: new Date().toISOString()
  };
  await fs.promises.writeFile(
    `deployed-${network}.json`,
    JSON.stringify(addresses, null, 2)
  );
  console.log(`\nAddresses saved to deployed-${network}.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});