import { getPublicClient, getAccount, requireWalletClient } from '../_lib/chain.js';
import { config, explorerTx, formatUsdc, isAuthorized } from '../_lib/config.js';
import { erc20Abi, splitterAbi } from '../_lib/abi.js';
import { baseUrl, type Handler } from '../_lib/http.js';
import {
  decodeHeader,
  encodeHeader,
  transferWithAuthorizationTypes,
  usdcDomain,
  type PaymentChallenge,
  type PaymentResponse,
} from '../_lib/x402.js';
import { toHex } from 'viem';
import { randomBytes } from 'node:crypto';

/** Public RPC backends lag, so re-read a value until two reads agree. */
async function readStable<T>(read: () => Promise<T>, attempts = 5): Promise<T> {
  let previous = await read().catch(() => undefined as T);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(1500);
    const next = await read().catch(() => previous);
    if (next === previous) return next;
    previous = next;
  }
  return previous;
}

type Step = { step: string; ok: boolean; detail: string; data?: unknown };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Unauthenticated (dashboard) calls are throttled and volume-capped. */
const PUBLIC_MAX_AMOUNT = 100_000n; // 0.1 USDC
/** Per-account (the hosted buyer always pays from the operational wallet). */
const PUBLIC_COOLDOWN_MS = 5_000;

/**
 * Reserve the buyer wallet keeps after paying.
 *
 * Same reasoning as the seller: this wallet funds gas, and gas is real money on
 * mainnet, so the floor is configurable and defaults higher off testnet.
 */
const WALLET_FLOOR = BigInt(
  process.env.RUNWAY_DEMO_WALLET_FLOOR ??
    (config.network.includes('testnet') ? '500000' : '10000000'),
);
const PUBLIC_DAILY_CAP = 1_000_000n; // 1 USDC per UTC day
/**
 * The buyer and the seller are the same operational account, so every dashboard
 * click moves USDC out of that wallet and into the splitter, where part of it is
 * stranded by the contract accounting bugs. Refuse to run once the wallet drops
 * below this floor so the demo cannot drain itself to zero unattended.
 */

const lastBuyBy = new Map<string, number>();
let publicVolume = 0n;
let publicVolumeDay = new Date().getUTCDate();

/** Poll the splitter until the routed receipt is visible as unsettled revenue. */
async function waitForUnsettled(
  client: ReturnType<typeof getPublicClient>,
  splitter: `0x${string}`,
  attempts = 6,
): Promise<bigint> {
  let last = 0n;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      last = await client.readContract({
        address: splitter,
        abi: splitterAbi,
        functionName: 'getUnsettledRevenue',
      });
    } catch {
      last = 0n;
    }
    if (last > 0n) return last;
    await sleep(1500);
  }
  return last;
}

/**
 * Hosted buyer agent.
 *
 * Drives the complete x402 `exact`-scheme exchange against /api/x402/resource:
 *
 *   1. request the resource            -> expect 402 + payment challenge
 *   2. approve the seller (EIP-3009)   -> on-chain allowance
 *   3. sign the authorization          -> EIP-712 signature
 *   4. retry with `X-PAYMENT`          -> seller verifies, pulls, routes to splitter
 *   5. call the keeper                 -> settle() routes the lender share to the vault
 *
 * Guarded by the keeper secret so it cannot be used to burn protocol funds.
 */
const handler: Handler = async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const account = getAccount();
  if (!account) {
    res.status(500).json({ error: 'RUNWAY_PRIVATE_KEY is not configured' });
    return;
  }
  const payer = account.address.toLowerCase();

  const authenticated = isAuthorized(req);
  const today = new Date().getUTCDate();
  if (today !== publicVolumeDay) {
    publicVolumeDay = today;
    publicVolume = 0n;
  }
  if (!authenticated) {
    const since = lastBuyBy.get(payer) ?? 0;
    const wait = Date.now() - since;
    if (wait < PUBLIC_COOLDOWN_MS) {
      res.status(429).json({
        error: `Demo throttle: one payment every ${PUBLIC_COOLDOWN_MS / 1000}s per wallet.`,
        retryAfterMs: PUBLIC_COOLDOWN_MS - wait,
      });
      return;
    }
    if (publicVolume >= PUBLIC_DAILY_CAP) {
      res.status(429).json({
        error: 'Daily demo volume reached. Use the keeper secret for larger test payments.',
      });
      return;
    }
    lastBuyBy.set(payer, Date.now());
  }

  const steps: Step[] = [];
  const origin = baseUrl(req);
  const amountParam = Array.isArray(req.query.amount) ? req.query.amount[0] : req.query.amount;
  const shouldSettle = (Array.isArray(req.query.settle) ? req.query.settle[0] : req.query.settle) !== '0';

  let requestedAmount = PUBLIC_MAX_AMOUNT;
  if (amountParam && /^\d+$/.test(amountParam)) {
    const parsed = BigInt(amountParam);
    if (parsed > 0n && parsed <= 10_000_000n) requestedAmount = parsed;
  }
  if (!authenticated && requestedAmount > PUBLIC_MAX_AMOUNT) {
    requestedAmount = PUBLIC_MAX_AMOUNT;
  }

  const resourceUrl = `${origin}/api/x402/resource?amount=${requestedAmount}`;

  const client = getPublicClient();
  const wallet = await requireWalletClient();

  if (!authenticated) {
    const walletBalance = await client.readContract({
      address: config.usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    });
    if (walletBalance - requestedAmount < WALLET_FLOOR) {
      res.status(429).json({
        error:
          'Demo paused: the operational wallet would drop below its USDC floor. ' +
          'Fund it, or set x-keeper-secret for an authorised run.',
        walletBalance: walletBalance.toString(),
        floor: WALLET_FLOOR.toString(),
      });
      return;
    }
  }

  try {
    // ---- 1. Discover the price ------------------------------------------------
    const challengeResponse = await fetch(resourceUrl, { headers: { accept: 'application/json' } });
    const challengeHeader = challengeResponse.headers.get('x-payment');
    if (challengeResponse.status !== 402 || !challengeHeader) {
      throw new Error(
        `Expected HTTP 402 with an X-PAYMENT challenge, got ${challengeResponse.status}.`,
      );
    }
    const challenge = decodeHeader<PaymentChallenge>(challengeHeader);
    const terms = challenge.accepts[0];
    const amount = BigInt(terms.maxAmountRequired);
    steps.push({
      step: '402 challenge received',
      ok: true,
      detail: `${formatUsdc(amount)} USDC to ${terms.payTo} on ${terms.network} (${terms.scheme})`,
      data: terms,
    });

    if (terms.network !== config.network) {
      throw new Error(`Challenge is for network ${terms.network}, expected ${config.network}.`);
    }

    // ---- 2. Approve the seller ------------------------------------------------
    const currentAllowance = await client.readContract({
      address: config.usdc,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account.address, terms.payTo],
    });

    if (currentAllowance < amount) {
      const approveHash = await wallet.writeContract({
        address: config.usdc,
        abi: erc20Abi,
        functionName: 'approve',
        args: [terms.payTo, amount * 1000n],
      });
      const approveReceipt = await client.waitForTransactionReceipt({ hash: approveHash });
      steps.push({
        step: 'USDC approval granted',
        ok: approveReceipt.status === 'success',
        detail: `Approved ${terms.payTo} to pull ${formatUsdc(amount * 1000n)} USDC`,
        data: { hash: approveHash, explorer: explorerTx(approveHash) },
      });
    } else {
      steps.push({
        step: 'USDC approval already sufficient',
        ok: true,
        detail: `Existing allowance ${formatUsdc(currentAllowance)} USDC`,
      });
    }

    // ---- 3. Sign the EIP-3009 authorization -----------------------------------
    const block = await client.getBlock({ blockTag: 'latest' });
    const now = BigInt(block.timestamp);
    const authorization = {
      from: account.address,
      to: terms.payTo,
      value: amount,
      validAfter: now - 60n,
      validBefore: now + 300n,
      nonce: toHex(randomBytes(32)),
    } as const;

    const signature = await account.signTypedData({
      domain: usdcDomain(),
      types: transferWithAuthorizationTypes,
      primaryType: 'TransferWithAuthorization',
      message: authorization,
    });
    steps.push({
      step: 'EIP-3009 authorization signed',
      ok: true,
      detail: `nonce ${authorization.nonce.slice(0, 18)}… valid for 5 minutes`,
      data: { signature: `${signature.slice(0, 20)}…` },
    });

    // ---- 4. Pay and receive the resource -------------------------------------
    const paid = await fetch(resourceUrl, {
      headers: {
        accept: 'application/json',
        'x-payment': encodeHeader({
          x402Version: 1,
          scheme: terms.scheme,
          network: terms.network,
          payload: {
            signature,
            authorization: {
              from: authorization.from,
              to: authorization.to,
              value: authorization.value.toString(),
              validAfter: authorization.validAfter.toString(),
              validBefore: authorization.validBefore.toString(),
              nonce: authorization.nonce,
            },
          },
        }),
      },
    });

    const paymentResponseHeader = paid.headers.get('x-payment-response');
    const body = (await paid.json()) as Record<string, unknown>;
    if (!paid.ok || !paymentResponseHeader) {
      throw new Error(`Payment rejected (${paid.status}): ${JSON.stringify(body)}`);
    }
    const paymentResponse = decodeHeader<PaymentResponse>(paymentResponseHeader);
    steps.push({
      step: 'Resource delivered and receipt routed',
      ok: true,
      detail: `Paid ${formatUsdc(amount)} USDC; routed to ${config.splitter}`,
      data: {
        paymentResponse,
        resource: body.resource,
        paid: body.paid,
        transactions: body.transactions,
      },
    });

    // ---- 5. Settle ------------------------------------------------------------
    let settleResult: unknown = 'skipped';
    if (shouldSettle) {
      // Public RPC backends can lag a few blocks behind the one that produced
      // the receipt, so poll until the routed amount shows up as unsettled.
      const unsettled = await waitForUnsettled(client, config.splitter);
      if (unsettled > 0n) {
        const settleHash = await wallet.writeContract({
          address: config.splitter,
          abi: splitterAbi,
          functionName: 'settle',
        });
        const settleReceipt = await client.waitForTransactionReceipt({ hash: settleHash });
        settleResult = {
          ok: settleReceipt.status === 'success',
          hash: settleHash,
          explorer: explorerTx(settleHash),
          routed: unsettled.toString(),
        };
        steps.push({
          step: 'Keeper settled receipt',
          ok: settleReceipt.status === 'success',
          detail: `Routed ${formatUsdc(unsettled)} USDC (30% lender / 70% agent)`,
          data: { hash: settleHash, explorer: explorerTx(settleHash) },
        });
      } else {
        settleResult = 'nothing unsettled';
        steps.push({
          step: 'Keeper found nothing unsettled',
          ok: true,
          detail: 'Receipt already settled below the routing threshold.',
        });
      }
    }

    const vaultBalance = await readStable(() =>
      client.readContract({
        address: config.usdc,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [config.vault],
      }),
    );
    const agentClaimable = await readStable(() =>
      client.readContract({
        address: config.splitter,
        abi: splitterAbi,
        functionName: 'agentClaimable',
      }),
    );

    if (!authenticated) {
      publicVolume += amount;
    }

    res.status(200).json({
      ok: true,
      network: config.network,
      payer: account.address,
      amount: formatUsdc(amount),
      steps,
      settle: settleResult,
      treasury: {
        vault: config.vault,
        vaultBalance: vaultBalance.toString(),
        vaultBalanceFormatted: formatUsdc(vaultBalance),
        agentClaimable: agentClaimable.toString(),
        agentClaimableFormatted: formatUsdc(agentClaimable),
      },
      explorer: explorerTx(paymentResponse.transaction),
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      steps,
    });
  }
};

export default handler;
