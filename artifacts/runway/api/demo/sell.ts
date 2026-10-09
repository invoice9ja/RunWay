import { getPublicClient, getAccount, requireWalletClient } from '../_lib/chain.js';
import { config, explorerTx, formatUsdc, isAuthorized } from '../_lib/config.js';
import { erc20Abi, splitterAbi, vaultAbi } from '../_lib/abi.js';
import { baseUrl, type Handler } from '../_lib/http.js';
import { splitSignature } from '../_lib/signature.js';
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
/**
 * Per-payer, not global. The old single-instance cooldown blocked the *next*
 * payment from the same human (and even the free price-discovery read), which
 * made consecutive test payments impossible. Rotation still can't exhaust the
 * operator wallet: the daily volume cap and the WALLET_FLOOR check bound the
 * real cost regardless of how fast distinct wallets arrive.
 */
const PUBLIC_COOLDOWN_MS = 5_000;

/**
 * Reserve the operator wallet must keep after paying.
 *
 * Settling a payment costs the operator real gas, and on mainnet that gas is
 * real USDC. A floor of a fraction of a dollar is a rounding error there, so the
 * amount is configurable and defaults higher off testnet.
 */
const WALLET_FLOOR = BigInt(
  process.env.RUNWAY_DEMO_WALLET_FLOOR ??
    // 10 USDC on mainnet, 0.5 on testnet where gas is worthless.
    (config.network.includes('testnet') ? '500000' : '10000000'),
);

/**
 * Ceiling on settled payments per hour, across all payers.
 *
 * The per-payer cooldown bounds one wallet, not a fleet of them: a bot can mint
 * addresses cheaply and pay once from each, and every one of those transactions
 * is gas the operator funds. This is the bound that actually caps the exposure.
 */
const MAX_PAYMENTS_PER_HOUR = Number(
  process.env.RUNWAY_DEMO_MAX_PAYMENTS_PER_HOUR ?? (config.network.includes('testnet') ? '240' : '30'),
);

const paidAt: number[] = [];

const lastPaidBy = new Map<string, number>();

/** Best-effort payer in a payment header; 'unknown' when undecodable. */
function payerOf(rawPayment: string): string {
  try {
    const payload = decodeHeader<PaymentPayload>(rawPayment);
    const from = payload?.payload?.authorization?.from;
    return from ? from.toLowerCase() : 'unknown';
  } catch {
    return 'unknown';
  }
}

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
  // Advertise the stable resource path so a buyer paying /resource is told about
  // /resource, not about the bare seller endpoint.
  const resource = `${origin}/api/demo/sell/resource`;
  const priceParam = req.query.price;
  let price = PUBLIC_MAX_AMOUNT;
  if (typeof priceParam === 'string' && /^\d+$/.test(priceParam)) {
    const parsed = BigInt(priceParam);
    if (parsed > 0n && parsed <= 10_000_000n) price = parsed;
  }
  const authenticated = isAuthorized(req);
  if (!authenticated) {
    price = price > PUBLIC_MAX_AMOUNT ? PUBLIC_MAX_AMOUNT : price;
  }

  // Discovery and the unpaid 402 challenge are free: they cost the protocol no
  // gas, so they are never throttled. Only a request that actually pays settles
  // the splitter, and only those are rate-limited.
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

  if (!authenticated) {
    const payer = payerOf(rawPayment);
    const since = lastPaidBy.get(payer) ?? 0;
    const wait = Date.now() - since;
    if (wait < PUBLIC_COOLDOWN_MS) {
      res.status(429).json({
        error: `Demo throttle: one payment every ${PUBLIC_COOLDOWN_MS / 1000}s per wallet.`,
        retryAfterMs: PUBLIC_COOLDOWN_MS - wait,
      });
      return;
    }
    lastPaidBy.set(payer, Date.now());

    // Global ceiling, across payers. In-memory and per instance, which is a
    // floor on the real limit rather than a hard one; the wallet floor below is
    // what actually stops the operator running dry.
    const hourAgo = Date.now() - 3_600_000;
    while (paidAt.length > 0 && paidAt[0] < hourAgo) paidAt.shift();
    if (paidAt.length >= MAX_PAYMENTS_PER_HOUR) {
      res.status(429).json({
        error: `Demo capacity: ${MAX_PAYMENTS_PER_HOUR} payments per hour reached. Try again shortly.`,
        retryAfterMs: 3_600_000 - (Date.now() - hourAgo),
      });
      return;
    }
    paidAt.push(Date.now());
  }

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

  // A malformed signature throws in viem rather than returning a recovered
  // address, and an unhandled throw surfaces as a 500 to the buyer. Turn that
  // into an explicit unpayable reject instead.
  let recovered: `0x${string}`;
  try {
    recovered = await recoverTypedDataAddress({
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
  } catch {
    res.status(401).json({ error: 'Signature is malformed' });
    return;
  }
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
      ...splitSignature(signature),
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