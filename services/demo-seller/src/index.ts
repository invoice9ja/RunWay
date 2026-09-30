#!/usr/bin/env node

import { config } from "dotenv";
config({ path: ".env" });

import express from "express";
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
  
  console.log(`Starting Demo Seller on ${network}`);

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

  const splitterAddress = splitters[0]; // Use first splitter for demo
  console.log(`Using splitter: ${splitterAddress}`);

  const app = express();
  app.use(express.json());

  // x402 payment middleware
  const x402Middleware = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Check for x402 payment header
    const paymentHeader = req.headers["x-payment"];
    
    if (!paymentHeader) {
      // Return 402 with payment requirements
      res.setHeader("WWW-Authenticate", `Payment x402; payTo="${splitterAddress}"; asset="${usdcAddress}"; amount="100000"`);
      return res.status(402).json({
        error: "Payment Required",
        message: "This endpoint requires x402 payment",
        payTo: splitterAddress,
        asset: usdcAddress,
        amount: "100000" // 0.1 USDC (6 decimals)
      });
    }

    // In a real implementation, you would verify the EIP-3009 signature here
    // For demo purposes, we'll accept the payment and forward to the splitter
    // The actual x402 flow: facilitator verifies signature, calls transferWithAuthorization
    // The USDC ends up in the splitter via the facilitator
    
    console.log(`Payment received for ${req.path}`);
    next();
  };

  // Protected endpoint - requires x402 payment
  app.get("/api/extract", x402Middleware, (req: express.Request, res: express.Response) => {
    // Simulate document extraction service
    const result = {
      text: "This is extracted text from your document.",
      confidence: 0.95,
      pages: 1,
      timestamp: new Date().toISOString()
    };
    res.json(result);
  });

  // Another protected endpoint
  app.post("/api/process", x402Middleware, (req: express.Request, res: express.Response) => {
    const { input } = req.body;
    const result = {
      output: `Processed: ${input}`,
      timestamp: new Date().toISOString()
    };
    res.json(result);
  });

  // Health check (no payment required)
  app.get("/health", (req: express.Request, res: express.Response) => {
    res.json({ status: "ok", splitter: splitterAddress });
  });

  // x402 well-known endpoint for payment requirements discovery
  app.get("/.well-known/x402", (req: express.Request, res: express.Response) => {
    res.json({
      payTo: splitterAddress,
      asset: usdcAddress,
      amount: "100000", // 0.1 USDC
      description: "Document extraction API"
    });
  });

  const PORT = parseInt(process.env.DEMO_SELLER_PORT || "3001");
  app.listen(PORT, () => {
    console.log(`Demo Seller running on port ${PORT}`);
    console.log(`Splitter: ${splitterAddress}`);
    console.log(`USDC: ${usdcAddress}`);
    console.log(`Endpoints:`);
    console.log(`  GET  /health`);
    console.log(`  GET  /.well-known/x402`);
    console.log(`  GET  /api/extract (requires x402 payment)`);
    console.log(`  POST /api/process (requires x402 payment)`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});