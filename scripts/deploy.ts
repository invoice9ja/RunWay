#!/usr/bin/env node

import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, "../.env") });

import { ethers } from "ethers";
import * as fs from "fs";

// Load ABIs from Foundry artifacts
const projectRoot = "/home/moses/Desktop/RunWay";
const artifactsDir = join(projectRoot, "contracts/out");

console.log("Loading ABIs from:", artifactsDir);

const RevenueSplitter_artifact = JSON.parse(fs.readFileSync(join(artifactsDir, "RevenueSplitter.sol/RevenueSplitter.json"), "utf8"));
const RunwayVault_artifact = JSON.parse(fs.readFileSync(join(artifactsDir, "RunwayVault.sol/RunwayVault.json"), "utf8"));
const RunwayFactory_artifact = JSON.parse(fs.readFileSync(join(artifactsDir, "RunwayFactory.sol/RunwayFactory.json"), "utf8"));

console.log("RevenueSplitter ABI:", RevenueSplitter_artifact.abi ? RevenueSplitter_artifact.abi.length + " items" : "UNDEFINED");
console.log("RunwayVault ABI:", RunwayVault_artifact.abi ? RunwayVault_artifact.abi.length + " items" : "UNDEFINED");
console.log("RunwayFactory ABI:", RunwayFactory_artifact.abi ? RunwayFactory_artifact.abi.length + " items" : "UNDEFINED");

const RevenueSplitter_abi = RevenueSplitter_artifact.abi;
const RunwayVault_abi = RunwayVault_artifact.abi;
const RunwayFactory_abi = RunwayFactory_artifact.abi;

const RevenueSplitter_bytecode = RevenueSplitter_artifact.bytecode;
const RunwayVault_bytecode = RunwayVault_artifact.bytecode;
const RunwayFactory_bytecode = RunwayFactory_artifact.bytecode;

async function main() {
  const args = process.argv.slice(2);
  const network = args.find(a => a.startsWith("--network="))?.split("=")[1] || "testnet";
  const rpcUrl = network === "mainnet" 
    ? process.env.ARC_MAINNET_RPC 
    : process.env.ARC_TESTNET_RPC;
  
  if (!rpcUrl) {
    throw new Error(`RPC URL not configured for ${network}`);
  }

  // Use StaticJsonRpcProvider to avoid network detection
const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: { chainId: 5042, name: "arc-mainnet" } });
  const deployer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  
  console.log(`Deploying to ${network} (${rpcUrl})`);
  console.log(`Deployer: ${deployer.address}`);

  const usdcAddress = process.env.USDC_ADDRESS!;
  const adminAddress = process.env.ADMIN_ADDRESS || deployer.address;
  const underwriterAddress = process.env.UNDERWRITER_ADDRESS || deployer.address;
  const watcherAddress = process.env.WATCHER_ADDRESS || deployer.address;

  const GLOBAL_MAX = BigInt(process.env.GLOBAL_MAX || "10000000000");
  const STARTER_CAP = BigInt(process.env.STARTER_CAP || "500000000");
  const FEE_BPS_DEFAULT = parseInt(process.env.FEE_BPS_DEFAULT || "800");
  const SHARE_BPS_DEFAULT = parseInt(process.env.SHARE_BPS_DEFAULT || "3000");
  const DUE_DAYS_DEFAULT = parseInt(process.env.DUE_DAYS_DEFAULT || "30");

  // 1. Deploy RunwayVault
  console.log("\n1. Deploying RunwayVault...");
  const vaultFactory = new ethers.ContractFactory(RunwayVault_abi, RunwayVault_bytecode, deployer);
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
  const splitterFactory = new ethers.ContractFactory(RevenueSplitter_abi, RevenueSplitter_bytecode, deployer);
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
  const factoryFactory = new ethers.ContractFactory(RunwayFactory_abi, RunwayFactory_bytecode, deployer);
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
  
  const vaultContract = new ethers.Contract(vaultAddress, RunwayVault_abi, deployer);
  const factoryContract = new ethers.Contract(factoryAddress, RunwayFactory_abi, deployer);

  const underwriterRole = await vaultContract.UNDERWRITER_ROLE();
  let tx = await vaultContract.grantRole(underwriterRole, underwriterAddress);
  await tx.wait();
  console.log(`   UNDERWRITER_ROLE granted to ${underwriterAddress}`);

  const watcherRole = await vaultContract.WATCHER_ROLE();
  tx = await vaultContract.grantRole(watcherRole, watcherAddress);
  await tx.wait();
  console.log(`   WATCHER_ROLE granted to ${watcherAddress}`);

  const defaultAdminRole = await vaultContract.DEFAULT_ADMIN_ROLE();
  tx = await vaultContract.grantRole(defaultAdminRole, factoryAddress);
  await tx.wait();
  console.log(`   DEFAULT_ADMIN_ROLE on vault granted to factory`);

  const factoryDefaultAdminRole = await factoryContract.DEFAULT_ADMIN_ROLE();
  tx = await factoryContract.grantRole(factoryDefaultAdminRole, adminAddress);
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