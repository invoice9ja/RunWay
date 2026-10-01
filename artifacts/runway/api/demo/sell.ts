import { getPublicClient, getAccount, requireWalletClient } from '../_lib/chain.js';
import { config, explorerTx, formatUsdc, isAuthorized } from '../_lib/config.js';
import { erc20Abi, splitterAbi, vaultAbi } from '../_lib/abi.js';
import { baseUrl, type Handler } from '../_lib/http.js';
import {
  decodeHeader,
  encodeHeader,
  transferWithAuthorizationTypes,
  usdcDomain,
  type PaymentChallenge,
  type PaymentPayload,
} from '../_lib/x402.js';
import { recoverTypedDataAddress, toEventSelector, keccak256, toBytes } from 'viem';
import { randomBytes } from 'node:crypto';

/**
 * The demo seller, as a hosted endpoint.
 *
 * This is the SDK's `createSeller` running on Vercel: an unpaid request gets the
 * 402 challenge, a paid one is verified against the USDC domain and settled
 * before the handler runs. It exists so the seller integration can be exercised
 * over HTTP without running a local server.
 *
 * Gated the same way as /api/demo/buy, because settling a payment costs gas.
 */

const PUBLIC_MAX_AMOUNT = 100_000n; // 0.1 USDC
const PUBLIC_COOLDOWN_MS = 30_000;
const WALLET_FLOOR = 500_000n; // 0.5 USDC

let lastPublicRun = 0;

const amount = (value: bigint) => ({
  raw: value.toString(),
  formatted: formatUsdc(value),
});

const challenge = (resource: string, price: bigint): PaymentChallenge => ({
  x402Version: 1,
  error: 'Payment required',
  accepts: [
    {
      scheme: 'exact',
      network: config.network,
      maxAmountRequired: price.toString(),
      resource,
      description: 'Hosted Runway seller',
      mimeType: 'application/json',
      payTo: config.splitter,
      maxTimeoutSeconds: 300,
      asset: config.usdc,
      extra: { name: 'USDC', version: '2' },
    },
  ],
});

const handler: Handler = async (req, res) => {
  const origin = baseUrl(req);
  const resource = `${origin}/api/demo/sell`;
  const priceParam = req.query.price;
  let price = PUBLIC_MAX_AMOUNT;
  if (typeof priceParam === 'string' && /^\d+$/.test(priceParam)) {
    const parsed = BigInt(priceParam);
    if (parsed > 0n && parsed <= 10_000_000n) price = parsed;
  }
  const authenticated = isAuthorized(req);
  if (!authenticated) {
    price = price > PUBLIC_MAX_AMOUNT ? PUBLIC_MAX_AMOUNT : price;
    if (Date.now() - lastPublicRun < PUBLIC_COOLDOWN_MS) {
      res.status(429).json({
        error: `Seller throttle: one payment every ${PUBLIC_COOLDOWN_MS / 1000}s.`,
        retryAfterMs: PUBLIC_COOLDOWN_MS - (Date.now() - lastPublicRun),
      });
      return;
    }
  }

  // Discovery, so a client can price a call before paying.
  if (req.url?.includes('/.well-known/x402')) {
    res.status(200).json(challenge(resource, price));
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const rawPayment = (() => {
    const header = req.headers['x-payment'];
    const value = Array.isArray(header) ? header[0] : header;
    return value;
  })();

  if (!rawPayment) {
    res.setHeader('WWW-Authenticate', 'Payment x402');
    res.status(402).json(challenge(resource, price));
    return;
  }

  if (!authenticated) lastPublicRun = Date.now();

  let payment: PaymentPayload;
  try {
    payment = decodeHeader<PaymentPayload>(rawPayment);
  } catch {
    res.status(400).json({ error: 'Malformed X-PAYMENT header' });
    return;
  }

  const requirement = challenge(resource, price).accepts[0];
  const { signature, authorization } = payment.payload ?? ({} as never);
  if (!signature || !authorization) {
    res.status(400).json({ error: 'X-PAYMENT is missing signature or authorization' });
    return;
  }
  if (payment.scheme !== 'exact' || payment.network !== config.network) {
    res.status(400).json({ error: `Expected exact/${config.network}` });
    return;
  }

  const value = BigInt(authorization.value);
  const validAfter = BigInt(authorization.validAfter);
  const validBefore = BigInt(authorization.validBefore);

  if (authorization.to.toLowerCase() !== config.splitter.toLowerCase()) {
    res.status(400).json({ error: 'Authorization recipient does not match the seller' });
    return;
  }
  if (value < price) {
    res.status(400).json({
      error: `Underpayment: ${formatUsdc(value)} USDC, need ${formatUsdc(price)}`,
    });
    return;
  }

  const client = getPublicClient();

  const block = await client.getBlock({ blockTag: 'latest' });
  const now = BigInt(block.timestamp);
  if (now < validAfter) {
    res.status(400).json({ error: 'Authorization is not valid yet' });
    return;
  }
  if (now > validBefore) {
    res.status(400).json({ error: 'Authorization has expired' });
    return;
  }

  const recovered = await recoverTypedDataAddress({
    domain: usdcDomain(),
    types: transferWithAuthorizationTypes,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from,
      to: authorization.to,
      value,
      validAfter,
      validBefore,
      nonce: authorization.nonce,
    },
    signature,
  });
  if (recovered.toLowerCase() !== authorization.from.toLowerCase()) {
    res.status(401).json({ error: 'Signature does not match the authorizing payer' });
    return;
  }

  const allowance = await client.readContract({
    address: config.usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [authorization.from, config.splitter],
  });
  if (allowance < value) {
    res.status(402).json({
      error: 'Payer has not approved the seller to pull this amount',
      requiredAllowance: value.toString(),
      currentAllowance: allowance.toString(),
      hint: 'Call approve(splitter, amount) on USDC first. EIP-3009 is a pull.',
    });
    return;
  }

  try {
    const state = await client.readContract({
      address: config.usdc,
      abi: erc20Abi,
      functionName: 'authorizationState',
      args: [authorization.from, authorization.nonce],
    });
    if (state) {
      res.status(409).json({ error: 'Authorization nonce has already been used' });
      return;
    }
  } catch {
    // Older USDC builds lack authorizationState; the on-chain nonce check in
    // transferWithAuthorization still prevents replay.
  }

  if (!authenticated) {
    const walletBalance = await client.readContract({
      address: config.usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [getAccount()!.address],
    });
    if (walletBalance - value < WALLET_FLOOR) {
      res.status(503).json({
        error: `Operational wallet is at or below the ${formatUsdc(WALLET_FLOOR)} USDC floor. Refusing to spend.`,
      });
      return;
    }
  }

  const wallet = await requireWalletClient();
  const body = signature.slice(2);
  const v = parseInt(body.slice(128, 130), 16);

  // ecrecover wants v as 27/28. viem and wallets return 0/1.
  const pullHash = await wallet.writeContract({
    address: config.usdc,
    abi: erc20Abi,
    functionName: 'transferWithAuthorization',
    args: [
      authorization.from,
      config.splitter,
      value,
      validAfter,
      validBefore,
      authorization.nonce,
      v >= 27 ? v : v + 27,
      `0x${body.slice(0, 64)}`,
      `0x${body.slice(64, 128)}`,
    ],
  } as never);
  const pullReceipt = await client.waitForTransactionReceipt({ hash: pullHash });

  const routeHash = await wallet.writeContract({
    address: config.usdc,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [config.splitter, value],
  } as never);
  const routeReceipt = await client.waitForTransactionReceipt({ hash: routeHash });

  res.setHeader(
    'X-PAYMENT-RESPONSE',
    encodeHeader({ success: true, transaction: routeHash, payer: authorization.from }),
  );
  res.status(200).json({
    resource: 'runway-hosted-seller',
    description: 'Hosted Runway seller',
    paid: amount(value),
    payer: authorization.from,
    seller: config.splitter,
    routedTo: config.splitter,
    revenueShareBps: 3000,
    settled: pullReceipt.status === 'success' && routeReceipt.status === 'success',
    transactions: {
      pull: { hash: pullHash, explorer: explorerTx(pullHash) },
      route: { hash: routeHash, explorer: explorerTx(routeHash) },
    },
  });
};

export default handler;