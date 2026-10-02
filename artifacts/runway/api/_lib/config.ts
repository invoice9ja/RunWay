import type { Address } from 'viem';

const read = (key: string, fallback = ''): string => {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
};

const readAddress = (key: string, fallback: Address): Address =>
  read(key, fallback).trim() as Address;

export const config = {
  /** Arc testnet public RPC. No API key, so it is safe to ship in the client too. */
  rpcUrl: read('RUNWAY_RPC_URL', 'https://rpc.testnet.arc.network'),
  chainId: Number(read('RUNWAY_CHAIN_ID', '5042002')),
  /** x402 `network` identifier. */
  network: read('RUNWAY_NETWORK', 'arc-testnet'),
  explorer: read('RUNWAY_EXPLORER_URL', 'https://explorer.testnet.arc.io'),

  usdc: readAddress(
    'RUNWAY_USDC_ADDRESS',
    '0x3600000000000000000000000000000000000000',
  ),
  vault: readAddress(
    'RUNWAY_VAULT_ADDRESS',
    '0x0f1a59fcab0638a1f3525d5acaedc5cbef4d95b7',
  ),
  factory: readAddress(
    'RUNWAY_FACTORY_ADDRESS',
    '0x0ed2b25c82f8a701f81c5182c0a5f3faf6e53c76',
  ),
  /** Agent revenue router. Every x402 receipt is forwarded here. */
  splitter: readAddress(
    'RUNWAY_SPLITTER_ADDRESS',
    '0x8C24a83a1103460a0845bE553fe070040f8c31D1',
  ),

  /**
   * Role holders, for read-only simulation only. These are addresses, never
   * keys: `simulateContract` needs a `from` to evaluate `msg.sender` but does
   * not sign anything, so no private key is required or wanted here.
   *
   * A negative test must simulate from the role holder the contract checks, or
   * it reverts at the access-control gate and never reaches the behaviour under
   * test. Simulating from an unprivileged signer would report "unauthorized" and
   * look like a pass while proving nothing.
   */
  roles: {
    admin: readAddress(
      'RUNWAY_ADMIN_ADDRESS',
      '0xe81e8078f2D284C92D6d97B5d4769af81e0cA11C',
    ),
    underwriter: readAddress(
      'RUNWAY_UNDERWRITER_ADDRESS',
      '0xa03D9bA207EE0D6F161bcd8E7F6B1d618F670813',
    ),
    watcher: readAddress(
      'RUNWAY_WATCHER_ADDRESS',
      '0x73Ff6742FF497cb9f282607ca5C827626F426a19',
    ),
    agent: readAddress(
      'RUNWAY_AGENT_ADDRESS',
      '0xa0aE5469b0f97BccFDD605E7862dEbfe37f03257',
    ),
  } as const,

  /**
   * Testnet-only operational key. It signs EIP-3009 authorizations for the demo
   * buyer and submits keeper settlements. It holds no mainnet value and MUST be
   * replaced with a low-value, dedicated testnet key before any public demo.
   */
  settlerKey: read('RUNWAY_PRIVATE_KEY'),
  /** Guards /api/keeper and /api/demo/buy from being triggered by anyone. */
  keeperSecret: read('RUNWAY_KEEPER_SECRET'),
  /** Vercel Cron sends this automatically. */
  cronSecret: read('CRON_SECRET'),

  /** Minimum unsettled revenue (USDC base units) the keeper will route. */
  settleThreshold: BigInt(read('RUNWAY_SETTLE_THRESHOLD', '100000')),
  /** Default price of the demo resource served by /api/x402/resource. */
  defaultPrice: BigInt(read('RUNWAY_DEMO_PRICE', '100000')),

  decimals: 6,
} as const;

export const explorerAddress = (address: string): string =>
  `${config.explorer}/address/${address}`;

export const explorerTx = (hash: string): string =>
  `${config.explorer}/tx/${hash}`;

export function formatUsdc(value: bigint, dp = 6): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(dp);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(dp, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export function isAuthorized(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const expected = config.keeperSecret || config.cronSecret;
  if (!expected) return process.env.NODE_ENV !== 'production';
  const auth = req.headers.authorization;
  const bearer = Array.isArray(auth) ? auth[0] : auth;
  const provided = [
    req.headers['x-keeper-secret'],
    bearer?.startsWith('Bearer ') ? bearer.slice(7) : undefined,
  ];
  return provided.some(
    (value) => typeof value === 'string' && value.length > 0 && value === expected,
  );
}
