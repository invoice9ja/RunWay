import { recoverTypedDataAddress } from 'viem';

import { getAccount, getPublicClient, requireWalletClient } from '../_lib/chain.js';
import { config, explorerTx, formatUsdc } from '../_lib/config.js';
import { erc20Abi } from '../_lib/abi.js';
import { baseUrl, header, type Handler } from '../_lib/http.js';
import {
  buildChallenge,
  decodeHeader,
  encodeHeader,
  transferWithAuthorizationTypes,
  usdcDomain,
  type PaymentPayload,
  type PaymentRequirements,
} from '../_lib/x402.js';

const RESOURCE_NAME = 'runway-x402-inference';
const RESOURCE_DESCRIPTION =
  'One hosted inference call, paid in USDC on Arc testnet. Receipt is routed through the agent RevenueSplitter.';

/**
 * x402 `exact`-scheme seller.
 *
 * GET without `X-PAYMENT`  -> 402 + `WWW-Authenticate` + base64 `X-PAYMENT` challenge.
 * GET with    `X-PAYMENT`  -> verify the EIP-3009 signature, pull the signed amount
 *                              with `transferWithAuthorization`, then forward the
 *                              whole receipt to the agent RevenueSplitter so the
 *                              keeper can route lender share first.
 */
const handler: Handler = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const resource = `${baseUrl(req)}/api/x402/resource`;
  const seller = requireSellerAddress();
  const amount = resolveAmount(req.query.amount);
  const challenge = buildChallenge(resource, seller, amount, RESOURCE_DESCRIPTION);

  const rawPayment = header(req, 'x-payment');
  if (!rawPayment) {
    res.setHeader('WWW-Authenticate', 'X-PAYMENT');
    res.setHeader('X-PAYMENT', encodeHeader(challenge));
    res.status(402).json({
      error: 'Payment required',
      accepts: challenge.accepts,
      hint: 'Retry with an X-PAYMENT header containing a signed EIP-3009 authorization.',
    });
    return;
  }

  let payment: PaymentPayload;
  try {
    payment = decodeHeader<PaymentPayload>(rawPayment);
  } catch {
    res.status(400).json({ error: 'Malformed X-PAYMENT header' });
    return;
  }

  const requirement: PaymentRequirements = challenge.accepts[0];
  const { signature, authorization } = payment.payload ?? ({} as never);

  if (!signature || !authorization) {
    res.status(400).json({ error: 'X-PAYMENT is missing signature or authorization' });
    return;
  }
  if (payment.scheme !== requirement.scheme || payment.network !== requirement.network) {
    res.status(400).json({
      error: `Unsupported payment scheme/network. Expected ${requirement.scheme}/${requirement.network}.`,
    });
    return;
  }

  const value = BigInt(authorization.value);
  const validAfter = BigInt(authorization.validAfter);
  const validBefore = BigInt(authorization.validBefore);

  if (authorization.to.toLowerCase() !== seller.toLowerCase()) {
    res.status(400).json({ error: 'Authorization recipient does not match the seller address' });
    return;
  }
  if (value < amount) {
    res.status(400).json({
      error: `Underpayment. Required at least ${formatUsdc(amount)} USDC.`,
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
    args: [authorization.from, seller],
  });
  if (allowance < value) {
    res.status(402).json({
      error: 'Payer has not approved the seller to pull this amount',
      requiredAllowance: value.toString(),
      currentAllowance: allowance.toString(),
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
    // Older USDC builds do not expose authorizationState; the on-chain nonce
    // check inside transferWithAuthorization still protects against replay.
  }

  const wallet = await requireWalletClient();

  // 1. Pull the signed amount from the payer to the seller (EIP-3009).
  const pullHash = await wallet.writeContract({
    address: config.usdc,
    abi: erc20Abi,
    functionName: 'transferWithAuthorization',
    args: [
      authorization.from,
      seller,
      value,
      validAfter,
      validBefore,
      authorization.nonce,
      signature,
    ],
  });
  const pullReceipt = await client.waitForTransactionReceipt({ hash: pullHash });

  // 2. Route the receipt into the agent RevenueSplitter.
  const routeHash = await wallet.writeContract({
    address: config.usdc,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [config.splitter, value],
  });
  const routeReceipt = await client.waitForTransactionReceipt({ hash: routeHash });

  const response = {
    success: true,
    transaction: routeHash,
    network: config.network,
    payer: authorization.from,
  };

  res.setHeader('X-PAYMENT-RESPONSE', encodeHeader(response));
  res.status(200).json({
    resource: RESOURCE_NAME,
    description: RESOURCE_DESCRIPTION,
    paid: formatUsdc(value),
    settled: routeReceipt.status === 'success',
    payer: authorization.from,
    seller,
    routedTo: config.splitter,
    revenueShareBps: 3000,
    transactions: {
      pull: { hash: pullHash, explorer: explorerTx(pullHash) },
      route: { hash: routeHash, explorer: explorerTx(routeHash) },
    },
    blocks: {
      pull: pullReceipt.blockNumber.toString(),
      route: routeReceipt.blockNumber.toString(),
    },
  });
};

function requireSellerAddress() {
  const account = getAccount();
  if (!account) {
    throw new Error('RUNWAY_PRIVATE_KEY is not set; the seller needs a payout address.');
  }
  return account.address;
}

function resolveAmount(raw: string | string[] | undefined): bigint {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d+$/.test(value)) return config.defaultPrice;
  const parsed = BigInt(value);
  // Cap the demo resource so the endpoint can never be drained in one call.
  return parsed > 0n && parsed <= 10_000_000n ? parsed : config.defaultPrice;
}

export default handler;
