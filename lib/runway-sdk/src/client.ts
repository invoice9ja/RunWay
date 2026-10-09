import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  http,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
  type Abi,
  type Address,
  type Chain,
  type LocalAccount,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  allowanceAbi,
  ARC_TESTNET_CHAIN_ID,
  authorizationStateAbi,
  createSplitterAbi,
  agentAbi,
  payoutAbi,
  shareBpsAbi,
  getBalanceAbi,
  lifetimeRevenueAbi,
  unsettledAbi,
  agentClaimableAbi,
  advanceHeldAbi,
  agentOwedAbi,
  debtOwedAbi,
  loanActiveAbi,
  loanOpenedEvent,
  openLoanAbi,
  getVaultBalanceAbi,
  totalOutstandingAbi,
  loansLengthAbi,
  settleAbi,
  withdrawAbi,
  splitterCreatedEvent,
  transferAbi,
  transferWithAuthorizationAbi,
  factoryAbi,
  splitterAbi,
  transferWithAuthorizationTypes,
  usdcDomain,
  vaultAbi,
  FACTORY_ARC_TESTNET,
  USDC_ARC_TESTNET,
  VAULT_ARC_TESTNET,
  type Authorization,
  type PaymentChallenge,
  type PaymentPayload,
  type PaymentRequirements,
} from './types.js';

const DECIMALS = 6n;
const USDC_UNIT = 10n ** DECIMALS;

/** USDC amount helper: `usdc(0.1)` for a human-readable number. */
export function usdc(amount: number | bigint): bigint {
  if (typeof amount === 'bigint') return amount;
  // Scale through a string so 0.1 does not become 0.1000000000000000055.
  const [whole, frac = ''] = amount.toString().split('.');
  const padded = frac.padEnd(6, '0').slice(0, 6);
  return BigInt(whole) * USDC_UNIT + BigInt(padded || '0');
}

export function formatUsdc(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / USDC_UNIT;
  const frac = (abs % USDC_UNIT).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export type RunwayConfig = {
  /** Chain id the payment settles on. Part of the EIP-712 domain. */
  chainId: number;
  /** Human label used in the challenge's `network` field. */
  network: string;
  rpcUrl: string;
  /** USDC on this chain. Defaults to Arc testnet. */
  usdc?: Address;
  factory?: Address;
  vault?: Address;
};

export type RunwayClient = {
  config: Required<RunwayConfig>;
  chain: Chain;
  publicClient: PublicClient;
  /** Present only when a private key was supplied. */
  wallet?: { account: LocalAccount; client: ReturnType<typeof createWalletClient> };
  explorerAddress(address: string): string;
  explorerTx(hash: string): string;
};

export type CreateClientOptions = RunwayConfig & {
  chain?: Chain;
  /** Operational key. Needed to route receipts, open advances and settle. */
  privateKey?: `0x${string}`;
};

/**
 * Build a Runway client.
 *
 * The chain is defined from `chainId` rather than imported, because the EIP-712
 * domain is part of the signature a payer produces. Hardcoding one network here
 * silently breaks every payment on any other.
 */
export function createRunwayClient(options: CreateClientOptions): RunwayClient {
  /**
   * The vault and factory defaults are this repository's testnet deployment.
   *
   * On any other chain they are worse than useless: the caller signs for the
   * chain they asked for, and the contract calls land on an address that has no
   * code there. Every failure then looks like a deployment problem rather than a
   * configuration one. So the assumption is refused rather than made.
   */
  if (options.chainId !== ARC_TESTNET_CHAIN_ID && !(options.vault && options.factory)) {
    throw new Error(
      `Chain ${options.chainId} is not Arc testnet (${ARC_TESTNET_CHAIN_ID}), so the ` +
        'bundled vault and factory addresses do not apply. Pass `vault` and `factory` ' +
        'for this deployment explicitly.',
    );
  }

  const config: Required<RunwayConfig> = {
    chainId: options.chainId,
    network: options.network,
    rpcUrl: options.rpcUrl,
    // USDC sits at the same address on Arc testnet and mainnet.
    usdc: options.usdc ?? USDC_ARC_TESTNET,
    factory: options.factory ?? FACTORY_ARC_TESTNET,
    vault: options.vault ?? VAULT_ARC_TESTNET,
  };

  const chain =
    options.chain ??
    defineChain({
      id: config.chainId,
      name: config.network,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    });

  const transport = http(config.rpcUrl, { retryCount: 2, timeout: 20_000 });
  const publicClient = createPublicClient({ chain, transport }) as PublicClient;

  let wallet: RunwayClient['wallet'];
  if (options.privateKey) {
    const account = privateKeyToAccount(options.privateKey);
    wallet = { account, client: createWalletClient({ chain, transport, account }) };
  }

  const explorerBase = config.network.includes('testnet')
    ? 'https://explorer.testnet.arc.io'
    : 'https://explorer.arc.io';

  return {
    config,
    chain,
    publicClient,
    wallet,
    explorerAddress: (address) => `${explorerBase}/address/${address}`,
    explorerTx: (hash) => `${explorerBase}/tx/${hash}`,
  };
}

function requireWallet(runway: RunwayClient) {
  if (!runway.wallet) {
    throw new Error(
      'This action needs a private key. Create the client with { privateKey } to sign transactions.',
    );
  }
  return runway.wallet;
}

/**
 * Sign one contract write.
 *
 * viem infers a call's arguments from the ABI *and* the chain type. The chain is
 * built at runtime from `chainId`, so its type stays generic and every call
 * mismatches even when the ABI is exactly right. Each call site passes a
 * single-function ABI that viem checks; only the generic chain is asserted here.
 */
async function write(
  runway: RunwayClient,
  params: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] },
): Promise<`0x${string}`> {
  const { client } = requireWallet(runway);
  return client.writeContract(params as never) as Promise<`0x${string}`>;
}

// --------------------------------------------------------------------------
// Seller side
// --------------------------------------------------------------------------

export type SellerOptions = {
  runway: RunwayClient;
  /** Splitter that receives the revenue. */
  splitter: Address;
  /** Price per call in USDC. Use `usdc(0.1)`. */
  price: bigint;
  description: string;
  mimeType?: string;
  /** Where the challenge advertises itself, e.g. the public origin. */
  resource: string;
  /** How long a signed authorization stays valid. Defaults to 5 minutes. */
  maxTimeoutSeconds?: number;
};

export type Seller = {
  challenge(): PaymentChallenge;
  /** Verifies and settles an `X-PAYMENT` header. Returns null if it is valid. */
  verify(rawHeader: string | undefined): Promise<PaymentVerification>;
};

export type PaymentVerification =
  | { ok: false; status: number; error: string; requiredAllowance?: string }
  | {
      ok: true;
      payer: Address;
      value: bigint;
      /** Pull from payer, then the route into the splitter. */
      transactions: { pull: `0x${string}`; route: `0x${string}` };
      explorer: { pull: string; route: string };
    };

/**
 * Build a seller that accepts x402 payments and routes them to a splitter.
 *
 * This is the whole integration. The returned `challenge()` produces the 402
 * body, and `verify()` settles an `X-PAYMENT` header: it recovers the EIP-712
 * signature against the USDC domain, checks the amount, the window, the
 * recipient, the allowance and the nonce, pulls the funds, then forwards them
 * into the splitter so the lender's share can be settled from that revenue.
 */
export function createSeller(options: SellerOptions): Seller {
  const { runway, splitter, price, description, resource } = options;
  const mimeType = options.mimeType ?? 'application/json';
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? 300;

  const requirements: PaymentRequirements = {
    scheme: 'exact',
    network: runway.config.network,
    maxAmountRequired: price.toString(),
    resource,
    description,
    mimeType,
    payTo: splitter,
    maxTimeoutSeconds,
    asset: runway.config.usdc,
    extra: { name: 'USDC', version: '2' },
  };

  const challenge = (): PaymentChallenge => ({
    x402Version: 1,
    error: 'Payment required',
    accepts: [requirements],
  });

  async function verify(rawHeader: string | undefined): Promise<PaymentVerification> {
    if (!rawHeader) {
      return { ok: false, status: 402, error: 'X-PAYMENT header is missing' };
    }

    let payment: PaymentPayload;
    try {
      payment = JSON.parse(Buffer.from(rawHeader, 'base64').toString('utf8'));
    } catch {
      return { ok: false, status: 400, error: 'Malformed X-PAYMENT header' };
    }

    const { signature, authorization } = payment.payload ?? ({} as never);
    if (!signature || !authorization) {
      return { ok: false, status: 400, error: 'X-PAYMENT is missing signature or authorization' };
    }
    if (payment.scheme !== 'exact' || payment.network !== runway.config.network) {
      return {
        ok: false,
        status: 400,
        error: `Expected exact/${runway.config.network}, received ${payment.scheme}/${payment.network}`,
      };
    }

    const value = BigInt(authorization.value);
    const validAfter = BigInt(authorization.validAfter);
    const validBefore = BigInt(authorization.validBefore);

    if (authorization.to.toLowerCase() !== splitter.toLowerCase()) {
      return { ok: false, status: 400, error: 'Authorization recipient is not this seller' };
    }
    if (value < price) {
      return { ok: false, status: 400, error: `Underpayment: ${formatUsdc(value)} < ${formatUsdc(price)} USDC` };
    }

    const block = await runway.publicClient.getBlock({ blockTag: 'latest' });
    const now = BigInt(block.timestamp);
    if (now < validAfter) return { ok: false, status: 400, error: 'Authorization is not valid yet' };
    if (now > validBefore) return { ok: false, status: 400, error: 'Authorization has expired' };

    const recovered = await recoverTypedDataAddress({
      domain: usdcDomain(runway.config.chainId, runway.config.usdc),
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
      return { ok: false, status: 401, error: 'Signature does not match the authorizing payer' };
    }

    const allowance = await runway.publicClient.readContract({
      address: runway.config.usdc,
      abi: allowanceAbi,
      functionName: 'allowance',
      args: [authorization.from, splitter],
    });
    if (allowance < value) {
      return {
        ok: false,
        status: 402,
        error: 'Payer has not approved the seller to pull this amount',
        requiredAllowance: value.toString(),
      };
    }

    try {
      const state = await runway.publicClient.readContract({
        address: runway.config.usdc,
        abi: authorizationStateAbi,
        functionName: 'authorizationState',
        args: [authorization.from, authorization.nonce],
      });
      if (state) {
        return { ok: false, status: 409, error: 'Authorization nonce has already been used' };
      }
    } catch {
      // Older USDC builds lack authorizationState; the on-chain nonce check in
      // transferWithAuthorization still prevents replay.
    }

    requireWallet(runway);

    // Split the signature into v/r/s, which is how the contract expects it.
    const sig = splitSignature(signature);

    const pullHash = await write(runway, {
      address: runway.config.usdc,
      abi: transferWithAuthorizationAbi,
      functionName: 'transferWithAuthorization',
      args: [
        authorization.from,
        splitter,
        value,
        validAfter,
        validBefore,
        authorization.nonce,
        sig.v,
        sig.r,
        sig.s,
      ],
    });
    await runway.publicClient.waitForTransactionReceipt({ hash: pullHash });

    // The pull already lands in the splitter, so revenue is attributed without a
    // second hop. Kept explicit in case the seller address differs from the
    // splitter, which happens when a gateway fronts the endpoint.
    let routeHash: `0x${string}` = pullHash;
    if (splitter.toLowerCase() !== runway.wallet!.account.address.toLowerCase()) {
      routeHash = await write(runway, {
        address: runway.config.usdc,
        abi: transferAbi,
        functionName: 'transfer',
        args: [splitter, value],
      });
      await runway.publicClient.waitForTransactionReceipt({ hash: routeHash });
    }

    return {
      ok: true,
      payer: authorization.from,
      value,
      transactions: { pull: pullHash, route: routeHash },
      explorer: { pull: runway.explorerTx(pullHash), route: runway.explorerTx(routeHash) },
    };
  }

  return { challenge, verify };
}

/**
 * Split an EIP-712 signature into the `v`, `r`, `s` that `ecrecover` expects.
 *
 * `v` must be 27 or 28. Wallets and viem return 0 or 1, and normalizing to that
 * makes every transferWithAuthorization revert with "invalid signature 'v'
 * value". Kept at 27/28 on the way out.
 */
export function splitSignature(signature: `0x${string}`) {
  const body = signature.slice(2);
  const r = `0x${body.slice(0, 64)}` as `0x${string}`;
  const s = `0x${body.slice(64, 128)}` as `0x${string}`;
  const raw = parseInt(body.slice(128, 130), 16);
  const v = raw >= 27 ? raw : raw + 27;
  return { r, s, v };
}

// --------------------------------------------------------------------------
// Agent side
// --------------------------------------------------------------------------

/**
 * Deploy a splitter for an agent through the factory.
 *
 * The factory holds the deployment role, so this needs a key with
 * `DEFAULT_ADMIN_ROLE` on it. On the shared testnet deployment that is the
 * deployer account; a self-hosted instance would grant it to the integrator.
 */
export async function createSplitter(
  runway: RunwayClient,
  params: { agent: Address; payout?: Address },
): Promise<Address> {
  requireWallet(runway);
  const hash = await write(runway, {
    address: runway.config.factory,
    abi: createSplitterAbi,
    functionName: 'createSplitter',
    args: [params.agent, params.payout ?? params.agent],
  });
  const receipt = await runway.publicClient.waitForTransactionReceipt({ hash });
  const created = receipt.logs
    .map((log) => {
      try {
        const decoded = decodeEventLog({
          abi: [splitterCreatedEvent],
          data: log.data,
          topics: log.topics as never,
        });
        return decoded as { eventName?: string; args?: Record<string, unknown> };
      } catch {
        return null;
      }
    })
    .find((entry) => entry?.eventName === 'SplitterCreated');
  const splitter = created?.args?.splitter as Address | undefined;
  if (!splitter) throw new Error('Splitter created but the address could not be decoded from logs');
  return splitter;
}

/**
 * Route settled revenue and report what the agent is owed.
 *
 * `settle()` is permissionless, so a keeper can call it on the agent's behalf.
 * It pays the lender share from the revenue that just arrived, then credits the
 * remainder to the agent.
 */
export async function settle(runway: RunwayClient, splitter: Address) {
  requireWallet(runway);
  const hash = await write(runway, {
    address: splitter,
    abi: settleAbi,
    functionName: 'settle',
  });
  const receipt = await runway.publicClient.waitForTransactionReceipt({ hash });
  return { hash, explorer: runway.explorerTx(hash), receipt };
}

/**
 * Claim everything the splitter owes the agent: earned revenue first, then any
 * unspent working capital from an advance.
 *
 * `withdraw()` pulls the whole owed amount and sends it to the splitter's
 * `payout` address, so the caller must hold the splitter's AGENT_ROLE. There is
 * no amount argument on-chain - the splitter decides what is claimable.
 */
export async function withdraw(runway: RunwayClient, splitter: Address) {
  requireWallet(runway);
  const hash = await write(runway, {
    address: splitter,
    abi: withdrawAbi,
    functionName: 'withdraw',
  });
  const receipt = await runway.publicClient.waitForTransactionReceipt({ hash });
  return { hash, explorer: runway.explorerTx(hash), receipt };
}

export type SplitterStatus = {
  address: Address;
  explorer: string;
  agent: Address;
  payout: Address;
  shareBps: number;
  balance: bigint;
  lifetimeRevenue: bigint;
  unsettled: bigint;
  claimable: bigint;
  advanceHeld: bigint;
  agentOwed: bigint;
  debtOwed: bigint;
  loanActive: boolean;
};

export async function getSplitterStatus(
  runway: RunwayClient,
  splitter: Address,
): Promise<SplitterStatus> {
  // Batch the raw calls by hand rather than through viem's multicall helper.
  // That helper resolves the multicall3 address from the chain definition, and a
  // chain built from `chainId` alone has no such contract configured. These are
  // static view calls, so one JSON-RPC batch is equivalent and dependency-free.
  const calls = [
    agentAbi, payoutAbi, shareBpsAbi, getBalanceAbi, lifetimeRevenueAbi,
    unsettledAbi, agentClaimableAbi, advanceHeldAbi, agentOwedAbi, debtOwedAbi,
    loanActiveAbi,
  ].map((abi) => ({
    address: splitter,
    abi: abi as Abi,
    functionName: (abi[0] as { name: string }).name as string,
  }));

  const results = await Promise.all(
    calls.map((call) =>
      runway.publicClient.readContract({
        address: call.address,
        abi: call.abi,
        functionName: call.functionName,
      } as never),
    ),
  );

  const [agent, payout, shareBps, balance, lifetimeRevenue, unsettled, claimable, advanceHeld, agentOwed, debtOwed, loanActive] =
    results as unknown as [
      Address, Address, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean,
    ];

  return {
    address: splitter,
    explorer: runway.explorerAddress(splitter),
    agent,
    payout,
    shareBps: Number(shareBps),
    balance,
    lifetimeRevenue,
    unsettled,
    claimable,
    advanceHeld,
    agentOwed,
    debtOwed,
    loanActive,
  };
}

/**
 * Request an advance against lifetime revenue.
 *
 * Needs the vault's `UNDERWRITER_ROLE`. The cap is
 * `min(STARTER_CAP + 2 * lifetimeRevenue, GLOBAL_MAX)` and is enforced on-chain,
 * so an oversized request reverts rather than silently over-advancing.
 */
export async function requestAdvance(
  runway: RunwayClient,
  params: { splitter: Address; principal: bigint; rationale?: string },
): Promise<{ hash: `0x${string}`; loanId: bigint; explorer: string; rationaleHash: `0x${string}` }> {
  requireWallet(runway);
  const rationaleHash = keccakText(params.rationale ?? 'runway-sdk advance request');
  const hash = await write(runway, {
    address: runway.config.vault,
    abi: openLoanAbi,
    functionName: 'openLoan',
    args: [params.splitter, params.principal, rationaleHash],
  });
  const receipt = await runway.publicClient.waitForTransactionReceipt({ hash });
  const loanId = receipt.logs
    .map((log) => {
      try {
        return decodeEventLog({
          abi: [loanOpenedEvent],
          data: log.data,
          topics: log.topics as never,
        }) as { eventName?: string; args?: Record<string, unknown> };
      } catch {
        return null;
      }
    })
    .find((entry) => entry?.eventName === 'LoanOpened')?.args?.loanId;

  return {
    hash,
    loanId: loanId as bigint,
    explorer: runway.explorerTx(hash),
    rationaleHash,
  };
}

/** keccak256 over UTF-8 text, used to commit a rationale to a loan. */
function keccakText(text: string): `0x${string}` {
  return keccak256(toBytes(text));
}

export type VaultStatus = {
  balance: bigint;
  totalOutstanding: bigint;
  loans: number;
  explorer: string;
};

export async function getVaultStatus(runway: RunwayClient): Promise<VaultStatus> {
  const [balance, totalOutstanding, loans] = await Promise.all([
    runway.publicClient.readContract({
      address: runway.config.vault,
      abi: getVaultBalanceAbi,
      functionName: 'getBalance',
    }),
    runway.publicClient.readContract({
      address: runway.config.vault,
      abi: totalOutstandingAbi,
      functionName: 'getTotalOutstanding',
    }),
    runway.publicClient.readContract({
      address: runway.config.vault,
      abi: loansLengthAbi,
      functionName: 'getLoansLength',
    }),
  ]);
  return {
    balance,
    totalOutstanding,
    loans: Number(loans),
    explorer: runway.explorerAddress(runway.config.vault),
  };
}

export type { Authorization, PaymentChallenge, PaymentPayload, PaymentRequirements };