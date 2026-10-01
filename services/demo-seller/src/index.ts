#!/usr/bin/env node

/**
 * Demo seller: a paid endpoint whose revenue routes through a Runway splitter.
 *
 * This is what an integration looks like. The x402 verification, the EIP-3009
 * pull and the routing are all the SDK; the only application-specific parts are
 * the two endpoints and the price.
 *
 * Run it, then buy from it with any x402 client.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env' });

import express from 'express';
import {
  createRunwayClient,
  createSeller,
  formatUsdc,
  getSplitterStatus,
  usdc,
  type Address,
} from '@workspace/runway-sdk';

async function main() {
  const splitter = process.env.RUNWAY_SPLITTER_ADDRESS as Address | undefined;
  if (!splitter) {
    throw new Error('RUNWAY_SPLITTER_ADDRESS is not set. Deploy a splitter or set one in .env.');
  }

  const runway = createRunwayClient({
    chainId: Number(process.env.RUNWAY_CHAIN_ID ?? 5042002),
    network: process.env.RUNWAY_NETWORK ?? 'arc-testnet',
    rpcUrl: process.env.ARC_TESTNET_RPC!,
    // Signing is needed to pull the payment and route it.
    privateKey: process.env.PRIVATE_KEY as `0x${string}`,
  });

  const port = Number(process.env.DEMO_SELLER_PORT ?? 3001);
  const origin = `http://localhost:${port}`;
  const price = usdc(Number(process.env.DEMO_SELLER_PRICE ?? 0.1));

  const seller = createSeller({
    runway,
    splitter,
    price,
    description: 'Document extraction',
    resource: `${origin}/api/extract`,
  });

  const status = await getSplitterStatus(runway, splitter);
  console.log(`Demo seller on ${runway.config.network}`);
  console.log(`  splitter  ${splitter}`);
  console.log(`  revenue   ${formatUsdc(status.lifetimeRevenue)} USDC lifetime`);
  console.log(`  unsettled ${formatUsdc(status.unsettled)} USDC`);
  console.log(`  price     ${formatUsdc(price)} USDC per call`);
  console.log(`  endpoints GET /health, GET /.well-known/x402, GET /api/extract, POST /api/process`);

  const app = express();
  app.use(express.json());

  /**
   * x402 gate. An unpaid request gets the 402 challenge; a paid one is verified
   * and settled before the handler runs.
   */
  const requirePayment = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const header = req.headers['x-payment'];
    const raw = Array.isArray(header) ? header[0] : header;

    const result = await seller.verify(raw);
    if (!result.ok) {
      if (result.status === 402 && result.error.includes('X-PAYMENT')) {
        // No payment offered at all: this is the discovery response.
        res.setHeader('WWW-Authenticate', 'Payment x402');
        res.status(402).json(seller.challenge());
        return;
      }
      res.status(result.status).json({ error: result.error, requiredAllowance: result.requiredAllowance });
      return;
    }

    res.setHeader('X-PAYMENT-RESPONSE', Buffer.from(JSON.stringify({
      success: true,
      transaction: result.transactions.route,
      payer: result.payer,
      network: runway.config.network,
    })).toString('base64'));
    next();
  };

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', splitter, network: runway.config.network });
  });

  // Discovery, so a client can price a call before paying.
  app.get('/.well-known/x402', (_req, res) => {
    res.json(seller.challenge());
  });

  app.get('/api/extract', requirePayment, (_req, res) => {
    res.json({
      text: 'Extracted text from your document.',
      confidence: 0.95,
      pages: 1,
    });
  });

  app.post('/api/process', requirePayment, (req, res) => {
    const { input } = req.body as { input?: string };
    res.json({ output: `Processed: ${input ?? ''}` });
  });

  app.listen(port, () => {
    console.log(`\nListening on ${origin}`);
    console.log(`Try: curl -i ${origin}/api/extract   # expect 402 with the payment requirements`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});